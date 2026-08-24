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

## Start

Run it with no arguments and it asks what you want:

```bash
muc
```

You pick **Host a session** or **Join a session**, give the code if you're
joining, and say what handle everyone else should see. The subcommands below are
the same thing with the answers filled in ahead of time — and any of them will
still ask for a handle if you don't pass `--handle`.

## Host a session

Hosting stands up a local relay, exposes it through a free Cloudflare Quick
Tunnel, and drops you straight into the shared box. It needs the `cloudflared`
binary on your `PATH`:

```bash
brew install cloudflared          # one-time, if you don't already have it
muc serve --handle echo
```

`muc serve` prints a **session code** — one word like `wide-blue-cat-42`. Share
that with whoever you want editing alongside you; it's all they need.

## Join a session

Pass the code the host gave you:

```bash
muc connect wide-blue-cat-42 --handle nova
```

Everyone in the session sees the same text and each other's cursors, and late
joiners receive the full document automatically.

## Edit solo

Skip the network entirely and just poke at the box on your own:

```bash
muc solo
```

## Controls

```
move   ←→ char · ⌥←→ word · ⌘←→ line · ⌘↑↓ doc
edit   ⌫ char · ⌥⌫ word · ⌘⌫ line · ⏎ newline
       ⌃z undo · ⌃y redo · ⌃c quit
send   ⌃s toggle ready — the host sends once everyone is ready
```

> **Note:** `⌃s` (Ctrl+S) is the reliable "ready" chord and works in every
> terminal. `⇧⏎`/`⌥⏎` (Shift/Option+Enter) also toggle ready in terminals that
> emit a distinct sequence for it (e.g. Ghostty, kitty) — but **not** iTerm2 or
> macOS Terminal by default, where they just insert a newline.

## Develop

`npm run dev` runs the TUI straight from source with `tsx` (no build step).
Everything after `--` is forwarded to the CLI, so it takes the same arguments as
the published `muc` binary:

```bash
npm install

npm run dev                                   # ask what to do
npm run dev -- solo                           # solo, no network
npm run dev -- serve --handle echo            # host a session
npm run dev -- connect <code> --handle nova   # join a host's session
```

The `serve` form still needs `cloudflared` on your `PATH` (see
[Host a session](#host-a-session)).

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
