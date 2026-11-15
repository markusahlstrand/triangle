/**
 * The web components this app draws with, registered once.
 *
 * Web Awesome's curated controls (`@substrat-run/elements/controls`), plus the two Substrat
 * elements the screens use — by subpath, so the bundle carries only those. Themed by
 * `theme.css` through the `--wa-*` tokens alone.
 */
import '@substrat-run/elements/themes/base.css';
import './theme.css';
import '@substrat-run/elements/controls';
// The tab panels that go with `wa-tab-group` — free core, outside the curated list.
import '@awesome.me/webawesome/dist/components/tab-panel/tab-panel.js';
import '@substrat-run/elements/user-menu';
import '@substrat-run/elements/entity-table';

import type { DetailedHTMLProps, HTMLAttributes } from 'react';
import type { SubEntityTable } from '@substrat-run/elements/entity-table';
// Types every `wa-*` element for JSX.
import type {} from '@substrat-run/elements/jsx';

type SubProps<E> = DetailedHTMLProps<HTMLAttributes<E>, E> & Record<string, unknown>;

declare module 'react' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      'sub-user-menu': SubProps<HTMLElement>;
      'sub-entity-table': SubProps<SubEntityTable>;
    }
  }
}
