---
name: muc-agent
description:
  Join a muc co-drafting session as an agent and drive it through the control
  API. Use when given a muc session code to join (a word-chain like
  wide-blue-cat-42), or when asked to co-draft, watch, or mend a shared muc
  draft.
---

# muc agent

Sit at the shared text box as a headless participant: join with a session code,
follow the room through the event feed, and edit over localhost HTTP. Every
endpoint, op, and event shape is in [`agent-protocol.md`](agent-protocol.md).
Read it before sending a `/cmd` you haven't used before.

## Join

1. Run [`scripts/start.sh`](scripts/start.sh)
   `<code> --handle System --descriptor "what you are and why you're here"` —
   the main (supervising) agent's seat is always named `System`; only delegated
   seats (see More hands) take other names. It launches the client in the
   background (a `muc` on PATH, else `npx` — the published package when it
   exists, the GitHub repo otherwise; a first npx run installs, so allow a
   couple of minutes) and prints two JSON lines: the client's
   `{"listening": <port>, ...}` handshake, then `{"pid": <pid>, "logs": <dir>}`
   — the pid stops it, the directory holds its stdout/stderr. The control API is
   `http://127.0.0.1:<port>`. A nonzero exit means the join failed and stderr
   says why — report it rather than retrying blindly.
2. `GET /state` for the draft, the participants, and the sent-message log. You
   are in the room when `/state` answers.

## Drive loop

Long-poll `GET /events?since=<seq>&wait=25000`, carrying each response's `seq`
into the next request. React to events; the held poll is your idle. If your
cursor falls behind the 500-event buffer, resync from `/state`.

Edit through `POST /cmd` with `{"op": ...}` JSON (op table in the reference),
e.g. `curl -s http://127.0.0.1:<port>/cmd -d '{"op":"appendLine","line":"hi"}'`.
The room's rules:

- **Reply where the conversation is.** The draft is a spatial document, not a
  chat transcript: answer a line adjacent to it — `replace` its tail with itself
  plus your reply, anchored with `after` — and save tail `appendLine` for
  genuinely new topics and announcements.
- **Prefer `appendLine` over `type`.** One atomic line cannot interleave with
  concurrent keystrokes; paced typing at a shared cursor can (CRDT soup).
- **Every edit clears your ready flag** — re-send `ready` after your last edit
  if you mean it. The flag is cosmetic either way: only humans gate the send.
- The host submits when every human is ready: the composer empties and the draft
  lands in `messages`. That is the sent signal, not something you do.
- **Claim long work in the text.** Agents never gate the send, so the draft can
  ship at any moment — expanding a TODO or rewriting a span, first replace the
  span with a visible claim (`⟨scribe: expanding this…⟩`), then swap in the
  result when done. The draft then always states its own state: humans see
  unfinished work and hold their ✓, and a message sent anyway carries the marker
  instead of silently missing work.
- **A `message` event mid-task means the draft you were editing is gone.** Stop,
  re-read `/state`, and re-decide — finishing the old task writes orphan text
  into the next, empty draft.

## More hands

One `muc agent` process is one participant. The agent reading this file is the
supervisor: its own seat is named **System** (`--handle System`, a
`--descriptor` saying what it's supervising). To put more personas at the box,
run `scripts/start.sh` once per job — each with its own `--handle`, a
`--descriptor` naming the job (that note is what the humans in the room see),
and its own port from its own handshake — then delegate each port to its own
subagent, briefing it with the job, the port, and this file's rules. Never point
two drivers at one port: the daemon serializes ops, but two writers steering one
cursor still fight.

Jobs that earn a seat of their own:

- **Drafter** — contributes and revises content on request.
- **Mender** — whenever agents draft, also seat one mender on the smallest
  capable model; its whole job is the next section.
- **Watcher** — follows the feed and reports elsewhere; never writes.

Quit each client the moment its job ends — a seat with no job is noise in the
room.

## Mending

In the room to repair rather than draft? Stay silent: no drafting, no chatter,
no ready flag. Watch `text` events, use their `by` attribution to decompose an
interleaved braid into one clean line per writer with targeted `replace` ops.
**Coherence is the test, not authorship**: text that reads as someone's intent
stays, whoever typed which character — one person fixing a typo inside another's
sentence is collaboration, not soup. Repair only text no one could have meant,
and when the strands aren't confidently separable, leave the text alone. Never
destroy anyone's words.

Tactics:

- **Ledger from the door.** Record every `text` event's `edits` (deltas plus
  `by`) from the moment you join — that running note is your map of who typed
  which character. It cannot be rebuilt later: compacted backlog merges writers,
  so attribution only exists if you were watching.
- **Repair in a quiet window.** Wait until the braided span has stopped
  changing; racing live typists makes more soup. Hold off entirely while every
  human is ready — a send is imminent, and a late repair lands as graffiti in
  the emptied composer.
- **One attempt, atomically.** A single anchored `replace` (or one `splices`
  batch) per braid, then re-read `/state` to confirm it landed as intended. If a
  human edits your repair afterward, theirs stands — never re-repair.

## Leave

`POST /cmd {"op":"quit"}` — or signal the pid from the handshake; both drop
presence and exit cleanly. A killed process ages out of the room on its own, but
quitting is politer.
