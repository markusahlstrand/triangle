import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Column } from '@substrat-run/elements/entity-table';
import type { TableSource } from '@substrat-run/elements/entity-table-model';
import type WaInput from '@awesome.me/webawesome/dist/components/input/input.js';
import {
  api,
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

/**
 * A sheet is a Web Awesome dialog dressed as the handover's bottom sheet (styles.css):
 * focus is trapped inside it, Escape and the backdrop close it, and the header's close
 * button is the dialog's own. It is mounted open; closing it — by any of those — reports
 * through `onClose`, and the caller unmounts it.
 */
export function Sheet(props: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <wa-dialog
      class="sheet"
      label={props.title}
      open
      light-dismiss
      // Only the dialog's own hide: a select or dropdown inside it fires the same event.
      onwa-after-hide={(e: Event) => {
        if (e.target === e.currentTarget) props.onClose();
      }}
    >
      <div className="sheet-body">{props.children}</div>
    </wa-dialog>
  );
}

/** A failure, said where the action was. */
export function ErrorNote(props: { children: ReactNode }) {
  return (
    <wa-callout variant="danger" size="small">
      {props.children}
    </wa-callout>
  );
}

/** What just happened, when it went well. */
export function OkNote(props: { children: ReactNode }) {
  return (
    <wa-callout variant="success" size="small">
      {props.children}
    </wa-callout>
  );
}

/** The handover's guidance callout, with the Triangle mark as its icon. */
export function Guide(props: { children: ReactNode }) {
  return (
    <wa-callout variant="brand" size="small">
      <div slot="icon" className="tri" />
      {props.children}
    </wa-callout>
  );
}

/** A small "remove this" control for a row. */
export function RemoveButton(props: { what: string; onClick: () => void; disabled?: boolean }) {
  return (
    <wa-button size="small" appearance="plain" variant="danger" disabled={props.disabled} onClick={props.onClick}>
      ✕<span className="wa-visually-hidden"> Remove {props.what}</span>
    </wa-button>
  );
}

/** The value a text control holds — React hands us its host element. */
export const valueOf = (e: Event): string => (e.target as HTMLInputElement).value;

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
      setError(e instanceof ApiError && e.status === 403 ? `Not allowed: ${e.message}` : String((e as Error).message ?? e));
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
  const [query, setQuery] = useState('');
  const search = useRef<WaInput | null>(null);
  // A keyboard is there to type with; on a phone, focusing would cover the list. After the
  // dialog's own initial focus, which lands on its close button.
  useEffect(() => {
    if (!matchMedia('(pointer: fine)').matches) return;
    const t = setTimeout(() => search.current?.focus(), 120);
    return () => clearTimeout(t);
  }, []);
  const q = fold(query.trim());
  const points = recentFirst(props.site)
    .filter((p) => !(props.exclude ?? []).includes(p.id))
    .filter((p) => !q || fold(p.name).includes(q));
  return (
    <div className="point-picker">
      {props.site.points.length > 6 && (
        <wa-input
          ref={(el: WaInput) => { search.current = el; }}
          type="search"
          size="small"
          placeholder="Search points"
          with-clear
          value={query}
          onInput={(e) => setQuery(valueOf(e))}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && points[0]) props.onPick(points[0].id);
          }}
        />
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 260, overflowY: 'auto' }}>
        {points.length === 0 && <div className="hint">No point matches “{query.trim()}”.</div>}
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
    </div>
  );
}

/** Case- and accent-insensitive form for matching ("Olivo", "olivo", "OLÍVO" all meet). */
const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

// ── Add measurement — the hot path ───────────────────────────────────────────

