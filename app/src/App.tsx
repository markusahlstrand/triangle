import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  downloadDxf,
  fetchCast,
  invoke,
  principal,
  setPrincipal,
  type Cast,
  type MirrorChoice,
  type SitePayload,
  type SiteSummary,
} from './api';
import { GardenMap, pointResidualCm, type Overlays } from './Map';
import {
  AddMeasurementSheet,
  AddPointSheet,
  ConstraintSheet,
  FeatureSheet,
  MirrorSheet,
  PlantSheet,
  PointDetailSheet,
  Sheet,
  constraintLabel,
  useAction,
} from './Sheets';
import type { Feature } from './api';

// ============================================================================
// The shell: principal picker in the top bar (the dev cast — every entry is a
// real principal with real permission tuples), garden home, and the site view
// with its Map/List toggle. A viewer gets the same views with every editing
// affordance GONE, not disabled (design 23/24), plus the VIEWING badge.
// ============================================================================

type SheetState =
  | { kind: 'none' }
  | { kind: 'add-point' }
  | { kind: 'add-measurement'; from?: string }
  | { kind: 'point'; id: string }
  | { kind: 'mirror'; choice: MirrorChoice }
  | { kind: 'constraint' }
  | { kind: 'feature'; feature: Feature | null }
  | { kind: 'plant' };

export default function App() {
  const [cast, setCast] = useState<Cast>({});
  const [castLoaded, setCastLoaded] = useState(false);
  const [who, setWho] = useState(principal());
  const [sites, setSites] = useState<SiteSummary[] | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [site, setSite] = useState<SitePayload | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readOnly = cast[who]?.role.includes('viewer') ?? false;

  const loadSites = useCallback(async () => {
    setError(null);
    try {
      setSites(await invoke<SiteSummary[]>('garden/list-sites'));
    } catch (e) {
      setSites([]);
      setError(String((e as Error).message));
    }
  }, []);

  const loadSite = useCallback(async (id: string) => {
    try {
      setSite(await invoke<SitePayload>('garden/get-site', { siteId: id }));
    } catch (e) {
      setError(String((e as Error).message));
      setSite(null);
      setSiteId(null);
    }
  }, []);

  useEffect(() => {
    void fetchCast().then(setCast);
  }, []);
  useEffect(() => {
    setSiteId(null);
    setSite(null);
    void loadSites();
  }, [who, loadSites]);
  useEffect(() => {
    if (siteId) void loadSite(siteId);
  }, [siteId, loadSite]);

  const switchPrincipal = (p: string) => {
    setPrincipal(p);
    setWho(p);
  };

  return (
    <div className="app">
      <div className="topbar">
        <div className="logo" />
        <div className="title">Triangle</div>
        {readOnly && <span className="viewing-badge">VIEWING</span>}
        {Object.keys(cast).length > 0 && (
          <select value={who} onChange={(e) => switchPrincipal(e.target.value)}>
            {Object.entries(cast).map(([key, entry]) => (
              <option key={key} value={key}>
                {entry.name} · {entry.role}
              </option>
            ))}
          </select>
        )}
      </div>
      {castLoaded && Object.keys(cast).length === 0 && (
        <div className="error-bar">
          No sign-in is wired on this deployment yet — the dev principal picker exists only on the
          local dev server. Requests will be unauthorized until real auth replaces the dev seam.
        </div>
      )}
      {error && <div className="error-bar">{error}</div>}
      {!siteId && (
        <Home
          sites={sites}
          readOnly={readOnly}
          onOpen={setSiteId}
          onCreated={loadSites}
        />
      )}
      {siteId && site && (
        <SiteView
          site={site}
          readOnly={readOnly}
          onBack={() => {
            setSiteId(null);
            void loadSites();
          }}
          refresh={() => loadSite(siteId)}
        />
      )}
    </div>
  );
}

// ── Garden home (design 01/02) ───────────────────────────────────────────────

