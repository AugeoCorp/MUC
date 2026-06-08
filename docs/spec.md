# MUC — Foundation Spec

This document describes what `@augeo/muc` is and the shape of the foundation as
it stands today. It is a snapshot of the skeleton, not a plan for the finished
product — the chat experience and the peer-to-peer transport are deliberately
stubbed.

## Overview

`muc` is a peer-to-peer chat client that runs as an interactive terminal TUI:
people open a connection and chat together in the terminal. It ships as a
**bin/script** (`muc`), not a library — it builds to a single executable
(`dist/cli.js`) run with `npx @augeo/muc` or installed globally.

**Status: foundation.** The toolchain, build, type-checking, tests, and a
rendering app shell are all in place and green. Everything a user would
recognize as "the app" is a placeholder behind a clean seam.

## Goals & Non-Goals

**Goals of this phase**

- A real, runnable Ink TUI that builds and launches.
- The full house toolchain wired and passing: Biome, Prettier (Markdown),
  TypeScript strict, Vitest, tsdown.
- A clearly marked seam where the peer-to-peer transport will land, with a
  no-network stub behind it so the UI can be exercised today.

**Non-goals (deferred)**

- Any real networking or peer discovery — the transport is a loopback stub.
- A finished chat UX — the UI is a rough shell (message list + composer).
- Persistence, history, identity, encryption, configuration, multi-room, etc.

## Architecture

