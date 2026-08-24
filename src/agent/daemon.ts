// The agent-facing head of a collab session: a localhost HTTP control API plus
// a sequenced event feed. An agent drives its participant entirely through
// this surface — no terminal, no Ink.
//
//   GET  /state             → snapshot: text, cursors, ready flags, messages
//   GET  /events?since=N    → events after seq N; ?wait=MS long-polls
//   POST /cmd               → {op: ...} edit/cursor/ready/quit, serialized
//
// Commands run through a queue so a paced `type` can't interleave with a
// concurrent `replace` from another caller — the first swarm session shredded
// text exactly that way.

import { createServer, type IncomingMessage } from "node:http";
import type * as Y from "yjs";
import {
	type CollabSession,
	NETWORK_ORIGIN,
	type RemoteCursor,
} from "../collab/session.ts";
import {
	appendLine,
	applySplices,
	deleteRange,
	insertAtCursor,
	moveCursor,
	replaceText,
	type Splice,
	typeText,
} from "./operations.ts";

export interface AgentDaemon {
	port: number;
	close(): Promise<void>;
}

export interface AgentDaemonOptions {
	/** Port to listen on; 0 (the default) picks an ephemeral port. */
	port?: number;
	/** Called after a `quit` command has been acknowledged. */
	onQuit?: () => void;
}

interface AgentEvent {
	seq: number;
	ts: string;
	type: "text" | "roster" | "message";
	[key: string]: unknown;
}

const EVENT_BUFFER_LIMIT = 500;
const TEXT_COALESCE_MS = 300;
const LONG_POLL_LIMIT_MS = 30_000;

