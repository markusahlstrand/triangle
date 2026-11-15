import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  LOGIN_URL,
  LINKS,
  api,
  downloadDxf,
  fetchSession,
  principal,
  redeemLink,
  setPrincipal,
  type MirrorChoice,
  type Session,
  type SitePayload,
  type SiteSummary,
} from './api';
import { GardenMap, pointResidualCm, type Overlays } from './Map';
import {
  AddMeasurementSheet,
  AddPointSheet,
  ConstraintSheet,
  FeatureSheet,
  MeasurementSheet,
  MirrorSheet,
  PlantSheet,
  ErrorNote,
  Guide,
  PointDetailSheet,
  RemoveButton,
  Sheet,
  valueOf,
  constraintLabel,
  useAction,
} from './Sheets';
import type { Feature } from './api';
import { MembersSheet } from './Members';

// ============================================================================
// The shell: principal picker in the top bar (the dev cast — every entry is a
// real principal with real permission tuples), garden home, and the site view
// with its Map/List toggle. A viewer gets the same views with every editing
// affordance GONE, not disabled (design 23/24), plus the VIEWING badge.
// ============================================================================

type SheetState =
  | { kind: 'none' }
  | { kind: 'add-point' }
  | { kind: 'add-measurement'; from?: string; to?: string }
  | { kind: 'point'; id: string }
  | { kind: 'measurement'; id: string }
  | { kind: 'mirror'; choice: MirrorChoice }
  | { kind: 'constraint' }
  | { kind: 'feature'; feature: Feature | null }
  | { kind: 'plant' };

