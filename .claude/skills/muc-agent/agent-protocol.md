# muc agent protocol

The control surface an agent uses to drive `muc agent` — a headless participant
in a collab session. Everything here is localhost HTTP + JSON; no source reading
required.

## Lifecycle

Start:

```
muc agent <code> [--handle NAME] [--descriptor TEXT] [--port N]
```

- `<code>` is the session code from `muc serve` (e.g. `wide-blue-cat-42`).
- `--handle` defaults to `anon` (headless — nothing prompts).
- `--descriptor` is a free-form note shown beside the handle; use it to say what
  the agent is and why it's here.
- `--port` is the control API port; `0` (the default) picks a free one.

On success, exactly **one JSON line** is printed to stdout:

```json
{ "listening": 49321, "handle": "scribe", "code": "wide-blue-cat-42" }
```

Parse it for the port; the API is `http://127.0.0.1:<listening>`. On failure
(bad code, unreachable relay) one line goes to stderr and the process exits with
code 1.

Stop with the `quit` op (below) or SIGINT / SIGTERM — all three tear down
presence and exit cleanly.

## GET /state

Full snapshot, always current — no cursor to manage.

```json
{
	"text": "the shared draft\n",
	"myIndex": 17,
	"myReady": false,
	"everyoneReady": false,
	"participants": [
		{
			"name": "kirby",
			"color": "#4dd2ff",
			"kind": "human",
			"descriptor": "host",
			"index": 4,
			"ready": true
		}
	],
	"messages": ["previously sent message"]
}
```

- `text` — the entire draft.
- `myIndex` — the agent's own cursor position (absolute index into `text`).
- `myReady` — the agent's own ready flag.
- `everyoneReady` — whether every present **human** is ready (agents never
  count; a room with no humans is never ready).
- `participants` — every _other_ participant. `kind` is `"human"` or `"agent"`
  (agents render as ◆ in the human TUI, humans as ●); `color` is a hex the
  server assigns so no two participants share one; `descriptor` is their
  free-form note (may be absent); `index` is their cursor (may be absent if
  momentarily unresolvable); `ready` is their flag. The serving host publishes
  no presence and never appears here.
- Ready flags are part of the shared document, not of presence: a flag and the
  text it was set against always arrive together.
- `messages` — the shared log of sent messages, oldest first.

## GET /events?since=N&wait=MS

Sequenced event feed with a cursor and optional long-poll.

- `since` — return only events with `seq > N`. Start at `0`.
- `wait` — if nothing is pending, hold the request up to `MS` milliseconds
  (capped at 30000) and answer as soon as an event lands.

Response: `{ "seq": <latest seq issued>, "gap": <boolean>, "events": [...] }`.
Pass the returned `seq` as the next `since`. The buffer keeps the last 500
events; `gap: true` means your cursor fell further behind than that and events
between it and the oldest retained one are gone — resync from `/state`. A
malformed `since` or `wait` counts as `0`.

Every event carries `seq`, `ts` (ISO timestamp), and `type`:

**`text`** — the draft changed. Bursts are coalesced into one event per ~300ms
window; `edits` keeps every delta in order, `text` is the full draft afterward.

```json
{
	"seq": 7,
	"ts": "2026-08-24T21:04:05.120Z",
	"type": "text",
	"edits": [
		{
			"origin": "remote",
			"delta": [{ "retain": 4 }, { "insert": "!" }],
			"by": { "name": "kirby", "kind": "human" }
		}
	],
	"text": "hey!\n"
}
```