export function startAgentDaemon(
	session: CollabSession,
	options: AgentDaemonOptions = {},
): Promise<AgentDaemon> {
	// --- Event feed -----------------------------------------------------------
	const events: AgentEvent[] = [];
	let nextSeq = 1;
	const waiters = new Set<() => void>();

	function emit(type: AgentEvent["type"], payload: object): void {
		events.push({
			seq: nextSeq++,
			ts: new Date().toISOString(),
			type,
			...payload,
		});
		if (events.length > EVENT_BUFFER_LIMIT) {
			events.splice(0, events.length - EVENT_BUFFER_LIMIT);
		}
		waiters.forEach((wake) => wake());
		waiters.clear();
	}

	function eventsSince(seq: number): AgentEvent[] {
		return events.filter((event) => event.seq > seq);
	}

	// Text changes: coalesce bursts (remote typing arrives keystroke-by-
	// keystroke) into one event per window, keeping every delta.
	let pendingEdits: Array<{ origin: "local" | "remote"; delta: unknown }> = [];
	let textTimer: NodeJS.Timeout | undefined;
	const onText = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
		pendingEdits.push({
			origin: transaction.origin === NETWORK_ORIGIN ? "remote" : "local",
			delta: event.changes.delta,
		});
		if (textTimer === undefined) {
			textTimer = setTimeout(() => {
				textTimer = undefined;
				const edits = pendingEdits;
				pendingEdits = [];
				emit("text", { edits, text: session.text.toString() });
			}, TEXT_COALESCE_MS);
		}
	};
	session.text.observe(onText);

	// Roster changes: only when membership or ready flags shift, not on every
	// remote cursor twitch — cursors are always available from /state.
	let lastRoster = "";
	const onAwareness = (): void => {
		const roster = participants()
			.map((participant) => `${participant.name}:${participant.ready}`)
			.sort()
			.join(",");
		if (roster !== lastRoster) {
			lastRoster = roster;
			emit("roster", { participants: participants() });
		}
	};
	session.awareness.on("change", onAwareness);

	const onMessages = (): void => {
		emit("message", { messages: session.messages.toArray() });
	};
	session.messages.observe(onMessages);

	function participants() {
		return session.getRemoteCursors().map((cursor: RemoteCursor) => ({
			name: cursor.user.name,
			color: cursor.user.color,
			kind: cursor.user.kind ?? "human",
			index: cursor.index,
			ready: cursor.ready,
		}));
	}

	function snapshot() {
		return {
			text: session.text.toString(),
			myIndex: session.getLocalIndex(),
			myReady: session.isReady(),
			everyoneReady: session.isEveryoneReady(),
			participants: participants(),
			messages: session.messages.toArray(),
		};
	}

	// --- Commands, serialized -------------------------------------------------
	let operationChain: Promise<unknown> = Promise.resolve();
	function enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
		const run = () => Promise.resolve().then(operation);
		const next = operationChain.then(run, run);
		operationChain = next;
		return next;
	}

	async function handleCommand(
		command: Record<string, unknown>,
	): Promise<Record<string, unknown>> {
		const op = command.op;
		if (op === "appendLine" && typeof command.line === "string") {
			appendLine(session, command.line);
			return { ok: true, text: session.text.toString() };
		}
		if (
			op === "replace" &&
			typeof command.find === "string" &&
			typeof command.insert === "string"
		) {
			const index = replaceText(session, {
				find: command.find,
				insert: command.insert,
				after: typeof command.after === "string" ? command.after : undefined,
			});
			if (index === undefined) return { ok: false, error: "find: no match" };
			return { ok: true, index, text: session.text.toString() };
		}
		if (op === "splices" && Array.isArray(command.splices)) {
			applySplices(session, command.splices as Splice[]);
			return { ok: true, text: session.text.toString() };
		}
		if (op === "type" && typeof command.text === "string") {
			await typeText(
				session,
				command.text,
				typeof command.cps === "number" ? command.cps : undefined,
			);
			return { ok: true, text: session.text.toString() };
		}
		if (op === "insert" && typeof command.text === "string") {
			insertAtCursor(session, command.text);
			return { ok: true, text: session.text.toString() };
		}
		if (op === "moveTo" && typeof command.index === "number") {
			moveCursor(session, command.index);
			return { ok: true, myIndex: session.getLocalIndex() };
		}
		if (
			op === "deleteRange" &&
			typeof command.index === "number" &&
			typeof command.count === "number"
		) {
			deleteRange(session, command.index, command.count);
			return { ok: true, text: session.text.toString() };
		}
		if (op === "ready" && typeof command.ready === "boolean") {
			session.setReady(command.ready);
			return { ok: true, myReady: session.isReady() };
		}
		if (op === "quit") {
			setTimeout(() => options.onQuit?.(), 50);
			return { ok: true, bye: true };
		}
		return { ok: false, error: `unknown op: ${String(op)}` };
	}

	// --- HTTP surface ---------------------------------------------------------
	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const respond = (status: number, body: unknown): void => {
			response.writeHead(status, { "content-type": "application/json" });
			response.end(JSON.stringify(body));
		};

		if (request.method === "GET" && url.pathname === "/state") {
			respond(200, snapshot());
			return;
		}
		if (request.method === "GET" && url.pathname === "/events") {
			const since = Number(url.searchParams.get("since") ?? 0);
			const wait = Math.min(
				Number(url.searchParams.get("wait") ?? 0),
				LONG_POLL_LIMIT_MS,
			);
			const ready = eventsSince(since);
			if (ready.length > 0 || wait <= 0) {
				respond(200, { seq: nextSeq - 1, events: ready });
				return;
			}
			// Long-poll: answer on the next event or when the wait expires.
			const timer = setTimeout(() => {
				waiters.delete(wake);
				respond(200, { seq: nextSeq - 1, events: [] });
			}, wait);
			const wake = (): void => {
				clearTimeout(timer);
				respond(200, { seq: nextSeq - 1, events: eventsSince(since) });
			};
			waiters.add(wake);
			return;
		}
		if (request.method === "POST" && url.pathname === "/cmd") {
			void readBody(request)
				.then((body) => JSON.parse(body) as Record<string, unknown>)
				.then((command) => enqueue(() => handleCommand(command)))
				.then((result) => respond(200, result))
				.catch((error) => respond(400, { ok: false, error: String(error) }));
			return;
		}
		respond(404, { ok: false, error: "not found" });
	});

	return new Promise((resolve) => {
		server.listen(options.port ?? 0, "127.0.0.1", () => {
			const address = server.address();
			const port =
				typeof address === "object" && address !== null ? address.port : 0;
			resolve({
				port,
				close() {
					session.text.unobserve(onText);
					session.awareness.off("change", onAwareness);
					session.messages.unobserve(onMessages);
					if (textTimer !== undefined) clearTimeout(textTimer);
					waiters.forEach((wake) => wake());
					waiters.clear();
					return new Promise((done) => server.close(() => done()));
				},
			});
		});
	});
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
