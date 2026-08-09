# triangle-scaffold

A multi-tenant business app built on [Substrat](https://substrat.net).

`src/` ships with a small **working reference vertical** (a bike-repair shop, green via
`npm test`) — your worked example and starting point. The build flow reshapes it into your
own domain; it is not meant to survive as-is.

## Build it

Open this project in Claude Code, Cursor, or opencode and start the build flow:

- **Claude Code**: `/substrat`
- **Cursor / opencode**: run the `new-vertical` command

Both follow [`.substrat/playbook.md`](.substrat/playbook.md). The always-on rules the
agent must not violate live in [`AGENTS.md`](AGENTS.md).

## Gates

```sh
pnpm install
pnpm test                 # the scenario, including the denials
pnpm lint:boundaries      # the layer rules (also: npx @substrat-run/boundary-lint)
pnpm typecheck
```
