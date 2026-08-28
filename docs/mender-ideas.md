# Mender ideas

Where the mender could go next. The layering argument — decomposition is
mechanical, judgment is linguistic — lives in
[`design-notes.md`](./design-notes.md) (section 3); today's practice lives in
the muc-agent skill's [`mender.md`](../.claude/skills/muc-agent/mender.md), and
a subagent brute-forces all of it with no new code: it keeps the attribution
ledger as notes, waits for quiet, and repairs with the ops that already exist.
Everything below needs code, and each idea shrinks what the brute-force subagent
has to carry.

## A daemon-served authorship view

The daemon already sees every delta with its `by`; it could maintain the shadow
attribution map itself and serve it — `GET /attribution` returning the current
text as runs tagged by author, or authorship tags folded into each `text` event.
The mender then stops keeping a ledger at all (and stops being vulnerable to the
500-event buffer): any seat, joining at any time, could read who typed what for
the whole retained history the daemon has watched. This is the single
highest-leverage piece — it converts the mender's hardest bookkeeping into a
lookup.

## A decomposer that ships with the skill

Between "the model does string surgery" and "the daemon does attribution" sits a
script in the skill folder: feed it the ledger (or the authorship view) and a
span, get back one clean string per writer plus the `splices` batch that would
install the repair. The model then only answers the coherence question and picks
where the lines go — the fix itself is computed, not composed.

## A braid detector

Reading every text event with a model is the expensive loop. A cheap heuristic
can gate it: alternating-author runs shorter than a word inside one span, within
a short window, is a braid signature; long single-author runs never are. Code
flags candidate spans, the model reads only those. This is what makes the
smallest-capable-model guidance real — the model wakes rarely and reads little.

## Marked mender seats

One mender per room is a supervisor convention today ("never point two drivers
at one port" doesn't stop two supervisors each seating one). A convention in
presence — a descriptor form, or a `role` note beside `kind` — would let a
joining mender see an incumbent and stand down, the same way the server's
presence-less seat is a protocol fact rather than good manners.

## Repair receipts

The mender is silent in the room, but it shouldn't be silent to its operator: a
log line per repair (span, writers, before/after, the op it sent) into the logs
directory the launch script already prints. Cheap auditability for the day a
repair goes wrong — and the training data for deciding whether the braid
detector's thresholds are right.