function Home(props: {
  sites: SiteSummary[] | null;
  readOnly: boolean;
  onOpen: (id: string) => void;
  onCreated: () => Promise<void>;
}) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [datum, setDatum] = useState('');
  const action = useAction(props.onCreated);

  return (
    <div className="screen">
      <div className="h1">Gardens</div>
      {props.sites?.map((s) => (
        <button key={s.id} className="card" style={{ textAlign: 'left' }} onClick={() => props.onOpen(s.id)}>
          <div className="body">
            <div className="name">{s.name}</div>
            <div className="meta">
              {s.points} points · {s.measurements} measurements · {s.features} features · {s.plants} plants
            </div>
            {s.datum_note && <div className="meta">datum: {s.datum_note}</div>}
          </div>
        </button>
      ))}
      {props.sites !== null && props.sites.length === 0 && (
        <div className="hint">No gardens here yet.</div>
      )}
      {!props.readOnly && !creating && (
        <button className="pill" onClick={() => setCreating(true)}>
          <span style={{ color: 'var(--accent)', fontSize: 18 }}>+</span> New garden
        </button>
      )}
      {creating && (
        <Sheet title="New garden" onClose={() => setCreating(false)}>
          {action.error && <div className="error-bar">{action.error}</div>}
          <div className="field">
            <div className="section-label">Garden name</div>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Casa Markus" autoFocus />
          </div>
          <div className="field">
            <div className="section-label">Elevation datum</div>
            <input value={datum} onChange={(e) => setDatum(e.target.value)} placeholder="Terrace floor = 0.00" />
            <div className="hint">
              Every elevation is measured against this. Pick something you can stand on and find
              again.
            </div>
          </div>
          <div className="callout">
            <div className="tri" />
            <div>
              You'll place two points next. The line between them sets the orientation of the whole
              map — pick a long, straight, permanent edge.
            </div>
          </div>
          <button
            className="btn"
            disabled={!name.trim() || action.busy}
            onClick={() =>
              void action.run(async () => {
                await invoke('garden/create-site', {
                  name: name.trim(),
                  ...(datum.trim() ? { datumNote: datum.trim() } : {}),
                });
                setCreating(false);
                setName('');
                setDatum('');
              })
            }
          >
            Continue
          </button>
        </Sheet>
      )}
    </div>
  );
}

// ── Site view: Map / List (design 05–15) ─────────────────────────────────────

