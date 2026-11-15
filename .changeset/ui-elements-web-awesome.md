---
"triangle": minor
---

The app draws with `@substrat-run/elements` and Web Awesome, themed to the design handover.

- Sheets are Web Awesome dialogs dressed as the handover's bottom sheet: focus stays inside,
  Escape and the backdrop close them.
- Fields, selects, switches, buttons, callouts, the Map/List switch and the list tabs are
  `wa-*` controls; the "closed loop" and "lock position" toggles are switches.
- The species library is a `<sub-entity-table>` over `garden/list-species` — sorted on the
  server and walked page by page, where the old list showed only the first page.
- Points and features have a History section: their events off the audit spine
  (`garden/timeline`), newest first, readable by a viewer too.
- Deployed, the top bar's account menu is `<sub-user-menu>`.
- `app/src/theme.css` maps Web Awesome's tokens onto the handover's: square, flat, violet,
  Public Sans.
