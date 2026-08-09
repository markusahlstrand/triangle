import { useMemo, useState } from 'react';
import {
  invoke,
  ApiError,
  type Constraint,
  type Feature,
  type MirrorChoice,
  type Point,
  type SitePayload,
  type SolveReport,
  type Species,
} from './api';
import { pointResidualCm } from './Map';

// ============================================================================
// The sheets: add measurement (the hot path — design 09/10/11), point detail
// (08), new point (03), constraints (21), feature editor (16/17), plant
// placement (18/19). Each mutates through ONE operation and hands the refreshed
// site back up.
// ============================================================================

export function Sheet(props: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={props.onClose}>
      <div className="sheet" onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head">
          <div className="t">{props.title}</div>
          <button className="x" onClick={props.onClose}>
            ✕
          </button>
        </div>
        <div className="sheet-body">{props.children}</div>
      </div>
    </div>
  );
}

export function useAction(onDone: () => Promise<void> | void) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await onDone();
      return true;
    } catch (e) {
      setError(e instanceof ApiError && e.denied ? `Not allowed: ${e.message}` : String((e as Error).message ?? e));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { error, busy, run, setError };
}

function elevLabel(p: Point): string {
  return p.elevation_m === null ? '—' : `${p.elevation_m >= 0 ? '+' : ''}${p.elevation_m.toFixed(2)}`;
}

/** Recently used points first — in the field you measure from one anchor several times running. */
function recentFirst(site: SitePayload): Point[] {
  const lastUsed = new Map<string, string>();
  for (const m of site.measurements) {
    lastUsed.set(m.point_a, m.created_at);
    lastUsed.set(m.point_b, m.created_at);
  }
  return [...site.points].sort((a, b) => {
    const la = lastUsed.get(a.id) ?? '';
    const lb = lastUsed.get(b.id) ?? '';
    return la === lb ? b.seq - a.seq : lb.localeCompare(la);
  });
}

function PointPicker(props: {
  site: SitePayload;
  exclude?: string[];
  selected: string | null;
  onPick: (id: string) => void;
}) {
  const points = recentFirst(props.site).filter((p) => !(props.exclude ?? []).includes(p.id));
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
      {points.map((p) => (
        <button
          key={p.id}
          className={`pill${props.selected === p.id ? ' selected' : ''}`}
          onClick={() => props.onPick(p.id)}
        >
          {p.name}
          <span className="elev">{elevLabel(p)}</span>
        </button>
      ))}
    </div>
  );
}

// ── Add measurement — the hot path ───────────────────────────────────────────