function SiteView(props: {
  site: SitePayload;
  readOnly: boolean;
  onBack: () => void;
  refresh: () => Promise<void>;
}) {
  const { site, readOnly } = props;
  const [mode, setMode] = useState<'map' | 'list'>('map');
  const [tab, setTab] = useState<'points' | 'measure' | 'features' | 'plants' | 'constraints'>('points');
  const [overlays, setOverlays] = useState<Overlays>({ tape: false, elevations: true, canopies: true });
  const [sheet, setSheet] = useState<SheetState>({ kind: 'none' });
  const [selected, setSelected] = useState<string | null>(null);
  const action = useAction(props.refresh);

  const byId = useMemo(() => new Map(site.points.map((p) => [p.id, p])), [site]);
  const pendingMirror = site.solve.needsSide[0] ?? null;

  const pickSide = (choice: MirrorChoice, side: 1 | -1) =>
    void action.run(() => invoke('garden/choose-side', { pointId: choice.id, side }));

  const close = () => setSheet({ kind: 'none' });

  return (
    <>
      <div className="topbar" style={{ borderTop: 'none' }}>
        <button onClick={props.onBack} style={{ fontSize: 20 }}>
          ←
        </button>
        <div style={{ font: '600 15px var(--sans)' }}>{site.site.name}</div>
        <div className="toggle" style={{ marginLeft: 'auto' }}>
          <button className={mode === 'map' ? 'active' : ''} onClick={() => setMode('map')}>
            Map
          </button>
          <button className={mode === 'list' ? 'active' : ''} onClick={() => setMode('list')}>
            List
          </button>
        </div>
      </div>
      {action.error && <div className="error-bar">{action.error}</div>}

      {mode === 'map' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
          <GardenMap
            site={site}
            overlays={overlays}
            selected={selected}
            pendingMirror={pendingMirror}
            onSelectPoint={(id) => {
              setSelected(id);
              setSheet({ kind: 'point', id });
            }}
            onPickSide={pickSide}
            onTrayPoint={(id) => setSheet({ kind: 'point', id })}
          />
          <div className="map-hud">
            {(['tape', 'elevations', 'canopies'] as const).map((k) => (
              <button
                key={k}
                className={`hud-chip${overlays[k] ? ' on' : ''}`}
                onClick={() => setOverlays((o) => ({ ...o, [k]: !o[k] }))}
              >
                {k === 'tape' ? 'Tape lines' : k === 'elevations' ? 'Elevations' : 'Canopies'}
              </button>
            ))}
            <button className="hud-chip" onClick={() => void downloadDxf(site.site.id).catch((e) => alert(e.message))}>
              ⇩ DXF
            </button>
          </div>
          {!readOnly && (
            <button className="map-fab" onClick={() => setSheet({ kind: 'add-measurement' })}>
              + Measurement
            </button>
          )}
          {pendingMirror && (
            <div className="tray" style={{ bottom: 74 }}>
              <div className="section-label">Which side?</div>
              <button className="meta" style={{ textAlign: 'left' }} onClick={() => setSheet({ kind: 'mirror', choice: pendingMirror })}>
                {byId.get(pendingMirror.id)?.name} fits in two places — tap a marker on the map, or
                decide here
              </button>
            </div>
          )}
        </div>
      )}

      {mode === 'list' && (
        <div className="screen">
          <div className="tabs">
            {(
              [
                ['points', 'Points'],
                ['measure', 'Measure'],
                ['features', 'Features'],
                ['plants', 'Plants'],
                ['constraints', 'Constraints'],
              ] as const
            ).map(([key, label]) => (
              <button key={key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
                {label}
              </button>
            ))}
          </div>

          {tab === 'points' && (
            <PointsTab site={site} readOnly={readOnly} onOpen={(id) => setSheet({ kind: 'point', id })} onAdd={() => setSheet({ kind: 'add-point' })} />
          )}
          {tab === 'measure' && (
            <MeasureTab site={site} readOnly={readOnly} onAdd={() => setSheet({ kind: 'add-measurement' })} refresh={props.refresh} />
          )}
          {tab === 'features' && (
            <>
              {site.features.map((f) => (
                <button key={f.id} className="row" onClick={() => setSheet({ kind: 'feature', feature: f })}>
                  <span>{f.name}</span>
                  <span className="right">
                    {f.type} · {f.vertices.length} pts{f.closed === 1 ? ' · closed' : ''}
                  </span>
                </button>
              ))}
              {!readOnly && (
                <button className="pill" onClick={() => setSheet({ kind: 'feature', feature: null })}>
                  <span style={{ color: 'var(--accent)', fontSize: 18 }}>+</span> Feature
                </button>
              )}
            </>
          )}
          {tab === 'plants' && (
            <>
              {site.plants.map((pl) => (
                <div key={pl.id} className="row">
                  <span>
                    {pl.label ?? pl.species.common_name}
                    <div className="hint" style={{ fontStyle: 'italic' }}>{pl.species.latin_name}</div>
                  </span>
                  <span className="right">
                    at {byId.get(pl.point_id)?.name} · ⌀{pl.species.mature_canopy_m ?? '?'} m
                    {!readOnly && (
                      <button
                        style={{ marginLeft: 10, color: 'var(--bad)' }}
                        onClick={() => void action.run(() => invoke('garden/remove-plant', { plantId: pl.id }))}
                      >
                        ✕
                      </button>
                    )}
                  </span>
                </div>
              ))}
              {!readOnly && (
                <button className="pill" onClick={() => setSheet({ kind: 'plant' })}>
                  <span style={{ color: 'var(--accent)', fontSize: 18 }}>+</span> Plant
                </button>
              )}
            </>
          )}
          {tab === 'constraints' && (
            <>
              {site.constraints.map((c) => {
                const r = site.solve.constraintResidualsCm[c.id];
                return (
                  <div key={c.id} className="row">
                    <span className={`residual ${r === undefined ? 'none' : r <= 2 ? 'good' : r <= 5 ? 'warn' : 'bad'}`} />
                    <span>{constraintLabel(c, site)}</span>
                    <span className="right">
                      {r !== undefined ? `${r.toFixed(1)} cm` : '—'}
                      {!readOnly && (
                        <button
                          style={{ marginLeft: 10, color: 'var(--bad)' }}
                          onClick={() => void action.run(() => invoke('garden/delete-constraint', { constraintId: c.id }))}
                        >
                          ✕
                        </button>
                      )}
                    </span>
                  </div>
                );
              })}
              <div className="hint">
                Constraints are assumptions, not measurements — each carries its own residual. If
                the tape disagrees with an assumed right angle, the constraint is what goes amber.
              </div>
              {!readOnly && (
                <button className="pill" onClick={() => setSheet({ kind: 'constraint' })}>
                  <span style={{ color: 'var(--accent)', fontSize: 18 }}>+</span> Constraint
                </button>
              )}
            </>
          )}
        </div>
      )}

      {/* Sheets */}
      {sheet.kind === 'add-point' && <AddPointSheet site={site} onClose={close} onSaved={props.refresh} />}
      {sheet.kind === 'add-measurement' && (
        <AddMeasurementSheet site={site} initialA={sheet.from} onClose={close} onSaved={props.refresh} />
      )}
      {sheet.kind === 'point' && (
        <PointDetailSheet
          site={site}
          pointId={sheet.id}
          readOnly={readOnly}
          onClose={close}
          onChanged={props.refresh}
          onAddMeasurementFrom={(id) => setSheet({ kind: 'add-measurement', from: id })}
        />
      )}
      {sheet.kind === 'mirror' && (
        <MirrorSheet
          site={site}
          choice={sheet.choice}
          onClose={close}
          onPick={(side) => {
            pickSide(sheet.choice, side);
            close();
          }}
        />
      )}
      {sheet.kind === 'constraint' && <ConstraintSheet site={site} onClose={close} onSaved={props.refresh} />}
      {sheet.kind === 'feature' && (
        <FeatureSheet site={site} existing={sheet.feature} readOnly={readOnly} onClose={close} onSaved={props.refresh} />
      )}
      {sheet.kind === 'plant' && <PlantSheet site={site} onClose={close} onSaved={props.refresh} />}
    </>
  );
}