export function AddMeasurementSheet(props: {
  site: SitePayload;
  initialA?: string;
  initialB?: string;
  onClose: () => void;
  onSaved: (solve: SolveReport) => Promise<void>;
  /** Hand the picking of one end to the map; the sheet reopens with what is chosen so far. */
  onPickOnMap?: (which: 'a' | 'b', a: string | null, b: string | null) => void;
}) {
  const [a, setA] = useState<string | null>(props.initialA ?? null);
  const [b, setB] = useState<string | null>(props.initialB ?? null);
  const [cm, setCm] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const action = useAction(() => {});
  const byId = useMemo(() => new Map(props.site.points.map((p) => [p.id, p])), [props.site]);

  const key = (k: string) => {
    setResult(null);
    setCm((v) => {
      if (k === '⌫') return v.slice(0, -1);
      if (v.length >= 6 || (k === '.' && v.includes('.'))) return v;
      return v + k;
    });
  };

  const save = async (next: boolean) => {
    if (!a || !b || !cm) return;
    const ok = await action.run(async () => {
      const r = await api.addMeasurement({
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

  // The physical keyboard drives the same keypad once both points are picked: digits,
  // `.`/`,`, Backspace, and Enter saves (Shift+Enter: save & next). Typing into a real
  // field elsewhere is left alone.
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => {
    if (!a || !b) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      // The real target inside any shadow root: a `wa-input` retargets to its host.
      const t = (e.composedPath()[0] ?? e.target) as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (/^[0-9]$/.test(e.key)) key(e.key);
      else if (e.key === '.' || e.key === ',') key('.');
      else if (e.key === 'Backspace') key('⌫');
      else if (e.key === 'Enter') void saveRef.current(e.shiftKey);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [a, b]);

  const meters = cm ? (Number(cm) / 100).toFixed(2) : null;
  const overTape = cm !== '' && Number(cm) > 2000;

  return (
    <Sheet title="New measurement" onClose={props.onClose}>
      {result && <OkNote>{result}</OkNote>}
      {action.error && <ErrorNote>{action.error}</ErrorNote>}
      <div className="field">
        <div className="section-label">From {a ? `· ${byId.get(a)?.name}` : '· pick a point'}</div>
        {!a && props.onPickOnMap && (
          <wa-button class="change" size="small" appearance="plain" onClick={() => props.onPickOnMap!('a', a, b)}>
            Pick on map
          </wa-button>
        )}
        {!a && <PointPicker site={props.site} exclude={b ? [b] : []} selected={a} onPick={setA} />}
        {a && (
          <wa-button class="change" size="small" appearance="plain" onClick={() => setA(null)}>
            change
          </wa-button>
        )}
      </div>
      {a && (
        <div className="field">
          <div className="section-label">To {b ? `· ${byId.get(b)?.name}` : '· pick a point'}</div>
          {!b && props.onPickOnMap && (
            <wa-button class="change" size="small" appearance="plain" onClick={() => props.onPickOnMap!('b', a, b)}>
              Pick on map
            </wa-button>
          )}
          {!b && <PointPicker site={props.site} exclude={[a]} selected={b} onPick={setB} />}
          {b && (
            <wa-button class="change" size="small" appearance="plain" onClick={() => setB(null)}>
              change
            </wa-button>
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
          <div className="actions">
            <wa-button size="large" appearance="outlined" disabled={!cm || action.busy} onClick={() => save(true)}>
              Save &amp; next
            </wa-button>
            <wa-button size="large" variant="brand" disabled={!cm || action.busy} loading={action.busy} onClick={() => save(false)}>
              Save
            </wa-button>
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
      {action.error && <ErrorNote>{action.error}</ErrorNote>}
      {(first || second) && (
        <Guide>
          {first
            ? 'Stand at a corner you will always be able to find. This becomes the origin of the map.'
            : 'The line from the origin to this point sets the orientation of the whole map — pick a long, straight, permanent edge, then tape the distance between the two.'}
        </Guide>
      )}
      <wa-input
        label="Point name"
        size="large"
        value={name}
        onInput={(e) => setName(valueOf(e))}
        placeholder="house SW corner"
        autofocus
      />
      <wa-input
        label="Elevation (m, vs datum — optional)"
        size="large"
        value={elev}
        onInput={(e) => setElev(valueOf(e))}
        placeholder="+0.00"
        inputmode="decimal"
      />
      <wa-button
        size="large"
        variant="brand"
        loading={action.busy}
        disabled={!name.trim() || action.busy}
        onClick={() =>
          void action.run(async () => {
            await api.createPoint({
              siteId: props.site.site.id,
              name: name.trim(),
              ...(elev.trim() !== '' && !Number.isNaN(Number(elev)) ? { elevationM: Number(elev) } : {}),
            });
            props.onClose();
          })
        }
      >
        Add point
      </wa-button>
    </Sheet>
  );
}

// ── Point detail (design 08) ─────────────────────────────────────────────────

// ── One tape pull — opened from its line on the map ─────────────────────────

export function MeasurementSheet(props: {
  site: SitePayload;
  measurementId: string;
  readOnly: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onOpenPoint: (id: string) => void;
}) {
  const action = useAction(props.onChanged);
  const m = props.site.measurements.find((x) => x.id === props.measurementId);
  if (!m) return null;
  const a = props.site.points.find((p) => p.id === m.point_a);
  const b = props.site.points.find((p) => p.id === m.point_b);
  const r = props.site.solve.measurementResidualsCm[m.id];
  const cls = r === undefined ? 'none' : r <= 2 ? 'good' : r <= 5 ? 'warn' : 'bad';
  const suspect = props.site.solve.suspects.find((s) => s.kind === 'measurement' && s.id === m.id);
  return (
    <Sheet title={`${a?.name ?? '?'} ↔ ${b?.name ?? '?'}`} onClose={props.onClose}>
      {action.error && <ErrorNote>{action.error}</ErrorNote>}
      <div className="distance-display">
        {Math.round(m.distance_m * 100)}
        <span className="unit">cm</span>
      </div>
      {suspect && (
        <wa-callout variant="warning" size="small">
          {suspectsAreTied(props.site.solve.suspects) ? 'This may be the wrong one: ' : 'Probably wrong: '}
          the rest of the survey says {Math.round(suspect.expectedCm ?? 0)} cm ({suspect.offByCm.toFixed(0)} cm off).
        </wa-callout>
      )}
      <div className="meta">
        <span className={`residual ${cls}`} />{' '}
        {r === undefined ? 'no residual yet — the network has no redundancy here' : `residual ${r.toFixed(1)} cm`}
      </div>
      <div className="actions">
        {a && (
          <wa-button appearance="outlined" onClick={() => props.onOpenPoint(a.id)}>
            {a.name}
          </wa-button>
        )}
        {b && (
          <wa-button appearance="outlined" onClick={() => props.onOpenPoint(b.id)}>
            {b.name}
          </wa-button>
        )}
      </div>
      {!props.readOnly && (
        <wa-button
          variant="danger"
          appearance="outlined"
          disabled={action.busy}
          onClick={async () => {
            if (await action.run(() => api.deleteMeasurement({ measurementId: m.id }))) props.onClose();
          }}
        >
          Delete measurement
        </wa-button>
      )}
    </Sheet>
  );
}

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
      {action.error && <ErrorNote>{action.error}</ErrorNote>}
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
                  <RemoveButton
                    what={`tape pull to ${other?.name ?? 'point'}`}
                    disabled={action.busy}
                    onClick={() => void action.run(() => api.deleteMeasurement({ measurementId: m.id }))}
                  />
                )}
              </span>
            </div>
          );
        })}
        {measurements.length === 0 && <div className="hint">No tape pulls yet.</div>}
      </div>
      {!props.readOnly && (
        <>
          <wa-button size="large" appearance="outlined" onClick={() => props.onAddMeasurementFrom(p.id)}>
            + Measurement from here
          </wa-button>
          <div className="inline-field">
            <wa-input
              label="Elevation (m)"
              size="large"
              value={elev}
              onInput={(e) => setElev(valueOf(e))}
              inputmode="decimal"
              placeholder="—"
            />
            <wa-button
              size="large"
              appearance="outlined"
              disabled={action.busy || (elev.trim() !== '' && Number.isNaN(Number(elev)))}
                onClick={() =>
                  void action.run(() =>
                    api.updatePoint({
                      pointId: p.id,
                      elevationM: elev.trim() === '' ? null : Number(elev),
                    }),
                  )
                }
            >
              Set
            </wa-button>
          </div>
          <wa-switch
            checked={p.locked === 1}
            disabled={action.busy}
            hint="A locked point keeps its position when the survey re-solves."
            onChange={() => void action.run(() => api.updatePoint({ pointId: p.id, locked: p.locked !== 1 }))}
          >
            Lock position
          </wa-switch>
          <wa-button
            size="large"
            variant="danger"
            appearance="outlined"
            disabled={action.busy}
            onClick={() =>
              void action.run(async () => {
                await api.deletePoint({ pointId: p.id });
                props.onClose();
              })
            }
          >
            Delete point
          </wa-button>
        </>
      )}
      <History entityType="point" entityId={p.id} />
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
      const r = await api.previewConstraint({
        siteId: props.site.site.id,
        kind: kind!.kind,
        pointIds: picked,
      });
      setPreview(r);
    });

  return (
    <Sheet title="New constraint" onClose={props.onClose}>
      {action.error && <ErrorNote>{action.error}</ErrorNote>}
      {!kind && (
        <div className="stack">
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
          <div className="actions">
            <wa-button size="large" appearance="outlined" onClick={() => setPicked([])}>
              Clear
            </wa-button>
            <wa-button size="large" variant="brand" disabled={!enough || action.busy} loading={action.busy} onClick={doPreview}>
              Preview
            </wa-button>
          </div>
        </>
      )}
      {kind && preview && (
        <>
          <Guide>
            {preview.moved.length === 0
              ? 'Applying this moves nothing — the survey already agrees with it.'
              : `Applying this moves ${preview.moved
                  .map((m) => `${byId.get(m.pointId)?.name} by ${m.deltaCm.toFixed(1)} cm`)
                  .join(', ')}.`}{' '}
            The preview tells you whether you are correcting the survey or lying to it.
          </Guide>
          <div className="actions">
            <wa-button size="large" appearance="outlined" onClick={() => setPreview(null)}>
              Back
            </wa-button>
            <wa-button
              size="large"
              variant="brand"
              loading={action.busy}
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api.addConstraint({
                    siteId: props.site.site.id,
                    kind: kind.kind,
                    pointIds: picked,
                  });
                  props.onClose();
                })
              }
            >
              Apply constraint
            </wa-button>
          </div>
        </>
      )}
    </Sheet>
  );
}