export default function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [who, setWho] = useState(principal());
  const [sites, setSites] = useState<SiteSummary[] | null>(null);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [site, setSite] = useState<SitePayload | null>(null);
  const [showMembers, setShowMembers] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const cast = session?.kind === 'dev' ? session.cast : {};
  const signedIn = session?.kind === 'dev' || session?.kind === 'user';
  const readOnly =
    session?.kind === 'user'
      ? session.me.role === 'garden-viewer'
      : (cast[who]?.role.includes('viewer') ?? false);

  const loadSites = useCallback(async () => {
    setError(null);
    try {
      setSites((await api.listSites()).entries);
    } catch (e) {
      setSites([]);
      setError(String((e as Error).message));
    }
  }, []);

  const loadSite = useCallback(async (id: string) => {
    try {
      setSite(await api.getSite({ siteId: id }));
    } catch (e) {
      setError(String((e as Error).message));
      setSite(null);
      setSiteId(null);
    }
  }, []);

  // Resolve the session once. An `?invite=` or `?claim=` token is stashed and stripped
  // from the URL first (it survives the round-trip to the issuer via localStorage),
  // then redeemed as soon as we are back signed in — a 401 keeps it for after
  // sign-in; any other failure discards it so a dead token can't loop.
  useEffect(() => {
    const url = new URL(window.location.href);
    for (const link of Object.values(LINKS)) {
      const token = url.searchParams.get(link.param);
      if (!token) continue;
      localStorage.setItem(link.storageKey, token);
      url.searchParams.delete(link.param);
      window.history.replaceState(null, '', url.pathname + (url.search || ''));
    }
    void (async () => {
      let s = await fetchSession();
      for (const link of Object.values(LINKS)) {
        const token = localStorage.getItem(link.storageKey);
        if (!token || s.kind === 'dev') continue;
        try {
          await redeemLink(link.path, token);
          localStorage.removeItem(link.storageKey);
          s = await fetchSession();
        } catch (e) {
          if (e instanceof ApiError && e.status !== 401) {
            localStorage.removeItem(link.storageKey);
            setError(e.message);
          }
        }
      }
      setSession(s);
    })();
  }, []);
  useEffect(() => {
    if (!signedIn) return;
    setSiteId(null);
    setSite(null);
    void loadSites();
  }, [signedIn, who, loadSites]);
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
        {readOnly && (
          <wa-badge variant="brand" appearance="outlined" class="viewing-badge">
            VIEWING
          </wa-badge>
        )}
        {Object.keys(cast).length > 0 && (
          // The dev cast (local node server only): each entry is a real principal.
          <wa-select class="cast" size="small" value={who} onChange={(e) => switchPrincipal(valueOf(e))}>
            {Object.entries(cast).map(([key, entry]) => (
              <wa-option key={key} value={key}>
                {entry.name} · {entry.role}
              </wa-option>
            ))}
          </wa-select>
        )}
        {session?.kind === 'user' && (
          // Deployed: the account menu reads the same `/api/me` the shell does, shows the
          // signed-in address beside the avatar, and signs out through `/api/auth/logout`.
          // The owner also manages the garden's members from it.
          <sub-user-menu
            class="user-menu"
            show="email"
            onwa-select={(e: Event) => {
              const item = (e as CustomEvent<{ item: { value: string } }>).detail?.item;
              if (item?.value === 'members') setShowMembers(true);
            }}
          >
            {session.me.role === 'garden-owner' && <wa-dropdown-item value="members">Members</wa-dropdown-item>}
          </sub-user-menu>
        )}
      </div>
      {showMembers && <MembersSheet onClose={() => setShowMembers(false)} />}
      {error && <ErrorNote>{error}</ErrorNote>}
      {session?.kind === 'anonymous' && (
        <div className="screen">
          <div className="h1">Sign in</div>
          <div className="hint">
            {localStorage.getItem(LINKS.claim.storageKey)
              ? 'Sign in with your team account to claim this garden as its owner.'
              : session.needsSetup && session.firstSignInOpen
              ? 'This garden has just been set up — the first sign-in claims it as its owner.'
              : session.needsSetup
              ? 'This garden has no owner yet. Ask for a claim link from the dashboard, then open it here.'
              : localStorage.getItem(LINKS.invite.storageKey)
                ? 'Sign in with your team account to accept your invite to this garden.'
                : 'Sign in with your team account to open this garden.'}
          </div>
          <wa-button variant="brand" size="large" href={LOGIN_URL}>
            Continue with sign-in
          </wa-button>
        </div>
      )}
      {signedIn && !siteId && (
        <Home
          sites={sites}
          readOnly={readOnly}
          onOpen={setSiteId}
          onCreated={loadSites}
        />
      )}
      {signedIn && siteId && site && (
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
          {action.error && <ErrorNote>{action.error}</ErrorNote>}
          <wa-input
            label="Garden name"
            size="large"
            value={name}
            onInput={(e) => setName(valueOf(e))}
            placeholder="Casa Markus"
            autofocus
          />
          <wa-input
            label="Elevation datum"
            size="large"
            value={datum}
            onInput={(e) => setDatum(valueOf(e))}
            placeholder="Terrace floor = 0.00"
            hint="Every elevation is measured against this. Pick something you can stand on and find again."
          />
          <Guide>
            You'll place two points next. The line between them sets the orientation of the whole
            map — pick a long, straight, permanent edge.
          </Guide>
          <wa-button
            size="large"
            variant="brand"
            loading={action.busy}
            disabled={!name.trim() || action.busy}
            onClick={() =>
              void action.run(async () => {
                await api.createSite({
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
          </wa-button>
        </Sheet>
      )}
    </div>
  );
}

// ── Site view: Map / List (design 05–15) ─────────────────────────────────────

const TABS = [
  ['points', 'Points'],
  ['measure', 'Measure'],
  ['features', 'Features'],
  ['plants', 'Plants'],
  ['constraints', 'Constraints'],
] as const;
type Tab = (typeof TABS)[number][0];

function SiteView(props: {
  site: SitePayload;
  readOnly: boolean;
  onBack: () => void;
  refresh: () => Promise<void>;
}) {
  const { site, readOnly } = props;
  const [mode, setMode] = useState<'map' | 'list'>('map');
  const [tab, setTab] = useState<Tab>('points');
  const [overlays, setOverlays] = useState<Overlays>({ tape: false, elevations: true, canopies: true });
  const [sheet, setSheet] = useState<SheetState>({ kind: 'none' });
  const [selected, setSelected] = useState<string | null>(null);
  // Picking one end of a new measurement on the map: the sheet steps aside, the next tap on a
  // point fills that end, and the sheet comes back with both ends as they stand.
  const [picking, setPicking] = useState<{ which: 'a' | 'b'; a: string | null; b: string | null } | null>(null);
  const action = useAction(props.refresh);

  const byId = useMemo(() => new Map(site.points.map((p) => [p.id, p])), [site]);
  const pendingMirror = site.solve.needsSide[0] ?? null;

  const pickSide = (choice: MirrorChoice, side: 1 | -1) =>
    void action.run(() => api.chooseSide({ pointId: choice.id, side }));

  const close = () => setSheet({ kind: 'none' });
  const backToSheet = (a: string | null, b: string | null) => {
    setPicking(null);
    setSheet({ kind: 'add-measurement', from: a ?? undefined, to: b ?? undefined });
  };
  const pickOnMap = (which: 'a' | 'b', a: string | null, b: string | null) => {
    setMode('map');
    setSheet({ kind: 'none' });
    setPicking({ which, a, b });
  };

  return (
    <>
      <div className="topbar" style={{ borderTop: 'none' }}>
        <wa-button appearance="plain" size="small" onClick={props.onBack}>
          ←<span className="wa-visually-hidden"> Back to gardens</span>
        </wa-button>
        <div style={{ font: '600 15px var(--sans)' }}>{site.site.name}</div>
        <wa-radio-group
          class="toggle"
          orientation="horizontal"
          size="small"
          value={mode}
          onChange={(e) => setMode(valueOf(e) as 'map' | 'list')}
        >
          <wa-radio appearance="button" value="map">
            Map
          </wa-radio>
          <wa-radio appearance="button" value="list">
            List
          </wa-radio>
        </wa-radio-group>
      </div>
      {action.error && <ErrorNote>{action.error}</ErrorNote>}

      {mode === 'map' && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0, position: 'relative' }}>
          <GardenMap
            site={site}
            overlays={overlays}
            selected={selected}
            pendingMirror={pendingMirror}
            onSelectPoint={(id) => {
              if (picking) {
                const other = picking.which === 'a' ? picking.b : picking.a;
                if (id === other) return; // a tape pull needs two different points
                if (picking.which === 'a') backToSheet(id, picking.b);
                else backToSheet(picking.a, id);
                return;
              }
              setSelected(id);
              setSheet({ kind: 'point', id });
            }}
            onSelectMeasurement={(id) => {
              if (!picking) setSheet({ kind: 'measurement', id });
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
          {picking && (
            <div className="tray pick-banner">
              <div className="section-label">New measurement</div>
              <div>
                Tap the <strong>{picking.which === 'a' ? 'From' : 'To'}</strong> point
                {picking.which === 'b' && picking.a ? ` (from ${byId.get(picking.a)?.name})` : ''}
              </div>
              <wa-button size="small" appearance="outlined" onClick={() => backToSheet(picking.a, picking.b)}>
                Back to the list
              </wa-button>
            </div>
          )}
          {!readOnly && !picking && (
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
          <wa-tab-group
            class="tabs"
            active={tab}
            onwa-tab-show={(e: CustomEvent<{ name: String }>) => {
              if (e.target === e.currentTarget) setTab(String(e.detail.name) as Tab);
            }}
          >
            {TABS.map(([key, label]) => (
              <wa-tab key={key} slot="nav" panel={key}>
                {label}
              </wa-tab>
            ))}
            {TABS.map(([key]) => (
              <wa-tab-panel key={key} name={key}>
                {/* Only the open tab draws its rows. */}
                {tab === key && <div className="tab-body">
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
                      <RemoveButton
                        what={pl.label ?? pl.species.common_name}
                        disabled={action.busy}
                        onClick={() => void action.run(() => api.removePlant({ plantId: pl.id }))}
                      />
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
                        <RemoveButton
                          what={constraintLabel(c, site)}
                          disabled={action.busy}
                          onClick={() => void action.run(() => api.deleteConstraint({ constraintId: c.id }))}
                        />
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
                </div>}
              </wa-tab-panel>
            ))}
          </wa-tab-group>
        </div>
      )}

      {/* Sheets */}
      {sheet.kind === 'add-point' && <AddPointSheet site={site} onClose={close} onSaved={props.refresh} />}
      {sheet.kind === 'add-measurement' && (
        <AddMeasurementSheet
          site={site}
          initialA={sheet.from}
          initialB={sheet.to}
          onClose={close}
          onSaved={props.refresh}
          onPickOnMap={pickOnMap}
        />
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
      {sheet.kind === 'measurement' && (
        <MeasurementSheet
          site={site}
          measurementId={sheet.id}
          readOnly={readOnly}
          onClose={close}
          onChanged={props.refresh}
          onOpenPoint={(id) => setSheet({ kind: 'point', id })}
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
      {action.error && <ErrorNote>{action.error}</ErrorNote>}
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
                <RemoveButton
                  what={`${byId.get(m.point_a)?.name} → ${byId.get(m.point_b)?.name}`}
                  disabled={action.busy}
                  onClick={() => void action.run(() => api.deleteMeasurement({ measurementId: m.id }))}
                />
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
