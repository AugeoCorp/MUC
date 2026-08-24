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
//   DOCUMENT_COMPACTION_THRESHOLD of them are retained, then collapse into a
//   single frame via Y.mergeUpdates — Yjs updates are idempotent and
//   commutative under merge, so replaying the merged frame is equivalent to
//   replaying the originals.
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

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";
import * as Y from "yjs";

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
			const since = Number(url.searchParams.get("since"));
			const cursor = Number.isInteger(since) && since > 0 ? since : 0;
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
			void append(log, request, response);
			return;
		}
		response.writeHead(404).end();
	});

	return new Promise((resolve) => {
		server.listen(0, () => {
			const address = server.address();
			const port =
				typeof address === "object" && address !== null ? address.port : 0;
			resolve({
				port,
				close() {
					return new Promise((done) => server.close(() => done()));
				},
			});
		});
	});
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
		compactDocumentFrames(log);
		pruneStaleAwareness(log, now);
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

// Replace every retained document frame with their single merged equivalent.
// The merged entry takes the sequence of the last frame it absorbed and slots
// into the log where that frame sat, keeping entries ordered by sequence.
function compactDocumentFrames(log: RelayLog): void {
	const documents = log.entries.filter((entry) => entry.kind === "document");
	if (documents.length < DOCUMENT_COMPACTION_THRESHOLD) return;

	const updates = documents.map((entry) => {
		const frame = JSON.parse(entry.body) as { d: string };
		return fromBase64(frame.d);
	});
	// Every update was decode-checked on ingest, so the merge shouldn't throw —
	// but an uncompacted log beats a crashed relay, so bail if it does.
	let mergedUpdate: Uint8Array;
	try {
		mergedUpdate = Y.mergeUpdates(updates);
	} catch {
		return;
	}
	const lastAbsorbed = documents[documents.length - 1];
	const merged: LogEntry = {
		sequence: lastAbsorbed.sequence,
		kind: "document",
		body: JSON.stringify({ t: "u", d: toBase64(mergedUpdate) }),
		receivedAt: lastAbsorbed.receivedAt,
	};

	const retained = log.entries.filter((entry) => entry.kind !== "document");
	const insertIndex = retained.findIndex(
		(entry) => entry.sequence > merged.sequence,
	);
	if (insertIndex === -1) retained.push(merged);
	else retained.splice(insertIndex, 0, merged);
	log.entries = retained;
}

function pruneStaleAwareness(log: RelayLog, now: number): void {
	const cutoff = now - AWARENESS_RETENTION_MILLISECONDS;
	log.entries = log.entries.filter(
		(entry) => entry.kind !== "awareness" || entry.receivedAt >= cutoff,
	);
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		request.on("data", (chunk) => {
			data += chunk;
		});
		request.on("end", () => resolve(data));
		request.on("error", reject);
	});
}

const toBase64 = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString("base64");
const fromBase64 = (text: string): Uint8Array =>
	new Uint8Array(Buffer.from(text, "base64"));
