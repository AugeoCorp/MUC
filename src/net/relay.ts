// A message log with two endpoints. The host runs one of these locally; a
// Cloudflare tunnel exposes it publicly (see tunnel.ts). Clients POST to /send
// to append a message and GET /messages?since=N to pull everything newer than
// their cursor. We deliberately avoid a long-lived server→client stream:
// Cloudflare's quick tunnel won't reliably forward one, so clients short-poll
// over plain request/response instead. Everyone connected shares one common
// space, and the log doubles as history for whoever joins late.
//
// The log is compacted so it doesn't grow without bound. The relay peeks at
// each frame just enough to sort it into one of three kinds:
//
// - Document frames ({t:"u"}, base64 Yjs updates) accumulate until
//   DOCUMENT_COMPACTION_THRESHOLD of them are retained, then every run of
//   consecutive document frames collapses into one via Y.mergeUpdates — Yjs
//   updates are idempotent and commutative under merge, so replaying the
//   merged frame is equivalent to replaying the originals. Only consecutive
//   frames merge, so a frame of another kind sitting between two document
//   frames stays between them: the order a client replays is the order things
//   happened, which the session relies on when a flag and an edit meet.
// - Awareness frames ({t:"a"}, presence/cursors) are only retained for
//   AWARENESS_RETENTION_MILLISECONDS. Live clients re-announce themselves
//   every ~15 seconds, so recent frames fully describe who is present; stale
//   ones only replay ghosts of participants who already left.
// - Anything else is opaque: retained forever and never touched, exactly as
//   the pre-compaction relay treated every frame.
//
// Cursors survive compaction because they are sequence numbers, not array
// indexes: every accepted frame gets the next sequence, a merged document
// frame carries the sequence of the LAST frame it absorbed, and `since=N`
// returns every retained frame with sequence > N. A client whose cursor falls
// inside an absorbed run receives the whole merged frame — harmlessly
// redundant for Yjs.
//
// While people are typing, a cursor frame follows every keystroke, so runs
// stay short and little merges; once those awareness frames age out, the
// document frames they separated become one run and collapse. Bounded, just
// later.

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import * as Y from "yjs";
import { fromBase64, toBase64 } from "../utilities/base64.ts";
import { listen } from "../utilities/listen.ts";
import { parseNonNegativeInteger } from "../utilities/parseNonNegativeInteger.ts";
import { BodyTooLargeError, readBody } from "../utilities/readBody.ts";

export interface Relay {
	port: number;
	close(): Promise<void>;
}

// Collapse retained document frames into one once this many accumulate. At
// typing speed a frame is a keystroke, so 50 keeps the merge frequent enough
// that a late joiner replays at most ~50 document frames, while each merge
// still batches enough work to be worth doing.
export const DOCUMENT_COMPACTION_THRESHOLD = 50;

// How long an awareness frame stays replayable. Live clients re-broadcast
// presence roughly every 15 seconds, so 90 seconds (six keepalives) tolerates
// a flaky tunnel without ever dropping a live participant, while a departed
// one ages out of the replay instead of haunting late joiners.
export const AWARENESS_RETENTION_MILLISECONDS = 90_000;

interface LogEntry {
	/** Position in the global frame order; a client cursor is one of these. */
	sequence: number;
	kind: "document" | "awareness" | "opaque";
	/** The frame exactly as posted (or, for a merged entry, re-encoded). */
	body: string;
	/** When the frame arrived — awareness entries age out by this. */
	receivedAt: number;
}

interface RelayLog {
	entries: LogEntry[];
	/** Highest sequence ever assigned; survives entries being compacted away. */
	lastSequence: number;
}