Data flows in one loop: keystrokes become outbound messages through the
transport; the transport delivers messages (its own, and eventually peers') back
to the app, which renders them.

```
              ┌─────────────────────────────────────────┐
              │                 App                      │
   keystroke  │  ┌────────────┐        ┌──────────────┐  │
   ──────────►│  │  Composer  │        │ MessageList  │  │
              │  └─────┬──────┘        └──────▲───────┘  │
              │        │ onSubmit(body)       │ messages │
              │        ▼                      │          │
              │   transport.send()    transport.subscribe()
              │        │                      ▲          │
              └────────┼──────────────────────┼──────────┘
                       ▼                      │
                 ┌─────────────────────────────────┐
                 │   Transport (the P2P seam)       │
                 │   today: loopback stub           │
                 │   later: real peer-to-peer       │
                 └─────────────────────────────────┘
```

The UI never knows how messages travel. It depends only on the `Transport`
interface, so swapping the loopback stub for real networking touches no UI code.

## Modules

| File                        | Responsibility                                              |
| --------------------------- | ----------------------------------------------------------- |
| `src/cli.tsx`               | citty entrypoint + shebang. Parses `--handle`, renders App. |
| `src/app.tsx`               | Root `<App>`. Owns message state, wires transport ↔ UI.     |
| `src/ui/MessageList.tsx`    | Renders the message log (keyed by message id).              |
| `src/ui/Composer.tsx`       | Captures keystrokes, submits the draft on enter.            |
| `src/net/transport.ts`      | The `Transport` interface + `ChatMessage` type — the seam.  |
| `src/net/transport.stub.ts` | Loopback `Transport`: echoes your own sends back to you.    |
| `src/utilities/`            | Small shared helpers (`assertValue` + its test).            |

### Entrypoint (`cli.tsx`)

A single citty command. One argument today — `--handle` (display name, defaults
to `anon`). `run()` calls Ink's `render(<App />)` and returns `waitUntilExit()`
so the process stays alive for the duration of the session. The file carries the
`#!/usr/bin/env node` shebang; tsdown preserves it and marks the output
executable.

### App (`app.tsx`)

Constructs a transport once per handle (`useMemo`), holds the message list in
state, and subscribes to inbound messages in an effect (unsubscribing and
disconnecting on unmount). Renders a header, a status line, the `MessageList`,
and the `Composer`.

### UI (`ui/`)

- **`MessageList`** — maps `ChatMessage[]` to rows (`handle › body`), keyed by
  the message `id`. Shows an empty-state line when there are no messages.
- **`Composer`** — a minimal controlled input built directly on Ink's `useInput`
  (no extra input dependency). Enter submits a trimmed non-empty draft and
  clears it; backspace deletes; other printable keys append.

## The Transport Seam

This is the most important boundary in the codebase. It is the single place a
real peer-to-peer implementation plugs in.

### Contract (`src/net/transport.ts`)

```ts
interface ChatMessage {
	id: string;
	handle: string;
	body: string;
	sentAt: number;
}

interface TransportOptions {
	handle: string;
}

interface Transport {
	send(body: string): void;
	subscribe(listener: (message: ChatMessage) => void): () => void;
	disconnect(): void;
}
```

- **`send(body)`** — broadcast a message body to every connected peer.
- **`subscribe(listener)`** — register an inbound-message listener; returns an
  unsubscribe function.
- **`disconnect()`** — tear down connections and drop all listeners.

A conforming implementation must: assign each message a unique `id`, stamp
`sentAt`, deliver inbound messages to every active subscriber, and clean up
fully on `disconnect()`.

### Current implementation (`transport.stub.ts`)

`createLoopbackTransport` keeps an in-memory `Set` of listeners. `send()` builds
a `ChatMessage` (id via `crypto.randomUUID()`, `sentAt` via `Date.now()`) and
delivers it to every listener — so you see your own messages, as if one peer
were mirroring you. It needs no network and exists only to exercise the UI.

### What a real transport must add

- Peer discovery / connection establishment (technology **not yet chosen**).
- Serializing `ChatMessage` over the wire and reconstructing it on receipt.
- Delivering remote peers' messages to subscribers, not just local echoes.
- Connection lifecycle: joins, drops, errors, reconnects.

Open question: which transport. Hyperswarm (DHT-based, serverless) has been
floated but nothing is committed. The interface is intentionally narrow so the
decision stays cheap to defer.

## Toolchain & Conventions

| Concern                      | Choice                                              |
| ---------------------------- | --------------------------------------------------- |
| Runtime                      | Node 24.10.0 / npm 11.6.2 (pinned: engines + Volta) |
| Modules                      | ESM (`"type": "module"`)                            |
| UI                           | Ink (React 19) — source is `.tsx`                   |
| CLI framework                | citty                                               |
| Bundler                      | tsdown → `dist/`, ESM, `target: node24`             |
| Dev runner                   | tsx                                                 |
| Tests                        | Vitest                                              |
| Lint/format (JS/TS/CSS/JSON) | Biome — tabs, 80 cols, double quotes, trailing all  |
| Format (Markdown)            | Prettier (`proseWrap: always`)                      |

Code conventions (full in `AGENTS.md`): full-word names, named exports,
`function` declarations, `undefined` over `null`, importance-ordered properties,
relative imports carry their extension.

## Build Pipeline

`npm run build` runs tsdown, which reads `tsdown.config.ts` and bundles
`src/cli.tsx` → `dist/cli.js`. Notable config:

- `fixedExtension: false` — emit `.js` (not `.mjs`) since the package is
  `"type": "module"`, matching the `bin` path.
- `platform: "node"`, `target: "node24"`, `clean: true`.
- Runtime dependencies (ink, react, citty) are left external and resolved from
  `node_modules` at run time.

Two build-environment notes worth remembering:

- tsdown needs `unrun` (an optional peer dep) installed to load the TypeScript
  config file. It is a devDependency here.
- The TS config sets `allowImportingTsExtensions: true` because `src/` is
  type-checked and its relative imports carry `.ts`/`.tsx` extensions.

## Commands

| Command             | Description                                       |
| ------------------- | ------------------------------------------------- |
| `npm run dev`       | Run the TUI from source with tsx (no build)       |
| `npm run build`     | Bundle `src/cli.tsx` → `dist/cli.js`              |
| `npm run lint`      | Biome + Prettier check                            |
| `npm run lint:fix`  | Biome + Prettier auto-fix                         |
| `npm run typecheck` | `tsc --noEmit`                                    |
| `npm run test`      | Vitest (run mode)                                 |
| `npm run verify`    | `lint:fix → typecheck → test → build` — fail-fast |

## Open Decisions & Next Steps

1. **Pick the transport.** The defining technical choice — Hyperswarm vs
   js-libp2p vs raw sockets/WebRTC. Drives discovery, NAT traversal, and
   encryption.
2. **Flesh out the chat UX.** Scrollback, timestamps, peer presence, your own vs
   others' message styling, input affordances.
3. **Identity & rooms.** How peers find each other and what "a conversation" is
   (topic? invite code? address exchange?).
4. **Wire protocol.** How a `ChatMessage` is serialized once there are real
   peers.