export function AddMeasurementSheet(props: {
  site: SitePayload;
  initialA?: string;
  onClose: () => void;
  onSaved: (solve: SolveReport) => Promise<void>;
}) {
  const [a, setA] = useState<string | null>(props.initialA ?? null);
  const [b, setB] = useState<string | null>(null);
  const [cm, setCm] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const action = useAction(() => {});
  const byId = useMemo(() => new Map(props.site.points.map((p) => [p.id, p])), [props.site]);

  const key = (k: string) => {
    setResult(null);
    if (k === '⌫') setCm((v) => v.slice(0, -1));
    else if (cm.length < 6) setCm((v) => (k === '.' && v.includes('.') ? v : v + k));
  };

  const save = async (next: boolean) => {
    if (!a || !b || !cm) return;
    const ok = await action.run(async () => {
      const r = await invoke<{ solve: SolveReport }>('garden/add-measurement', {
        siteId: props.site.site.id,
        pointA: a,
        pointB: b,
        distanceCm: Number(cm),
      });
      await props.onSaved(r.solve);
      const placedB = r.solve.placed.includes(b);
      const pending = r.solve.needsSide.find((n) => n.id === b || n.id === a);
      const res = r.solve.measurementResidualsCm;
      const worst = Object.values(res).length ? Math.max(...Object.values(res)) : 0;
      setResult(
        pending
          ? `${byId.get(pending.id)?.name} has two possible positions — pick a side on the map.`
          : placedB
            ? `${byId.get(b)?.name} is on the map. Residual ${worst.toFixed(1)} cm.`
            : 'Saved. One more distance places it.',
      );
    });
    if (ok) {
      setCm('');
      if (next) setB(null);
      else props.onClose();
    }
  };

  const meters = cm ? (Number(cm) / 100).toFixed(2) : null;
  const overTape = cm !== '' && Number(cm) > 2000;

  return (
    <Sheet title="New measurement" onClose={props.onClose}>
      {result && <div className="ok-bar">{result}</div>}
      {action.error && <div className="error-bar">{action.error}</div>}
      <div className="field">
        <div className="section-label">From {a ? `· ${byId.get(a)?.name}` : '· pick a point'}</div>
        {!a && <PointPicker site={props.site} selected={a} onPick={setA} />}
        {a && (
          <button className="hint" style={{ textAlign: 'left' }} onClick={() => setA(null)}>
            change
          </button>
        )}
      </div>
      {a && (
        <div className="field">
          <div className="section-label">To {b ? `· ${byId.get(b)?.name}` : '· pick a point'}</div>
          {!b && <PointPicker site={props.site} exclude={[a]} selected={b} onPick={setB} />}
          {b && (
            <button className="hint" style={{ textAlign: 'left' }} onClick={() => setB(null)}>
              change
            </button>
          )}
        </div>
      )}
      {a && b && (
        <>
          <div className="distance-display">
            {cm || '0'}
            <span className="unit">cm</span>
          </div>
          {meters && (
            <div className="hint">
              {meters} m {overTape ? '· beyond the 20 m tape' : '· within tape'}
            </div>
          )}
          <div className="keypad">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫'].map((k) => (
              <button key={k} onClick={() => key(k)}>
                {k}
              </button>
            ))}
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn secondary" disabled={!cm || action.busy} onClick={() => save(true)}>
              Save &amp; next
            </button>
            <button className="btn" disabled={!cm || action.busy} onClick={() => save(false)}>
              Save
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

// ── New point ────────────────────────────────────────────────────────────────

export function AddPointSheet(props: {
  site: SitePayload;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [name, setName] = useState('');
  const [elev, setElev] = useState('');
  const action = useAction(props.onSaved);
  const first = props.site.points.length === 0;
  const second = props.site.points.length === 1;

  return (
    <Sheet title={first ? 'First point — the origin' : second ? 'Second point — the baseline' : 'New point'} onClose={props.onClose}>
      {action.error && <div className="error-bar">{action.error}</div>}
      {(first || second) && (
        <div className="callout">
          <div className="tri" />
          <div>
            {first
              ? 'Stand at a corner you will always be able to find. This becomes the origin of the map.'
              : 'The line from the origin to this point sets the orientation of the whole map — pick a long, straight, permanent edge, then tape the distance between the two.'}
          </div>
        </div>
      )}
      <div className="field">
        <div className="section-label">Point name</div>
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="house SW corner" autoFocus />
      </div>
      <div className="field">
        <div className="section-label">Elevation (m, vs datum — optional)</div>
        <input value={elev} onChange={(e) => setElev(e.target.value)} placeholder="+0.00" inputMode="decimal" />
      </div>
      <button
        className="btn"
        disabled={!name.trim() || action.busy}
        onClick={() =>
          void action.run(async () => {
            await invoke('garden/create-point', {
              siteId: props.site.site.id,
              name: name.trim(),
              ...(elev.trim() !== '' && !Number.isNaN(Number(elev)) ? { elevationM: Number(elev) } : {}),
            });
            props.onClose();
          })
        }
      >
        Add point
      </button>
    </Sheet>
  );
}

// ── Point detail (design 08) ─────────────────────────────────────────────────

export function PointDetailSheet(props: {
  site: SitePayload;
  pointId: string;
  readOnly: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onAddMeasurementFrom: (id: string) => void;
}) {
  const p = props.site.points.find((x) => x.id === props.pointId);
  const action = useAction(props.onChanged);
  const [elev, setElev] = useState(p?.elevation_m?.toString() ?? '');
  if (!p) return null;
  const byId = new Map(props.site.points.map((x) => [x.id, x]));
  const measurements = props.site.measurements.filter(
    (m) => m.point_a === p.id || m.point_b === p.id,
  );
  const residual = pointResidualCm(props.site, p.id);

  return (
    <Sheet title={p.name} onClose={props.onClose}>
      {action.error && <div className="error-bar">{action.error}</div>}
      <div className="meta">
        {p.status} · {measurements.length} distances
        {residual !== undefined ? ` · worst residual ${residual.toFixed(1)} cm` : ''}
        {p.locked === 1 ? ' · locked' : ''}
        {p.x !== null ? ` · (${p.x.toFixed(2)}, ${p.y!.toFixed(2)})` : ''}
      </div>
      <div>
        <div className="section-label" style={{ marginBottom: 6 }}>
          Measurements
        </div>
        {measurements.map((m) => {
          const other = byId.get(m.point_a === p.id ? m.point_b : m.point_a);
          const r = props.site.solve.measurementResidualsCm[m.id];
          return (
            <div className="row" key={m.id}>
              <span className={`residual ${r === undefined ? 'none' : r <= 2 ? 'good' : r <= 5 ? 'warn' : 'bad'}`} />
              <span>→ {other?.name}</span>
              <span className="right">
                {Math.round(m.distance_m * 100)} cm{r !== undefined ? ` · ${r.toFixed(1)}` : ''}
                {!props.readOnly && (
                  <button
                    style={{ marginLeft: 10, color: 'var(--bad)' }}
                    onClick={() => void action.run(() => invoke('garden/delete-measurement', { measurementId: m.id }))}
                  >
                    ✕
                  </button>
                )}
              </span>
            </div>
          );
        })}
        {measurements.length === 0 && <div className="hint">No tape pulls yet.</div>}
      </div>
      {!props.readOnly && (
        <>
          <button className="btn secondary" onClick={() => props.onAddMeasurementFrom(p.id)}>
            + Measurement from here
          </button>
          <div className="field">
            <div className="section-label">Elevation (m)</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input value={elev} onChange={(e) => setElev(e.target.value)} inputMode="decimal" placeholder="—" />
              <button
                className="btn secondary"
                style={{ flex: 'none', width: 90 }}
                disabled={action.busy || (elev.trim() !== '' && Number.isNaN(Number(elev)))}
                onClick={() =>
                  void action.run(() =>
                    invoke('garden/update-point', {
                      pointId: p.id,
                      elevationM: elev.trim() === '' ? null : Number(elev),
                    }),
                  )
                }
              >
                Set
              </button>
            </div>
          </div>
          <button
            className="btn secondary"
            disabled={action.busy}
            onClick={() => void action.run(() => invoke('garden/update-point', { pointId: p.id, locked: p.locked !== 1 }))}
          >
            {p.locked === 1 ? 'Unlock position' : 'Lock position'}
          </button>
          <button
            className="btn danger"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await invoke('garden/delete-point', { pointId: p.id });
                props.onClose();
              })
            }
          >
            Delete point
          </button>
        </>
      )}
    </Sheet>
  );
}

