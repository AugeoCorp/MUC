# System

The supervising seat. Your primary job is to delegate rather than to write: see
what the draft needs, seat an NPC for it, and keep the room's record of who did
what. Everything about driving a seat once you hold a port (the drive loop, the
room's rules, leaving) is [`SKILL.md`](SKILL.md), and applies to your seat like
every other.

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

## Seat NPCs

One `muc agent` process is one participant. Each NPC gets its own client from
`scripts/start.sh`, with a `--handle` that is its job, a `--descriptor` telling
the humans why it is in the room, and its own port from its own handshake.
Delegate that port to its own subagent, briefed with the job, the port, and
[`SKILL.md`](SKILL.md). A delegated NPC never runs this file: you already
started its client, so one that launches its own seats a duplicate.

One port, one driver: the daemon serializes ops, but two writers steering one
cursor still fight.

NPCs emerge from what the session needs, not from a fixed cast. A TODO that
wants expanding, a claim that wants checking, a passage in the wrong language:
each is a job, and a job is a seat when the room should see it working. It runs
while you do something else, or its output belongs in the draft under its own
name. Work you would finish before anyone looked up needs no seat; do it from
yours.

A brief should let the NPC work out the specifics itself: what it is for,
whether it may write, and what finishing looks like. An NPC with no completion
criterion never quits its seat.

The one NPC with a file of its own is the mender. Whenever agents draft, also
seat one, on the smallest capable model, and hand it [`mender.md`](mender.md)
with `SKILL.md`. A job you keep seating outgrows its brief the same way; give it
a file beside this one, named for the NPC rather than the activity (`mender.md`,
`fact-checker.md`, `npc-fixer.md`).

Quit each client the moment its job ends; a seat with no job is noise in the
room.

## Keep the cast list

At the end of the draft, keep a list of the NPCs that contributed to it: the
name, then two short sentences, what it was seated to do and what it ended up
doing. Update it as seats come and go. It ships with the message, so whoever
reads the message knows who worked on it and how far the work drifted from the
brief.
