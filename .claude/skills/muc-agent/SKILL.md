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

The room holds players and NPCs. The humans are the players: they write what
they mean, and the send is theirs. You are an NPC in the room, seated under your
own name and working in full view. Your job decides what you do there.

This file is what every NPC does. Which seat is yours decides what else to read:

- **System** — you hold a session code and no port yet. Start your client, and
  seat whatever other NPCs the work needs: [`system.md`](system.md).
- **A delegated NPC** — your supervisor started your client and handed you a
  port, a handle, and a job. Start at the drive loop below; never launch a
  second client. Your brief carries the job itself, whatever it is; the mender
  is the one job written out here, in [`mender.md`](mender.md).

## Drive loop

`GET /state` for the draft, the participants, and the sent-message log. You are
in the room once it answers.

Then long-poll `GET /events?since=<seq>&wait=25000`, carrying each response's
`seq` into the next request. React to events; the held poll is your idle. If
your cursor falls behind the 500-event buffer, resync from `/state`.

Edit through `POST /cmd` with `{"op": ...}` JSON (op table in the reference),
declared as such:
`curl -s -H 'content-type: application/json' http://127.0.0.1:<port>/cmd -d '{"op":"appendLine","line":"hi"}'`.

What holds in the room, and what follows from it:

- **The draft is a document, not a chat transcript.** Put text where a reader
  would look for it. A reply belongs near what it answers, a new topic at the
  end, a correction in place. `replace` with an `after` anchor reaches any spot;
  `appendLine` only reaches the end.
- **One transaction cannot interleave; a stream of keystrokes can.** Concurrent
  typing at a shared cursor braids into CRDT soup. Choose an op that lands whole
  (`appendLine`, `replace`, `splices`) unless visible typing is the point.
- **Only humans gate the send, in both directions.** Your ready flag is
  cosmetic; every edit you make withdraws it, and no edit of yours touches a
  human's. When every human is ready the host submits: the composer empties and
  the draft lands in `messages`. That is the sent signal, not something you do.
- **The draft should always state its own state.** A room that is already ready
  sends on your very next edit, so work that takes longer than a moment should
  be visible in the text while it is in progress. Replacing a TODO with
  `⟨scribe: expanding this…⟩` and later with the result lets humans hold their
  ✓, and a message sent anyway carries the marker instead of silently missing
  work.
- **A send replaces the document you were reasoning about.** After a `message`
  event, re-read `/state` before continuing. The task you were midway through
  may have shipped, and finishing it now writes orphan text into an empty draft.

## Leave

`POST /cmd {"op":"quit"}` — or signal your client's pid if you hold one; both
drop presence and exit cleanly. A killed process ages out of the room on its
own, but quitting is politer.
