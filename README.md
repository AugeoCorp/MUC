# muc

Peer-to-peer chat in your terminal — an interactive
[Ink](https://github.com/vadimdemedes/ink) TUI where people connect and chat
together.

> **Status: foundation.** The toolchain, build, and app shell are in place. The
> chat UI is a rough shell and the peer-to-peer transport is a loopback stub —
> the real transport is not yet chosen.

## Develop

```bash
npm install
npm run dev          # launch the TUI from source
npm run dev -- --handle echo   # pick a display name
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

TypeScript · Ink + React · citty · tsdown · Vitest · Biome · Prettier (Markdown)
· Volta (Node 24.10.0)
