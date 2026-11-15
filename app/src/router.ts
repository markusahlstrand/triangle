import { useEffect, useState } from 'react';

// ============================================================================
// A small History-API router: every view the app shows is a URL, so a garden, a
// list tab, a point or a measurement can be bookmarked, shared, reloaded and
// reached with the back button. No dependency — the app has a handful of routes.
//
//   /                                          the gardens
//   /members                                   members (owner)
//   /gardens/:siteId/map                       the map
//   /gardens/:siteId/{points|measurements|features|plants|constraints}
//                                              a list tab
//   /gardens/:siteId/:collection/new           a "new …" sheet
//   /gardens/:siteId/:collection/:id           one point / measurement / feature
//   …?on=map                                   a sheet opened over the map, not the list
//   /gardens/:siteId/measurements/new?from=&to=  a new measurement with its ends chosen
//
// Deployed, the platform serves index.html for any path that is not an asset or
// /api/* (SPA fallback); Vite does the same in dev.
// ============================================================================

export interface Route {
  path: string;
  query: URLSearchParams;
}

/**
 * History state for an entry that opened a sheet: how many sheets deep it is, so closing
 * returns to the view underneath with `history.go(-depth)` instead of piling up entries.
 */
interface SheetEntry {
  sheetDepth: number;
}

const CHANGE = 'triangle:navigate';

function current(): Route {
  return { path: window.location.pathname.replace(/\/+$/, '') || '/', query: new URLSearchParams(window.location.search) };
}

/** Go to `to`. A sheet push records its depth so `closeSheet` can unwind it exactly. */
export function navigate(to: string, opts: { replace?: boolean; sheet?: boolean } = {}): void {
  const depth = (window.history.state as SheetEntry | null)?.sheetDepth ?? 0;
  const state: SheetEntry | null = opts.sheet ? { sheetDepth: opts.replace ? depth : depth + 1 } : null;
  if (opts.replace) window.history.replaceState(state, '', to);
  else window.history.pushState(state, '', to);
  window.dispatchEvent(new Event(CHANGE));
}

/** Close the open sheet(s): back to the entry underneath, or — on a deep link — replace with it. */
export function closeSheet(background: string): void {
  const depth = (window.history.state as SheetEntry | null)?.sheetDepth ?? 0;
  if (depth > 0) window.history.go(-depth);
  else navigate(background, { replace: true });
}

/** The current route, re-read on every navigation and on back/forward. */
export function useRoute(): Route {
  const [route, setRoute] = useState(current);
  useEffect(() => {
    const update = () => setRoute(current());
    window.addEventListener('popstate', update);
    window.addEventListener(CHANGE, update);
    return () => {
      window.removeEventListener('popstate', update);
      window.removeEventListener(CHANGE, update);
    };
  }, []);
  return route;
}

/** `/gardens/:siteId/…` → the site id and the segments after it; null for any other path. */
export function gardenPath(path: string): { siteId: string; rest: string[] } | null {
  const m = /^\/gardens\/([^/]+)(\/.*)?$/.exec(path);
  if (!m) return null;
  return { siteId: decodeURIComponent(m[1]!), rest: (m[2] ?? '').split('/').filter(Boolean).map(decodeURIComponent) };
}