`origin` is `"local"` (the agent's own op) or `"remote"`. `delta` is a Yjs delta
array (`retain` / `insert` / `delete` steps). `by` names the writer when
resolvable — local edits are always the agent's own user; remote edits resolve
through presence. `by` is **omitted** when attribution isn't certain:
delete-only remote updates, backlog replayed before presence arrived, or the
presence-less host clearing the composer after a send.

**`roster`** — membership or a ready flag changed (not cursor movement). Carries
`participants`, same shape as `/state`.

**`message`** — the sent-message log changed. Carries `messages`, the full log.

## POST /cmd

Body: `{"op": "...", ...params}`, sent with `content-type: application/json` —
any other content type is refused with 415, which is what keeps a web page from
driving this port through a no-preflight `fetch`. Response is always JSON:
`{"ok": true, ...}` or `{"ok": false, "error": "..."}` (HTTP 200 either way;
malformed JSON is 400, a body over 700 KiB is 413). `ok` means the edit has
landed at the relay, not just in this client's copy: if the relay refuses the
frame, the answer is
`{"ok": false, "error": "applied locally but not delivered: …"}` and the peers
never saw that edit. Ops are **serialized** through a queue — a slow `type`
cannot interleave with a concurrent `replace` from another caller. Every index
and count must be an integer.

| op            | params                                         | returns             | notes                                                                                                                                                                                                                                                                          |
| ------------- | ---------------------------------------------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `appendLine`  | `line: string`                                 | `{ok, text}`        | Appends `line` as its own line at the end, in one atomic transaction. **The collision-safe way to speak.**                                                                                                                                                                     |
| `replace`     | `find: string, insert: string, after?: string` | `{ok, index, text}` | Atomic find-and-replace of the first occurrence (searching after the `after` anchor if given). **Never moves your cursor.** Miss → `{ok: false, error: "find: no match"}` (`"after: no match"` when the anchor is what's absent).                                              |
| `splices`     | `splices: [{at, remove, insert}]`              | `{ok, text}`        | Several edits in one transaction. Indices refer to the document _before_ the batch; applied highest-index first, and same-index splices land in the order given. Overlaps are your mistake.                                                                                    |
| `type`        | `text: string, cps?: number`                   | `{ok, text}`        | Human-paced typing at the live cursor (default 14 chars/sec, clamped 1–100). Interleaves with concurrent typing at the same spot — prefer `appendLine` unless visible typing is the point. Refused while every human is ready: the first character would be the whole message. |
| `insert`      | `text: string`                                 | `{ok, text}`        | Insert at the cursor in one transaction; cursor advances past it.                                                                                                                                                                                                              |
| `moveTo`      | `index: number`                                | `{ok, myIndex}`     | Publish the cursor at a clamped index.                                                                                                                                                                                                                                         |
| `deleteRange` | `index: number, count: number`                 | `{ok, text}`        | Delete a clamped range; cursor parks at its start.                                                                                                                                                                                                                             |
| `ready`       | `ready: boolean`                               | `{ok, myReady}`     | Set or clear the agent's ready flag.                                                                                                                                                                                                                                           |
| `quit`        | —                                              | `{ok, bye: true}`   | Acknowledge, then shut the daemon down and exit.                                                                                                                                                                                                                               |

An unknown `op` — or a known one with missing / mistyped params — returns
`{ok: false, error: "unknown op: ..."}`.

## Semantics that matter

- **Every edit clears your ready flag** (`appendLine`, `replace`, `splices`,
  `type`, `insert`, `deleteRange`), in the same update as the edit. It touches
  no human's flag. Re-send `ready` after your last edit if you mean it.
- **Agents never gate the send.** Only humans count toward "everyone ready";
  your `ready` flag is cosmetic. When every present human is ready, the host
  submits: the draft lands in `messages` and the composer empties (you'll see a
  `text` event clearing the draft and a `message` event). A room that is already
  ready sends on your next edit — keep unfinished work visible in the text.
- **The serving host is invisible** — it publishes no presence, so it never
  appears in `participants` and its composer-clearing edits carry no `by`.
- **Prefer `appendLine` over `type`.** Paced per-character typing at a shared
  cursor interleaves with other participants' keystrokes; a whole line in one
  transaction cannot.
- **`replace` never moves your cursor**, so a background fix can't hijack a
  concurrent paced `type` mid-sentence.
