# AGENTS.md

This file provides guidance to AI agents working with code in this repository.

**This will be a public GitHub repository.** Never commit secrets, keys, tokens,
or real credentials.

## Project Overview

`muc` (published as `@augeo/muc`) is a terminal TUI where several people edit
one shared text box together in real time. It is a **bin/script**, not a
library: it builds to a single executable (`dist/cli.js`) that users run with
`npx @augeo/muc` or install globally as `muc`.

## Architecture

The document is a [Yjs](https://github.com/yjs/yjs) CRDT, and the network is a
central relay behind a Cloudflare tunnel — a star topology, **not**
peer-to-peer.

- One host runs `muc serve`: it stands up a local HTTP relay
  (`src/net/relay.ts`, an in-memory message log) and exposes it publicly through
  a Cloudflare Quick Tunnel (`src/net/tunnel.ts`), printing a URL to share.
- Everyone — the host included — joins as a client over a **`Channel`**
  (`src/net/channel.ts`), which short-polls the relay for new frames and POSTs
  its own. Long-lived streaming is deliberately avoided; a quick tunnel won't
  reliably forward one.
- The shared state lives in `src/collab/session.ts`: local edits and cursors are
  encoded as base64 frames and ridden over the channel, and inbound frames are
  applied to the Yjs doc. Because the relay replays its whole log to a late
  joiner, the document reconstructs automatically.
- The UI (`src/ui/Editor.tsx`) treats Yjs as the single source of truth — React
  never stores the text, it re-renders from the doc.

**The seam** is the `Channel` interface (`src/net/channel.ts`), where the
network meets the collaboration layer. Two implementations exist today: the
tunnel-backed channel and a no-op `createLocalChannel` for solo editing
(`--loopback`).

> **Direction note.** The original goal was true peer-to-peer over libp2p / the
> IPFS DHT; [`docs/spec.md`](./docs/spec.md) describes that plan and is now
> historical. The relay-over-tunnel transport was chosen to get a working shared
> experience first. Swapping in a real p2p transport later means providing
> another `Channel`.

## Tech Stack

- **Language:** TypeScript
- **UI:** [Ink](https://github.com/vadimdemedes/ink) (React for interactive
  CLIs) — source is `.tsx`, rendered with React 19
- **CLI framework:** [citty](https://github.com/unjs/citty) (`defineCommand` /
  `runMain`)
- **Bundler:** [tsdown](https://tsdown.dev/) → `dist/` (ESM, `target: node24`)
- **TS runner:** [tsx](https://tsx.is/) (for `dev`)
- **Test runner:** [Vitest](https://vitest.dev/)
- **Linter / Formatter (JS/TS/CSS/JSON):** [Biome](https://biomejs.dev/)
- **Formatter (Markdown):** [Prettier](https://prettier.io/)
- **Node version manager:** [Volta](https://volta.sh/) (pinned to Node 24.10.0)

## Project Structure

```
src/
├── cli.tsx                # citty entrypoint + shebang; `muc` and `muc serve`
├── app.tsx                # root <App> — wires channel ↔ collab session ↔ UI
├── ui/
│   ├── Editor.tsx          # the collaborative text box: raw-stdin input, Yjs render
│   └── Title.tsx           # the header line
├── collab/
│   ├── session.ts          # Yjs wiring: doc, awareness, undo, channel relay
│   └── cursors.ts          # relative-position cursor encode / decode
├── net/
│   ├── channel.ts          # Channel interface + tunnel / local implementations
│   ├── relay.ts            # local HTTP message-log server (the host runs this)
│   └── tunnel.ts           # spawns `cloudflared` for a public URL
└── utilities/
    ├── assertValue.ts
    └── assertValue.test.ts

dist/                      # gitignored — tsdown output (the published bin)
```

## Commands

| Command             | Description                                       |
| ------------------- | ------------------------------------------------- |
| `npm run dev`       | Run the TUI from source with `tsx` (no build)     |
| `npm run build`     | Bundle `src/cli.tsx` → `dist/cli.js` with tsdown  |
| `npm run lint`      | Biome + Prettier check across the tree            |
| `npm run lint:fix`  | Biome + Prettier auto-fix                         |
| `npm run typecheck` | `tsc --noEmit`                                    |
| `npm run test`      | Vitest (run mode)                                 |
| `npm run verify`    | `lint:fix → typecheck → test → build` — fail-fast |

`npm run verify` is the canonical "before commit / before handoff" check. Run it
after any non-trivial change, not just at submit time.

## Formatting

- **Biome** owns JS / TS / TSX / CSS / JSON formatting and linting.
- **Prettier** owns Markdown only — see `.prettierignore` for the boundary; the
  two never overlap.
- Tabs for indentation, 80-char line width, double quotes, trailing commas.
- Imports are auto-organized by Biome.

## Coding Conventions

- Use **full words** for variable names, not abbreviations (e.g., `message` not
  `msg`, `listener` not `cb`).
- Prefer **named exports** over default exports (config files that require a
  default export are the exception).
- Use **`function` declarations** for named/top-level functions and components;
  arrow functions are fine for anonymous callbacks.
- Use **`undefined`**, not `null`, for absent values.
- **Function ordering:** most important first, helpers last. Exported / primary
  functions at the top of the file, internal helpers below.
- **Object / interface properties:** order by importance, not alphabetically.
  Identifying fields first, core fields next, optional / metadata fields last.
- **Iteration:** prefer enumerables (`forEach`, `map`, `reduce`, `filter`,
  `find`) over `for` loops.
- **Directory modules:** when a module grows into a directory, use `index.ts` as
  a barrel export only — implementation lives in a named file.
- **Relative imports carry their extension** (e.g. `./app.tsx`,
  `./net/channel.ts`) — `moduleResolution: bundler` + `noEmit` require it and
  tsdown resolves it.
- **Keep it simple.** Don't over-engineer. The only certainty is that we'll need
  to change what we write — favor code that's easy to mutate.

## Working with the Operator

- **File references in conversation** use project-relative paths (e.g.
  `src/app.tsx:14`), not absolute paths. The project root is the implicit base.
- **Slow down before writing.** Read each task fully and think through naming,
  file placement, and structure before writing code.
- **Keep tests in sync.** When modifying a module that has a `.test.ts` file,
  update the tests in the same pass. Don't leave them stale.
- **Prefer the Grep tool over CLI `grep`** when searching file contents.

## Working Style

- **Ask before assuming.** Stop and ask for clarification when requirements are
  unclear — especially around the network layer and any move back toward true
  peer-to-peer.
- **One problem at a time** for complex multi-file changes. Fix one and verify
  before continuing.

## Before Submitting Changes

Run `npm run verify` to auto-fix lint, type-check, test, and build.
