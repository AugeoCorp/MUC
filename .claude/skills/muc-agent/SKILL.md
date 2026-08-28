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

This file is what every seat does. Which seat is yours decides what else to
read:

- **System** — you hold a session code and no port yet. Start your client, and
  seat any other hands the work needs: [`supervising.md`](supervising.md).
- **A delegated hand** — your supervisor started your client and handed you a
  port, a handle, and a job. Start at the drive loop below; never launch a
  second client. If your job is mending, it is [`mending.md`](mending.md).

## Drive loop

`GET /state` for the draft, the participants, and the sent-message log — you are
in the room once it answers.

Then long-poll `GET /events?since=<seq>&wait=25000`, carrying each response's
`seq` into the next request. React to events; the held poll is your idle. If
your cursor falls behind the 500-event buffer, resync from `/state`.

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

## Leave

`POST /cmd {"op":"quit"}` — or signal your client's pid if you hold one; both
drop presence and exit cleanly. A killed process ages out of the room on its
own, but quitting is politer.
