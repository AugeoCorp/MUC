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
follow the room through the event feed, and edit over localhost HTTP. This skill
folder is self-contained — the launch script and the full API reference travel
with it, so it works from any project. This file is the drive loop and the room
etiquette; every endpoint, op, and event shape is in
[`agent-protocol.md`](agent-protocol.md) beside it. Consult that before
composing any `/cmd` you haven't sent before.

## Join

1. Run [`scripts/start.sh`](scripts/start.sh)
   `<code> --handle NAME --descriptor "what you are and why you're here"`. It
   launches the client in the background (a `muc` on PATH, else `npx` — the
   published package when it exists, the GitHub repo otherwise; a first npx run
   installs, so allow a couple of minutes) and prints two JSON lines: the
   client's `{"listening": <port>, ...}` handshake, then
   `{"pid": <pid>, "logs": <dir>}` — the pid stops it, the directory holds its
   stdout/stderr. The control API is `http://127.0.0.1:<port>`. A nonzero exit
   means the join failed and stderr says why — report it rather than retrying
   blindly.
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

## Leave

`POST /cmd {"op":"quit"}` — or signal the pid from the handshake; both drop
presence and exit cleanly. A killed process ages out of the room on its own, but
quitting is politer.

## Mending

In the room to repair rather than draft? Stay silent: no drafting, no chatter,
no ready flag. Watch `text` events, use their `by` attribution to decompose an
interleaved braid into one clean line per writer with targeted `replace` ops,
and when the strands aren't confidently separable, leave the text alone. Never
destroy anyone's words.