// ── Feature editor (design 16/17, list-based tracing) ────────────────────────

/** Every feature type with the words the picker shows; the order is the picker's. */
const FEATURE_TYPES: { type: Feature['type']; label: string; group: 'Built' | 'Furniture' }[] = [
  { type: 'retention-wall', label: 'Retention wall', group: 'Built' },
  { type: 'pool', label: 'Pool', group: 'Built' },
  { type: 'terrace', label: 'Terrace', group: 'Built' },
  { type: 'stairs', label: 'Stairs', group: 'Built' },
  { type: 'house', label: 'House', group: 'Built' },
  { type: 'fence', label: 'Fence', group: 'Built' },
  { type: 'bed', label: 'Bed', group: 'Built' },
  { type: 'path', label: 'Path', group: 'Built' },
  { type: 'table', label: 'Table', group: 'Furniture' },
  { type: 'chair', label: 'Chair', group: 'Furniture' },
  { type: 'bench', label: 'Bench', group: 'Furniture' },
  { type: 'lounger', label: 'Sun lounger', group: 'Furniture' },
  { type: 'parasol', label: 'Parasol', group: 'Furniture' },
];
/** An example name per type — what the empty name field suggests. */
const PLACEHOLDER: Partial<Record<Feature['type'], string>> = {
  'retention-wall': 'lower retention wall',
  pool: 'the pool',
  terrace: 'upper terrace',
  stairs: 'stairs to the pool',
  house: 'the house',
  fence: 'east fence',
  bed: 'vegetable bed',
  path: 'path to the gate',
  table: 'dining table',
  chair: 'reading chair',
  bench: 'bench by the olive',
  lounger: 'pool lounger',
  parasol: 'big parasol',
};
/** A table or a pool is an outline; a fence or a path is a line. */
const CLOSED_BY_DEFAULT = new Set<Feature['type']>(['pool', 'terrace', 'house', 'bed', 'table', 'chair', 'bench', 'lounger', 'parasol']);

