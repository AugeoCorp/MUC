# AGENTS.md

This file provides guidance to AI agents working with code in this repository.

**This will be a public GitHub repository.** Never commit secrets, keys, tokens,
or real credentials.

## Project Overview

`muc` (published as `@augeo/muc`) is a terminal chat client — an interactive TUI
where people open a peer-to-peer connection and chat together. It is a
**bin/script**, not a library: it builds to a single executable (`dist/cli.js`)
that users run with `npx @augeo/muc` or install globally as `muc`.

The project is in its **foundation phase**. The chat experience and the
peer-to-peer transport are deliberately stubbed so the toolchain, build, and app
shell are solid first. Two seams mark where the real work lands:

- **`src/net/transport.ts`** — the `Transport` interface the UI talks to. The
  only implementation today is an in-memory loopback
  (`src/net/transport.stub.ts`) that echoes your own messages back. The real
  transport will be built on **libp2p over the public IPFS DHT** (decided in
  direction, not yet implemented) — see [`docs/spec.md`](./docs/spec.md).
- **`src/ui/`** — a rough Ink chat shell (message list + composer), enough to
  prove the rendering and the transport seam, not a finished UX.

See [`docs/spec.md`](./docs/spec.md) for the full foundation spec —
architecture, the transport contract, and open decisions.

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
├── cli.tsx                # citty entrypoint + shebang; renders the Ink app
├── app.tsx                # root <App> — wires transport ↔ UI state
├── ui/
│   ├── MessageList.tsx     # renders the message log
│   └── Composer.tsx        # captures keystrokes, submits on enter
├── net/
│   ├── transport.ts        # Transport interface (the P2P seam)
│   └── transport.stub.ts   # loopback placeholder implementation
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
  `./net/transport.ts`) — `moduleResolution: bundler` + `noEmit` require it and
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
  unclear — especially around the not-yet-chosen transport.
- **One problem at a time** for complex multi-file changes. Fix one and verify
  before continuing.

## Before Submitting Changes

Run `npm run verify` to auto-fix lint, type-check, test, and build.
