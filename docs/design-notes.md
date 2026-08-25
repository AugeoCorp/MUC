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

Do the token before publishing `@augeo/muc`; the rest can follow on their own
schedule.
