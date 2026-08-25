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
the same thing with the answers filled in ahead of time.

## Host a session

Hosting **runs** the session rather than joining it. It stands up a local relay,
exposes it through a free Cloudflare Quick Tunnel, and holds the document —
including doing the sending once everyone's ready — but it never appears in the
room and has no text box of its own. It needs the `cloudflared` binary on your
`PATH`:

```bash
brew install cloudflared          # one-time, if you don't already have it
muc serve
```

`muc serve` prints a **session code** — one word like `wide-blue-cat-42`. Share
that with whoever you want drafting; it's all they need. The screen then shows
who's connected, who's ready, and what's been sent.

Hosting takes no `--handle`, because nobody is drafting under it. To host
**and** take part, run `muc serve` in one terminal and `muc connect <code>` in
another.

## Join a session

Pass the code the host gave you:

```bash
muc connect wide-blue-cat-42 --handle nova
```

You'll be asked for a handle if you leave `--handle` off. Everyone in the
session sees the same text and each other's cursors, and late joiners receive
the full document automatically.

### Saying who you are

A session can hold a mix of people and agents, so two flags let a participant
say what they are:

- `--kind human|agent` — defaults to `human`. Agents appear as a **◆** in the
  legend where people appear as a **●**.
- `--descriptor` — a free-form note shown beside the handle, for saying what
  you're here to do.

```bash
muc connect wide-blue-cat-42 \
  --handle reviewer \
  --kind agent \
  --descriptor "watching for auth changes"
```

Everyone else then sees `◆ reviewer (watching for auth changes) ○` in their
participant list, alongside `● echo (you · 3 edits) ✓` for the people.

## Edit solo

Skip the network entirely and just poke at the box on your own:

```bash
muc solo
```

## Controls

```
move   ←→ char · ⌥←→ word · ⌘←→ line · ⌘↑↓ doc
edit   ⌫ char · ⌥⌫ word · ⌘⌫ line · ⏎ newline
       ⌃z undo · ⌃y redo · ⌃c ⌃c quit (twice, in quick succession)
view   ⇞⇟ or the scroll wheel move the draft without moving the cursor —
       typing snaps back. Click the scrollbar to jump.
       ⌃t authorship — tint each character in the color of whoever wrote it
send   ⌃s toggle ready — the server sends once everyone is ready
```

> **Known gap:** while `muc` is running it captures the mouse in order to read
> the wheel, so the terminal's own click-drag selection is disabled — hold
> **Shift** to select text meanwhile. Selection is being reimplemented in-app
> (with OSC 52 for the clipboard); until then, `⇞`/`⇟` work without the mouse.

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
npm run dev -- serve                          # run a session (no text box)
npm run dev -- connect <code> --handle nova   # join a session
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