function PointsTab(props: {
  site: SitePayload;
  readOnly: boolean;
  onOpen: (id: string) => void;
  onAdd: () => void;
}) {
  const { site } = props;
  const unplaced = site.points.filter((p) => p.status !== 'placed');
  const placed = site.points.filter((p) => p.status === 'placed');
  const distCount = (id: string) =>
    site.measurements.filter((m) => m.point_a === id || m.point_b === id).length;

  return (
    <>
      {unplaced.length > 0 && (
        <>
          <div className="section-label">Unplaced · {unplaced.length}</div>
          {unplaced.map((p) => (
            <button key={p.id} className="row" onClick={() => props.onOpen(p.id)}>
              <span className="residual none" />
              <span>{p.name}</span>
              <span className="right">needs {Math.max(2 - distCount(p.id), 1)} more distance{distCount(p.id) === 1 ? '' : 's'}</span>
            </button>
          ))}
        </>
      )}
      <div className="section-label">Placed · {placed.length}</div>
      {placed.map((p) => {
        const r = pointResidualCm(site, p.id);
        return (
          <button key={p.id} className="row" onClick={() => props.onOpen(p.id)}>
            <span className={`residual ${r === undefined ? 'none' : r <= 2 ? 'good' : r <= 5 ? 'warn' : 'bad'}`} />
            <span>
              {p.name}
              {p.locked === 1 ? ' 🔒' : ''}
            </span>
            <span className="right">
              {distCount(p.id)} distances{r !== undefined ? ` · ${r.toFixed(1)} cm` : ' · no residual'}
              {p.elevation_m !== null ? ` · ${p.elevation_m >= 0 ? '+' : ''}${p.elevation_m.toFixed(2)}` : ''}
            </span>
          </button>
        );
      })}
      {!props.readOnly && (
        <button className="pill" onClick={props.onAdd}>
          <span style={{ color: 'var(--accent)', fontSize: 18 }}>+</span> Point
        </button>
      )}
    </>
  );
}

function MeasureTab(props: {
  site: SitePayload;
  readOnly: boolean;
  onAdd: () => void;
  refresh: () => Promise<void>;
}) {
  const { site } = props;
  const byId = useMemo(() => new Map(site.points.map((p) => [p.id, p])), [site]);
  const action = useAction(props.refresh);
  const sorted = [...site.measurements].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <>
      {action.error && <div className="error-bar">{action.error}</div>}
      {sorted.map((m) => {
        const r = site.solve.measurementResidualsCm[m.id];
        return (
          <div key={m.id} className="row">
            <span className={`residual ${r === undefined ? 'none' : r <= 2 ? 'good' : r <= 5 ? 'warn' : 'bad'}`} />
            <span className="mono">
              {byId.get(m.point_a)?.name} → {byId.get(m.point_b)?.name}
            </span>
            <span className="right">
              {Math.round(m.distance_m * 100)}
              {r !== undefined ? ` · ${r.toFixed(1)} cm` : ''}
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
      {!props.readOnly && (
        <button className="pill" onClick={props.onAdd}>
          <span style={{ color: 'var(--accent)', fontSize: 18 }}>+</span> Measurement
        </button>
      )}
    </>
  );
}
