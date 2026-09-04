# System

The supervising seat's job: start your own client, and seat whatever other NPCs
the work needs. Everything about driving a seat once you hold a port — the drive
loop, the room's rules, leaving — is [`SKILL.md`](SKILL.md), and applies to your
seat like every other.

## Start your client

Run [`scripts/start.sh`](scripts/start.sh)
`<code> --handle System --descriptor "what you are and why you're here"`. The
supervising seat is always named `System`; delegated seats take their job's
name.

It launches the client in the background (a `muc` on PATH, else `npx` — the
published package when it exists, the GitHub repo otherwise; a first npx run
installs, so allow a couple of minutes) and prints two JSON lines: the client's
`{"listening": <port>, ...}` handshake, then `{"pid": <pid>, "logs": <dir>}` —
the pid stops it, the directory holds its stdout/stderr. The control API is
`http://127.0.0.1:<port>`. A nonzero exit means the join failed and stderr says
why — report it rather than retrying blindly.

Then pick up the drive loop in [`SKILL.md`](SKILL.md).

## More NPCs

One `muc agent` process is one participant. To put more NPCs at the box, run
`scripts/start.sh` once per job — each with its own `--handle`, a `--descriptor`
naming the job (that note is what the humans in the room see), and its own port
from its own handshake. Delegate each port to its own subagent, and brief it
with the job, the port, and [`SKILL.md`](SKILL.md), plus the job's own file if
it has one. A delegated NPC never runs this file: you already started its
client, so one that launches its own seats a duplicate.

One port, one driver: the daemon serializes ops, but two writers steering one
cursor still fight.

Three jobs come up often enough to have files:

- **Drafter** — contributes and revises content on request:
  [`drafter.md`](drafter.md).
- **Mender** — whenever agents draft, also seat one mender on the smallest
  capable model: [`mender.md`](mender.md).
- **Watcher** — follows the feed and reports elsewhere; never writes:
  [`watcher.md`](watcher.md).

Any other job takes a seat the same way: a fact-checker, a translator, a domain
reviewer, whatever this session actually needs. It lives in the brief you write.
A brief should let the NPC work out the specifics itself: what it is for,
whether it may write, and what finishing looks like. An NPC with no completion
criterion never quits its seat. Name it the same way: a `--handle` that is the
job, a `--descriptor` telling the humans why it is in the room.

A job you keep seating outgrows the brief. Give it a file of its own beside this
one, named for the NPC rather than the activity — `mender.md`,
`fact-checker.md`, `npc-fixer.md` — and hand it over with `SKILL.md`.

Seat a job when the room should see it working — it runs while you do something
else, or its output belongs in the draft under its own name. Work you would
finish before anyone looked up needs no seat; do it from yours.

Quit each client the moment its job ends — a seat with no job is noise in the
room.
