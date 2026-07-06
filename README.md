# muc

Co-draft a message to an AI agent, together — an interactive
[Ink](https://github.com/vadimdemedes/ink) TUI where several people share one
text box, edit it live (cursors and all), then send the finished message to the
agent.

> **Status: early.** The collaborative composer works today over a Cloudflare
> tunnel relay (a central relay, not yet true peer-to-peer); wiring the drafted
> message through to the agent is still in progress. See
> [`AGENTS.md`](./AGENTS.md) for the architecture and where it's headed.

## Install

```bash
npm install -g @augeo/muc     # then run `muc`
# or run it without installing:
npx @augeo/muc --help
```

## Host a session

Hosting stands up a local relay, exposes it through a free Cloudflare Quick
Tunnel, and drops you straight into the shared box. It needs the `cloudflared`
binary on your `PATH`:

```bash
brew install cloudflared          # one-time, if you don't already have it
muc serve --handle echo
```

`muc serve` prints a public `https://<something>.trycloudflare.com` URL — share
that link with whoever you want editing alongside you.

## Join a session

Point `--url` at the link the host gave you:

```bash
muc --url https://<something>.trycloudflare.com --handle nova
```

Everyone in the session sees the same text and each other's cursors, and late
joiners receive the full document automatically.

## Edit solo

Skip the network entirely and just poke at the box on your own:

```bash
muc --loopback
```

## Controls

```
move   ←→ char · ⌥←→ word · ⌘←→ line · ⌘↑↓ doc
edit   ⌫ char · ⌥⌫ word · ⌘⌫ line · ⏎ newline
       ⌃z undo · ⌃y redo · ⌃c quit
```

## Develop

```bash
npm install
npm run dev -- --loopback            # run from source, solo
npm run dev -- serve --handle echo   # run from source, hosting
```

## Scripts

| Command             | Description                                       |
| ------------------- | ------------------------------------------------- |
| `npm run dev`       | Run the TUI from source with `tsx` (no build)     |
| `npm run build`     | Bundle to `dist/cli.js` with tsdown               |
| `npm run lint`      | Biome + Prettier check                            |
| `npm run lint:fix`  | Biome + Prettier auto-fix                         |
| `npm run typecheck` | `tsc --noEmit`                                    |
| `npm run test`      | Vitest                                            |
| `npm run verify`    | `lint:fix → typecheck → test → build` — fail-fast |

## Stack

TypeScript · Ink + React · citty · Yjs · tsdown · Vitest · Biome · Prettier
(Markdown) · Volta (Node 24.10.0)
