# Design notes: the channel contract and trust boundaries

Two structural gaps noted while reviewing the agent client (PR #2). Neither
blocks current use; both are worth one deliberate fix each rather than a patch
per symptom.

## 1. The `Channel` contract is thinner than its implementations

`Channel` (`src/net/channel.ts`) exposes a fire-and-forget `post` and a
`subscribe`. The tunnel implementation knows more than the interface admits: its
POST is a fetch with a completion, and its poll loop knows when it has drained
the relay's backlog. Discarding that knowledge causes three symptoms that are
patched separately today:

- **The agent startup sync window.** `muc agent` prints its `{"listening": ...}`
  handshake before the first backlog sync (~800 ms), so `/state` can answer `""`
  while the room holds a draft, and an instant edit merges ahead of text it
  never saw.
- **The 300 ms teardown sleeps** in `src/cli.tsx`: the departure frame is
  flushed by hoping a beat is enough, because `post()` reports nothing back.
- **Ghost seats.** When that hope is wrong, a departed participant haunts the
  room until awareness ages it out (~90 s).

Proposed shape: `post` returns a promise that settles on delivery, and the
channel exposes a caught-up signal (one promise for "the backlog you joined into
has been drained"). The CLI then withholds the agent handshake until caught up —
agents cannot act early by construction — and teardown awaits delivery instead
of sleeping. Any future transport (the original peer-to-peer goal) implements
the same, richer contract at the same seam.

## 2. Trust boundaries assume a friendly network

Two adjacent gaps with one theme: the prototype assumed everyone nearby is
friendly.

- **The agent control API is unauthenticated.** `src/agent/daemon.ts` serves
  plain localhost HTTP with no token and no `Origin` check. A web page open in
  the operator's browser can `POST` to `127.0.0.1:<port>/cmd` as a CORS "simple
  request" — no preflight blocks it — so a malicious page can scan local ports
  and drive the agent's seat: read the draft, inject edits, quit the client.
  Cheap fix: issue a bearer token in the handshake line, require it on every
  request, and reject any request that carries a browser `Origin` header. The
  muc-agent skill and `agent-protocol.md` then each need a one-line update
  naming the header.
- **The relay reads unbounded bodies from a public URL.** `src/net/relay.ts` is
  exposed through the Cloudflare tunnel, and its `readBody` accumulates request
  bodies without a size cap — anyone holding the session code (or guessing the
  subdomain) can stream an arbitrarily large `POST /send` and exhaust the host's
  memory. Cheap fix: cap `/send` bodies and drop oversized requests early. A
  legitimate frame is a keystroke or a merged update, so even a generous cap is
  small.

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