export function startRelay(): Promise<Relay> {
	const log: RelayLog = { entries: [], lastSequence: 0 };

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");

		if (request.method === "GET" && url.pathname === "/messages") {
			pruneStaleAwareness(log, Date.now());
			const cursor = parseNonNegativeInteger(url.searchParams.get("since"));
			const body = JSON.stringify({
				cursor: log.lastSequence,
				items: log.entries
					.filter((entry) => entry.sequence > cursor)
					.map((entry) => entry.body),
			});
			response.writeHead(200, {
				"content-type": "application/json",
				"cache-control": "no-cache",
			});
			response.end(body);
			return;
		}
		if (request.method === "POST" && url.pathname === "/send") {
			// A client behind a flaky tunnel can abort mid-body; that rejection
			// must be caught here or it takes the whole relay down with it.
			append(log, request, response).catch((error) => {
				if (!response.headersSent) {
					response.writeHead(error instanceof BodyTooLargeError ? 413 : 400);
				}
				// The status has to leave before the socket does.
				response.end(() => request.destroy());
			});
			return;
		}
		response.writeHead(404).end();
	});

	return listen(server, 0);
}

async function append(
	log: RelayLog,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const body = await readBody(request);
	if (body.trim() !== "") {
		const now = Date.now();
		log.lastSequence += 1;
		log.entries.push({
			sequence: log.lastSequence,
			kind: classifyFrame(body),
			body,
			receivedAt: now,
		});
		// Pruning first: an awareness frame that just aged out may have been the
		// only thing keeping two document runs apart.
		pruneStaleAwareness(log, now);
		compactDocumentFrames(log);
	}
	response.writeHead(204).end();
}

function classifyFrame(body: string): LogEntry["kind"] {
	try {
		const frame = JSON.parse(body) as { t?: unknown; d?: unknown };
		if (frame === null || typeof frame !== "object") return "opaque";
		if (typeof frame.d !== "string") return "opaque";
		if (frame.t === "u") {
			// Prove the payload is a decodable Yjs update now, so merging it
			// during compaction can never throw. A frame that fails stays opaque.
			// (Y.mergeUpdates on a single update returns it undecoded, so a real
			// decode is the only honest check.)
			Y.decodeUpdate(fromBase64(frame.d));
			return "document";
		}
		if (frame.t === "a") return "awareness";
		return "opaque";
	} catch {
		return "opaque";
	}
}

// Replace each run of consecutive document frames with its single merged
// equivalent, in place. A merged entry takes the sequence and position of the
// last frame it absorbed, so the log stays in arrival order by construction.
function compactDocumentFrames(log: RelayLog): void {
	const documentCount = log.entries.filter(
		(entry) => entry.kind === "document",
	).length;
	if (documentCount < DOCUMENT_COMPACTION_THRESHOLD) return;

	const runs = log.entries.reduce<LogEntry[][]>((groups, entry) => {
		const current = groups[groups.length - 1];
		if (entry.kind === "document" && current?.[0]?.kind === "document") {
			current.push(entry);
		} else {
			groups.push([entry]);
		}
		return groups;
	}, []);
	log.entries = runs.flatMap((run) => {
		if (run.length < 2) return run;
		const merged = mergeRun(run);
		return merged === undefined ? run : [merged];
	});
}

function mergeRun(run: LogEntry[]): LogEntry | undefined {
	const updates = run.map((entry) => {
		const frame = JSON.parse(entry.body) as { d: string };
		return fromBase64(frame.d);
	});
	// Every update was decode-checked on ingest, so the merge shouldn't throw —
	// but an uncompacted run beats a crashed relay, so leave it be if it does.
	let mergedUpdate: Uint8Array;
	try {
		mergedUpdate = Y.mergeUpdates(updates);
	} catch {
		return undefined;
	}
	const lastAbsorbed = run[run.length - 1];
	return {
		sequence: lastAbsorbed.sequence,
		kind: "document",
		body: JSON.stringify({ t: "u", d: toBase64(mergedUpdate) }),
		receivedAt: lastAbsorbed.receivedAt,
	};
}

function pruneStaleAwareness(log: RelayLog, now: number): void {
	const cutoff = now - AWARENESS_RETENTION_MILLISECONDS;
	log.entries = log.entries.filter(
		(entry) => entry.kind !== "awareness" || entry.receivedAt >= cutoff,
	);
}