// ── Constraints (design 21) ──────────────────────────────────────────────────

const CONSTRAINT_KINDS = [
  { kind: 'right-angle', label: '∟ Right angle', n: 3, hint: 'Tap the corner point, then its two neighbours.' },
  { kind: 'parallel', label: '≫ Parallel', n: 4, hint: 'Tap the two ends of the first segment, then the two ends of the second.' },
  { kind: 'equal-length', label: '= Equal length', n: 4, hint: 'Tap the two ends of each segment.' },
  { kind: 'colinear', label: '— Colinear', n: -1, hint: 'Tap three or more points that share one wall face.' },
] as const;

export function ConstraintSheet(props: {
  site: SitePayload;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [kind, setKind] = useState<(typeof CONSTRAINT_KINDS)[number] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [preview, setPreview] = useState<SolveReport | null>(null);
  const action = useAction(props.onSaved);
  const byId = new Map(props.site.points.map((x) => [x.id, x]));
  const enough = kind !== null && (kind.n === -1 ? picked.length >= 3 : picked.length === kind.n);

  const doPreview = () =>
    void action.run(async () => {
      const r = await invoke<SolveReport>('garden/preview-constraint', {
        siteId: props.site.site.id,
        kind: kind!.kind,
        pointIds: picked,
      });
      setPreview(r);
    });

  return (
    <Sheet title="New constraint" onClose={props.onClose}>
      {action.error && <div className="error-bar">{action.error}</div>}
      {!kind && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {CONSTRAINT_KINDS.map((k) => (
            <button key={k.kind} className="pill" onClick={() => setKind(k)}>
              {k.label}
            </button>
          ))}
          <div className="hint">
            A constraint is another equation the solver gets for free — an assumption, not a
            measurement, so it carries its own residual. If the tape disagrees, the constraint goes
            amber; the app never quietly bends real numbers to fit one.
          </div>
        </div>
      )}
      {kind && !preview && (
        <>
          <div className="hint">{kind.hint}</div>
          <div className="meta">{picked.map((id) => byId.get(id)?.name).join(' · ') || '—'}</div>
          <PointPicker
            site={props.site}
            exclude={picked}
            selected={null}
            onPick={(id) => setPicked((v) => [...v, id])}
          />
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn secondary" onClick={() => setPicked([])}>
              Clear
            </button>
            <button className="btn" disabled={!enough || action.busy} onClick={doPreview}>
              Preview
            </button>
          </div>
        </>
      )}
      {kind && preview && (
        <>
          <div className="callout">
            <div className="tri" />
            <div>
              {preview.moved.length === 0
                ? 'Applying this moves nothing — the survey already agrees with it.'
                : `Applying this moves ${preview.moved
                    .map((m) => `${byId.get(m.pointId)?.name} by ${m.deltaCm.toFixed(1)} cm`)
                    .join(', ')}.`}{' '}
              The preview tells you whether you are correcting the survey or lying to it.
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <button className="btn secondary" onClick={() => setPreview(null)}>
              Back
            </button>
            <button
              className="btn"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await invoke('garden/add-constraint', {
                    siteId: props.site.site.id,
                    kind: kind.kind,
                    pointIds: picked,
                  });
                  props.onClose();
                })
              }
            >
              Apply constraint
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

// ── Feature editor (design 16/17, list-based tracing) ────────────────────────

const FEATURE_TYPES = [
  'retention-wall',
  'pool',
  'terrace',
  'stairs',
  'house',
  'fence',
  'bed',
  'path',
] as const;

export function FeatureSheet(props: {
  site: SitePayload;
  existing: Feature | null;
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const f = props.existing;
  const [type, setType] = useState<string>(f?.type ?? 'retention-wall');
  const [name, setName] = useState(f?.name ?? '');
  const [closed, setClosed] = useState(f ? f.closed === 1 : false);
  const [vertices, setVertices] = useState<{ pointId: string; curvedToNext: boolean }[]>(
    f?.vertices.map((v) => ({ pointId: v.point_id, curvedToNext: v.curved_to_next === 1 })) ?? [],
  );
  const action = useAction(props.onSaved);
  const byId = new Map(props.site.points.map((x) => [x.id, x]));

  return (
    <Sheet title={f ? f.name : 'New feature'} onClose={props.onClose}>
      {action.error && <div className="error-bar">{action.error}</div>}
      {!props.readOnly && (
        <>
          <div className="field">
            <div className="section-label">Type</div>
            <select value={type} onChange={(e) => setType(e.target.value)} disabled={f !== null}>
              {FEATURE_TYPES.map((t) => (
                <option key={t} value={t}>
                  {t}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <div className="section-label">Name</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="lower retention wall" />
          </div>
          <button className="pill" onClick={() => setClosed(!closed)}>
            {closed ? '▣ Closed loop' : '▢ Open run'}
          </button>
        </>
      )}
      <div>
        <div className="section-label" style={{ marginBottom: 6 }}>
          Point run · in order
        </div>
        {vertices.map((v, i) => (
          <div className="row" key={i}>
            <span>
              {i + 1}. {byId.get(v.pointId)?.name}
            </span>
            {!props.readOnly && i < vertices.length - (closed ? 0 : 1) && (
              <button
                className="right"
                style={{ color: 'var(--accent)' }}
                onClick={() =>
                  setVertices((vs) => vs.map((x, j) => (j === i ? { ...x, curvedToNext: !x.curvedToNext } : x)))
                }
              >
                {v.curvedToNext ? '⌒ curved' : '— straight'}
              </button>
            )}
            {!props.readOnly && (
              <button style={{ color: 'var(--bad)' }} onClick={() => setVertices((vs) => vs.filter((_, j) => j !== i))}>
                ✕
              </button>
            )}
          </div>
        ))}
      </div>
      {!props.readOnly && (
        <>
          <div className="field">
            <div className="section-label">Add point to run</div>
            <PointPicker
              site={props.site}
              exclude={vertices.map((v) => v.pointId)}
              selected={null}
              onPick={(id) => setVertices((vs) => [...vs, { pointId: id, curvedToNext: false }])}
            />
          </div>
          <button
            className="btn"
            disabled={vertices.length < 2 || !name.trim() || action.busy}
            onClick={() =>
              void action.run(async () => {
                if (f) {
                  await invoke('garden/update-feature', { featureId: f.id, name: name.trim(), closed, vertices });
                } else {
                  await invoke('garden/create-feature', {
                    siteId: props.site.site.id,
                    type,
                    name: name.trim(),
                    closed,
                    vertices,
                  });
                }
                props.onClose();
              })
            }
          >
            {f ? 'Save feature' : 'Add feature'}
          </button>
          {f && (
            <button
              className="btn danger"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await invoke('garden/delete-feature', { featureId: f.id });
                  props.onClose();
                })
              }
            >
              Delete feature
            </button>
          )}
        </>
      )}
    </Sheet>
  );
}

// ── Plants (design 18/19) ────────────────────────────────────────────────────

export function PlantSheet(props: {
  site: SitePayload;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [species, setSpecies] = useState<Species[] | null>(null);
  const [picked, setPicked] = useState<Species | null>(null);
  const [pointId, setPointId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const action = useAction(props.onSaved);

  if (species === null) {
    void invoke<Species[]>('garden/list-species').then(setSpecies);
  }

  return (
    <Sheet title={picked ? `Place ${picked.common_name}` : 'Plant library'} onClose={props.onClose}>
      {action.error && <div className="error-bar">{action.error}</div>}
      {!picked &&
        (species ?? []).map((s) => (
          <button key={s.id} className="pill" onClick={() => setPicked(s)}>
            <span>
              {s.common_name}
              <div className="hint" style={{ fontStyle: 'italic' }}>{s.latin_name}</div>
            </span>
            <span className="elev">
              {s.category} · ⌀{s.mature_canopy_m ?? '?'} m
            </span>
          </button>
        ))}
      {picked && (
        <>
          <div className="hint">
            Mature: ⌀{picked.mature_canopy_m ?? '?'} m canopy, {picked.mature_height_m ?? '?'} m tall
            {picked.years_to_mature ? ` in ~${picked.years_to_mature} years` : ''}. The map draws the
            mature canopy so spacing mistakes show now, not in ten years.
          </div>
          <div className="field">
            <div className="section-label">Label (optional)</div>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={picked.common_name} />
          </div>
          <div className="field">
            <div className="section-label">At point</div>
            <PointPicker site={props.site} selected={pointId} onPick={setPointId} />
          </div>
          <button
            className="btn"
            disabled={!pointId || action.busy}
            onClick={() =>
              void action.run(async () => {
                await invoke('garden/add-plant', {
                  siteId: props.site.site.id,
                  pointId,
                  speciesId: picked.id,
                  ...(label.trim() ? { label: label.trim() } : {}),
                });
                props.onClose();
              })
            }
          >
            Plant it
          </button>
        </>
      )}
    </Sheet>
  );
}

// ── Mirror choice fallback sheet (design 07 companion for the tray) ──────────

export function MirrorSheet(props: {
  site: SitePayload;
  choice: MirrorChoice;
  onClose: () => void;
  onPick: (side: 1 | -1) => void;
}) {
  const byId = new Map(props.site.points.map((x) => [x.id, x]));
  const p = byId.get(props.choice.id);
  const [a, b] = props.choice.anchors.map((id) => byId.get(id));
  return (
    <Sheet title="Which side is it on?" onClose={props.onClose}>
      <div className="hint">
        {p?.name} has two distances, so it fits in two places — mirrored across the line from{' '}
        {a?.name} to {b?.name}. Look up — which one are you standing at? A third measurement later
        resolves it automatically.
      </div>
      {props.choice.candidates.map((c, i) => {
        const A = byId.get(props.choice.anchors[0])!;
        const B = byId.get(props.choice.anchors[1])!;
        const cr = (B.x! - A.x!) * (c.y - A.y!) - (B.y! - A.y!) * (c.x - A.x!);
        const side: 1 | -1 = cr >= 0 ? 1 : -1;
        return (
          <button key={i} className="pill" onClick={() => props.onPick(side)}>
            {i === 0 ? '● solid marker' : '◌ dashed marker'} — ({c.x.toFixed(2)}, {c.y.toFixed(2)})
          </button>
        );
      })}
      <button className="btn secondary" onClick={props.onClose}>
        Ask again later
      </button>
    </Sheet>
  );
}

// ── Constraints list row helper ──────────────────────────────────────────────

export function constraintLabel(c: Constraint, site: SitePayload): string {
  const byId = new Map(site.points.map((x) => [x.id, x]));
  const names = c.points.map((id) => byId.get(id)?.name ?? '?');
  if (c.kind === 'right-angle') return `90° at ${names[0]}`;
  if (c.kind === 'parallel') return `${names[0]}→${names[1]} ∥ ${names[2]}→${names[3]}`;
  if (c.kind === 'equal-length') return `|${names[0]}→${names[1]}| = |${names[2]}→${names[3]}|`;
  return `${names.join(' — ')} colinear`;
}