export function FeatureSheet(props: {
  site: SitePayload;
  existing: Feature | null;
  readOnly: boolean;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const f = props.existing;
  const [type, setType] = useState<Feature['type']>(f?.type ?? 'retention-wall');
  const [name, setName] = useState(f?.name ?? '');
  const [closed, setClosed] = useState(f ? f.closed === 1 : false);
  const [vertices, setVertices] = useState<{ pointId: string; curvedToNext: boolean }[]>(
    f?.vertices.map((v) => ({ pointId: v.point_id, curvedToNext: v.curved_to_next === 1 })) ?? [],
  );
  const action = useAction(props.onSaved);
  const byId = new Map(props.site.points.map((x) => [x.id, x]));

  return (
    <Sheet title={f ? f.name : 'New feature'} onClose={props.onClose}>
      {action.error && <ErrorNote>{action.error}</ErrorNote>}
      {!props.readOnly && (
        <>
          <wa-select
            label="Type"
            size="large"
            value={type}
            onChange={(e) => {
              const t = valueOf(e) as Feature['type'];
              setType(t);
              if (!f) setClosed(CLOSED_BY_DEFAULT.has(t));
            }}
            disabled={f !== null}
          >
            {(['Built', 'Furniture'] as const).map((g) => [
              <small key={g}>{g}</small>,
              ...FEATURE_TYPES.filter((t) => t.group === g).map((t) => (
                <wa-option key={t.type} value={t.type}>
                  {t.label}
                </wa-option>
              )),
            ])}
          </wa-select>
          <wa-input
            label="Name"
            size="large"
            value={name}
            onInput={(e) => setName(valueOf(e))}
            placeholder={PLACEHOLDER[type] ?? 'name'}
          />
          <wa-switch
            checked={closed}
            hint="A closed run joins its last point back to its first."
            onChange={(e) => setClosed((e.target as HTMLInputElement).checked)}
          >
            Closed loop
          </wa-switch>
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
              <wa-button
                class="right"
                size="small"
                appearance="plain"
                variant="brand"
                onClick={() =>
                  setVertices((vs) => vs.map((x, j) => (j === i ? { ...x, curvedToNext: !x.curvedToNext } : x)))
                }
              >
                {v.curvedToNext ? '⌒ curved' : '— straight'}
              </wa-button>
            )}
            {!props.readOnly && (
              <RemoveButton
                what={byId.get(v.pointId)?.name ?? 'point'}
                onClick={() => setVertices((vs) => vs.filter((_, j) => j !== i))}
              />
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
          <wa-button
            size="large"
            variant="brand"
            loading={action.busy}
            disabled={vertices.length < 2 || !name.trim() || action.busy}
            onClick={() =>
              void action.run(async () => {
                if (f) {
                  await api.updateFeature({ featureId: f.id, name: name.trim(), closed, vertices });
                } else {
                  await api.createFeature({
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
          </wa-button>
          {f && (
            <wa-button
              size="large"
              variant="danger"
              appearance="outlined"
              disabled={action.busy}
              onClick={() =>
                void action.run(async () => {
                  await api.deleteFeature({ featureId: f.id });
                  props.onClose();
                })
              }
            >
              Delete feature
            </wa-button>
          )}
        </>
      )}
      {f && <History entityType="feature" entityId={f.id} />}
    </Sheet>
  );
}

// ── Plants (design 18/19) ────────────────────────────────────────────────────

export function PlantSheet(props: {
  site: SitePayload;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [picked, setPicked] = useState<Species | null>(null);
  const [pointId, setPointId] = useState<string | null>(null);
  const [label, setLabel] = useState('');
  const action = useAction(props.onSaved);

  return (
    <Sheet title={picked ? `Place ${picked.common_name}` : 'Plant library'} onClose={props.onClose}>
      {action.error && <ErrorNote>{action.error}</ErrorNote>}
      {!picked && <SpeciesTable onPick={setPicked} />}
      {picked && (
        <>
          <div className="hint">
            Mature: ⌀{picked.mature_canopy_m ?? '?'} m canopy, {picked.mature_height_m ?? '?'} m tall
            {picked.years_to_mature ? ` in ~${picked.years_to_mature} years` : ''}. The map draws the
            mature canopy so spacing mistakes show now, not in ten years.
          </div>
          <wa-input
            label="Label (optional)"
            size="large"
            value={label}
            onInput={(e) => setLabel(valueOf(e))}
            placeholder={picked.common_name}
          />
          <div className="field">
            <div className="section-label">At point</div>
            <PointPicker site={props.site} selected={pointId} onPick={setPointId} />
          </div>
          <div className="actions">
            <wa-button size="large" appearance="outlined" onClick={() => setPicked(null)}>
              Back
            </wa-button>
          <wa-button
            size="large"
            variant="brand"
            loading={action.busy}
            disabled={!pointId || action.busy}
            onClick={() =>
              void action.run(async () => {
                await api.addPlant({
                  siteId: props.site.site.id,
                  pointId: pointId!,
                  speciesId: picked.id,
                  ...(label.trim() ? { label: label.trim() } : {}),
                });
                props.onClose();
              })
            }
          >
            Plant it
          </wa-button>
          </div>
        </>
      )}
    </Sheet>
  );
}

// ── The species library: one paged read, as <sub-entity-table> ───────────────

const SPECIES_COLUMNS: Column<Species, 'common_name' | 'created_at'>[] = [
  { key: 'common_name', label: 'Species', sort: 'common_name' },
  { key: 'latin_name', label: 'Latin', priority: 3 },
  {
    key: 'category',
    label: 'Kind',
    kind: 'badge',
    tones: { tree: 'success', shrub: 'success', hedge: 'success', perennial: 'warning', climber: 'brand' },
    priority: 2,
  },
  {
    key: 'mature_canopy_m',
    label: '⌀ canopy',
    align: 'end',
    value: (s) => (s.mature_canopy_m === null ? '—' : `${s.mature_canopy_m} m`),
  },
];

/** The library's read, walked a page at a time and sorted on the server. */
const speciesSource: TableSource<Species, 'common_name' | 'created_at'> = {
  read: ({ sort, order, limit }) =>
    api.listSpecies({ ...(sort ? { sort } : {}), order, ...(limit ? { limit } : {}) }),
  follow: (next) => api.follow<Species>(next),
};

/** Pick a species: tap a row. Sorting and paging are the table's; the read is `garden/list-species`. */
function SpeciesTable(props: { onPick: (s: Species) => void }) {
  return (
    <sub-entity-table
      label="Species library"
      density="compact"
      paging="more"
      page-size="20"
      row-click
      empty="The library is empty."
      source={speciesSource}
      columns={SPECIES_COLUMNS}
      onsub-row-click={(e: CustomEvent<{ row: Species }>) => props.onPick(e.detail.row)}
    />
  );
}

// ── History: an entity's events off the audit spine (`garden/timeline`) ──────

type HistoryEntry = Awaited<ReturnType<typeof api.timeline>>['entries'][number];

const HISTORY_COLUMNS: Column<HistoryEntry>[] = [
  { key: 'occurredAt', label: 'When', kind: 'relative' },
  {
    key: 'type',
    label: 'What',
    value: (e) => e.type.replace(/^garden\./, '').replace(/-/g, ' '),
  },
  {
    key: 'actor',
    label: 'By',
    priority: 2,
    value: (e) => (typeof e.actor === 'string' ? e.actor.slice(-6) : 'system'),
    kind: 'code',
  },
];

/**
 * Why did the pool move 12 cm last Tuesday: the entity's own events, newest first. A
 * viewer may read it too (`garden:read`); a 403 shows as the table's wall, not an empty list.
 */
export function History(props: { entityType: 'point' | 'feature' | 'site'; entityId: string }) {
  const source = useMemo<TableSource<HistoryEntry>>(
    () => ({
      read: ({ limit }) =>
        api.timeline({
          entityType: props.entityType,
          entityId: props.entityId,
          order: 'desc',
          ...(limit ? { limit } : {}),
        }),
      follow: (next) => api.follow<HistoryEntry>(next),
    }),
    [props.entityType, props.entityId],
  );
  return (
    <details className="history">
      <summary className="section-label">History</summary>
      <sub-entity-table
        label="History"
        density="compact"
        paging="more"
        page-size="10"
        empty="Nothing recorded yet."
        source={source}
        columns={HISTORY_COLUMNS}
      />
    </details>
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
      <wa-button size="large" appearance="outlined" onClick={props.onClose}>
        Ask again later
      </wa-button>
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

// ── Suspects — which tape pull (or assumption) is probably wrong ─────────────

export type Suspect = SitePayload['solve']['suspects'][number];

/** Two suspects the survey explains almost equally well cannot be told apart. */
export function suspectsAreTied(s: readonly Suspect[]): boolean {
  return s.length > 1 && s[0]!.explains - s[1]!.explains < 0.05;
}

/** "house NW ↔ house SE: taped 1487 cm, the rest says 1437 cm" — or the constraint's own words. */
export function suspectLine(s: Suspect, site: SitePayload): string {
  const byId = new Map(site.points.map((p) => [p.id, p.name]));
  if (s.kind === 'measurement') {
    const m = site.measurements.find((x) => x.id === s.id);
    if (!m) return 'a measurement';
    const taped = Math.round(m.distance_m * 100);
    return `${byId.get(m.point_a)} ↔ ${byId.get(m.point_b)}: taped ${taped} cm, the rest says ${Math.round(s.expectedCm ?? 0)} cm`;
  }
  const c = site.constraints.find((x) => x.id === s.id);
  return c ? `${constraintLabel(c, site)} — the tape says it is off by ${s.offByCm.toFixed(0)} cm` : 'a constraint';
}

/**
 * The verdict, said plainly: one likely culprit, or — when the survey cannot tell — the
 * candidates and what would settle it. Each measurement opens its sheet.
 */
export function SuspectsNote(props: { site: SitePayload; onOpenMeasurement: (id: string) => void }) {
  const s = props.site.solve.suspects;
  if (s.length === 0) return null;
  const tied = suspectsAreTied(s);
  const shown = tied ? s.filter((x) => s[0]!.explains - x.explains < 0.05) : [s[0]!];
  return (
    <div className="suspects">
      <div className="section-label">{tied ? 'One of these is probably wrong' : 'Probably wrong'}</div>
      {shown.map((x) =>
        x.kind === 'measurement' ? (
          <button key={x.id} className="meta suspect" onClick={() => props.onOpenMeasurement(x.id)}>
            {suspectLine(x, props.site)}
          </button>
        ) : (
          <div key={x.id} className="meta suspect">
            {suspectLine(x, props.site)}
          </div>
        ),
      )}
      <div className="hint">
        {tied
          ? 'The survey has too few cross-checks here to tell which. Tape one more distance across this part of the garden.'
          : `Without it, every other distance agrees to ${s[0]!.worstWithoutCm.toFixed(1)} cm. Re-tape it, or delete it.`}
      </div>
    </div>
  );
}
