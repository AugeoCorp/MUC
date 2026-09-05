# Design notes: the channel contract and trust boundaries

Two structural gaps noted while reviewing the agent client (PR #2). Its third
review pass closed most of the symptoms; what remains of each is recorded here
so the fix is one deliberate change rather than a patch per symptom.

## 1. The `Channel` contract is thinner than its implementations

`Channel` (`src/net/channel.ts`) exposes `post` and `subscribe`. The tunnel
implementation knows more than the interface admits: its poll loop knows when it
has drained the relay's backlog, and the interface discards that.

Two of the three symptoms are gone. `post` now returns a promise, frames leave
one at a time in posted order, and `disconnect()` resolves once the last one is
out — so the 300 ms teardown sleeps in `src/cli.tsx` and the ghost seats they
sometimes left behind are history. The one that remains:

- **The agent startup sync window.** `muc agent` prints its `{"listening": ...}`
  handshake before the first backlog sync (~800 ms), so `/state` can answer `""`
  while the room holds a draft, and an instant edit merges ahead of text it
  never saw.

Proposed shape: the channel exposes a caught-up signal (one promise for "the
backlog you joined into has been drained"). The CLI then withholds the agent
handshake until caught up — agents cannot act early by construction. Any future
transport (the original peer-to-peer goal) implements the same, richer contract
at the same seam.

## 2. Trust boundaries assume a friendly network

Two adjacent gaps with one theme: the prototype assumed everyone nearby is
friendly. Both got their cheap fix in PR #2's third pass; what each fix does and
doesn't cover:

- **The agent control API is unauthenticated.** `src/agent/daemon.ts` serves
  plain localhost HTTP with no token. The browser hole is closed: `/cmd` now
  requires `content-type: application/json`, which turns a page's `fetch` into a
  preflighted request that no CORS headers will pass, so a malicious page can no
  longer drive the seat. What it doesn't cover is another process on the same
  machine — any local user can still `curl` the port. If muc ever runs on shared
  hosts, the next step is a bearer token issued in the handshake line and
  required on every request; the skill and `agent-protocol.md` would then each
  need a one-line update naming the header.
- **The relay reads unbounded bodies from a public URL.** `src/net/relay.ts` is
  exposed through the Cloudflare tunnel. `readBody` (shared by both servers) now
  caps bodies at 1 MiB, destroys the request past it, and the caller answers 413
  — a legitimate frame is a keystroke or a merged update, so the cap is
  generous. Still open: nothing rate-limits a flood of small frames, and anyone
  holding the session code can post them.

## 3. The mender is two layers, and only one needs a model

An earlier review instinct — that a mender can't reliably repair humans typing
over each other — was wrong, and the correction shapes where mending code should
live. A CRDT never reorders one author's own characters, so a braid is a
shuffle-merge of intact per-author subsequences; a mender that follows the event
feed from before the braid can maintain a shadow copy of the text with every
character tagged by its edit's `by`, and decomposing the braid into each
writer's exact string is then mechanical, not inference. (Delete-only edits
carry no `by`, and don't need one — a positional delete updates the shadow
regardless of who made it.)

What the model is actually for is the judgment layer: braided authorship and
deliberate collaboration look identical in the stream. One person fixing a typo
inside another's sentence embeds their characters mid-run exactly like soup
does; the difference is linguistic — the result reads as someone's intent. Hence
the skill's mending rule: coherent text stays whoever typed it, and only text no
one could have meant gets decomposed.

Two implications. The deterministic layer could move into code — the daemon
could serve a per-character authorship view over the feed (a shadow model it
already has the events for), shrinking any mender to the coherence judgment
alone and making the smallest-capable-model guidance even more right. And the
mender's power depends on continuous presence: attribution can't be
reconstructed from compacted backlog (merged frames carry many writers, so `by`
resolves to nothing), which is the real argument for seating the mender from the
start rather than summoning one after soup appears.

---

Do the token before publishing `@augeo/muc`; the rest can follow on their own
schedule.
