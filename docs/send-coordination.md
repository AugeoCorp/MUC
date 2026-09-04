# Send coordination: ready humans, working agents

How the send should treat an agent that is mid-task. Today the rule is blunt:
only humans gate the quorum, and an agent's edit withdraws every human's ready
flag in the same update as the edit (ready flags live in the doc for exactly
this). An all-ready room therefore never ships on an agent's edit; the humans
re-approve the text as it now stands. Two edges remain. Humans can re-ready and
send while the agent is still working, with nothing in the room saying so — a
drafter expanding a `TODO` can have half its expansion sent and the rest land in
the emptied composer as orphan text. And an agent that edits in a stream (a
paced `type`, a repair in several ops) pulls the room's ✓ down on every edit, so
the humans can't stay ready until it is done and nothing tells them how long
that is.

The invariant to preserve while fixing this: **an agent must never hold a
human's message hostage.** A hung subagent, a crashed process, a slow model —
any design where an agent carries an indefinite veto deadlocks the room on a
robot. Every mechanism below is a pause a human can see past, never a lock.

## Two scales of "working"

- **Op-scale** (seconds): the daemon's queue is draining, a paced `type` is
  mid-flight. Mechanical, no judgment involved, bounded by construction.
- **Task-scale** (seconds to minutes): expanding a `TODO`, rewriting a section,
  a mender computing a repair. Open-ended, can fail, needs human judgment about
  whether it's worth waiting for.

The scales get different treatments: ops finish automatically; tasks finish
because informed humans choose to wait.

## Op-scale: busy in presence, a bounded grace

The daemon knows when it is mid-work without any cooperation from the agent
driving it: its op queue is non-empty, or a `type` is between characters. It
publishes that as a `busy` field in awareness. An explicit `busy` op lets the
driving agent extend the signal over "thinking" spans between commands.

When the human quorum passes, the host defers the submit while any agent is busy
— up to a hard cap (a few seconds, enough to drain a queue, never enough to feel
held). Cap expired, it sends regardless. Deadlock is impossible by construction,
and the second edge above softens: a busy agent's stream of edits can stop
withdrawing flags mid-sequence, because the room already knows to wait, and the
✓s hold until the queue drains or the cap expires.

The legend shows the pause (`⋯` beside the ◆) so the wait reads as the room
being considerate, not broken.

## Task-scale: the text carries the state, humans carry the decision

No protocol gate. Instead:

- **Claim markers** (a skill rule today): before a long edit, the agent replaces
  the span with a visible claim — `⟨scribe: expanding this…⟩` — and swaps in the
  result when done. The draft always states its own state: humans reading it see
  unfinished work and hold their ✓, and a message sent anyway carries the marker
  rather than silently missing work.
- **Confirm past the pause**: when the quorum passes while an agent is busy
  (explicit task-scale busy, or a claim marker the host can spot in the text),
  the serve screen asks rather than waits — "scribe is still working — send
  anyway?" The override is a human action; the agent never holds the key.
- **Abort on send** (a skill rule today): a `message` event mid-task means the
  draft being edited is gone; the agent stops, re-reads `/state`, and re-decides
  instead of finishing into the next, empty draft.

## Non-goals

- No agent veto, at either scale — the cap and the confirm keep every pause
  breakable by humans.
- No per-agent quorum opt-in (`--gates-ready`): more machinery than the grace
  window plus claim markers cover, and it breaks the clean reading that a ✓ is a
  human judgment.

## Open questions

- The grace cap's length — long enough for a `splices` repair, short enough that
  a human never wonders if the room is stuck. Something under ten seconds;
  measure real queues first.
- Where `busy` lives: in the awareness state, not the doc. `ready` moved into
  the doc so it travels with the edit that withdraws it; `busy` is transient
  presence with no such coupling, and awareness (which drops it when the client
  does) is the right home.
- Whether the host should parse claim markers out of the text for the confirm
  prompt, or rely only on explicit busy — parsing text couples the host to a
  convention; explicit busy misses an agent that forgot to signal.
- What the confirm looks like on the serve screen, which currently has no input
  beyond `⌃c`.
