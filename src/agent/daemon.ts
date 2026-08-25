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

import { createServer } from "node:http";
import type * as Y from "yjs";
import {
	type CollabSession,
	NETWORK_ORIGIN,
	type ParticipantKind,
	type RemoteCursor,
	type UserInfo,
} from "../collab/session.ts";
import { readBody } from "../utilities/readBody.ts";
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

/** Who made an edit, when the writer can be named. */
interface EditAttribution {
	name: string;
	kind: ParticipantKind;
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
	let pendingEdits: Array<{
		origin: "local" | "remote";
		delta: unknown;
		by?: EditAttribution;
	}> = [];
	let textTimer: NodeJS.Timeout | undefined;
	const onText = (event: Y.YTextEvent, transaction: Y.Transaction): void => {
		const origin =
			transaction.origin === NETWORK_ORIGIN ? ("remote" as const) : "local";
		pendingEdits.push({
			origin,
			delta: event.changes.delta,
			by: attributeEdit(origin, transaction),
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
		const current = participants();
		const roster = current
			.map((participant) => `${participant.name}:${participant.ready}`)
			.sort()
			.join(",");
		if (roster !== lastRoster) {
			lastRoster = roster;
			emit("roster", { participants: current });
		}
	};
	session.awareness.on("change", onAwareness);

	const onMessages = (): void => {
		emit("message", { messages: session.messages.toArray() });
	};
	session.messages.observe(onMessages);

	// Who made this edit. Local transactions are our own user. A remote
	// transaction names its writer through its state vectors — new structs land
	// under the originating clientID — resolved to a name via awareness. When
	// that fails (a delete-only update adds no structs; backlog replay outruns
	// presence; the presence-less server clears the composer), the edit carries
	// no `by` rather than a guess.
	function attributeEdit(
		origin: "local" | "remote",
		transaction: Y.Transaction,
	): EditAttribution | undefined {
		if (origin === "local") {
			return {
				name: session.user.name,
				kind: session.user.kind ?? "human",
			};
		}
		const writerIds: number[] = [];
		transaction.afterState.forEach((clock, clientId) => {
			if (transaction.beforeState.get(clientId) !== clock) {
				writerIds.push(clientId);
			}
		});
		if (writerIds.length !== 1) return undefined; // nobody or ambiguous
		const state = session.awareness.getStates().get(writerIds[0]) as
			| { user?: UserInfo }
			| undefined;
		if (state?.user === undefined) return undefined;
		return {
			name: state.user.name,
			kind: state.user.kind ?? "human",
		};
	}

	function participants() {
		return session.getRemoteCursors().map((cursor: RemoteCursor) => ({
			name: cursor.user.name,
			color: cursor.user.color,
			kind: cursor.user.kind ?? "human",
			descriptor: cursor.user.descriptor,
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
			const result = replaceText(session, {
				find: command.find,
				insert: command.insert,
				after: typeof command.after === "string" ? command.after : undefined,
			});
			if ("miss" in result) {
				return { ok: false, error: `${result.miss}: no match` };
			}
			return { ok: true, index: result.index, text: session.text.toString() };
		}
		if (op === "splices" && Array.isArray(command.splices)) {
			// Validated up front: a malformed element throwing mid-transaction
			// would still commit the splices already applied (Yjs transactions
			// don't roll back), breaking the op's documented atomicity.
			const wellFormed = command.splices.every((splice) => {
				const candidate = splice as Partial<Splice> | undefined;
				return (
					typeof candidate?.at === "number" &&
					typeof candidate.remove === "number" &&
					typeof candidate.insert === "string"
				);
			});
			if (!wellFormed) {
				return {
					ok: false,
					error: "splices: every element needs {at, remove, insert}",
				};
			}
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

	return new Promise((resolve, reject) => {
		// Without a listener, a listen failure (the port is taken, or
		// privileged) becomes an uncaught exception instead of a rejection the
		// caller can present.
		server.on("error", reject);
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
