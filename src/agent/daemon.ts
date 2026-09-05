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
import { listen } from "../utilities/listen.ts";
import { parseNonNegativeInteger } from "../utilities/parseNonNegativeInteger.ts";
import { BodyTooLargeError, readBody } from "../utilities/readBody.ts";
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

	// A cursor older than the buffer has missed events that are gone for good;
	// the response says so rather than answering as if nothing happened.
	function feed(since: number): {
		seq: number;
		gap: boolean;
		events: AgentEvent[];
	} {
		const oldestRetained = events[0]?.seq ?? nextSeq;
		return {
			seq: nextSeq - 1,
			gap: since + 1 < oldestRetained,
			events: eventsSince(since),
		};
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
	// Membership arrives through awareness, ready flags through the doc.
	let lastRoster = "";
	const onRoster = (): void => {
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
	session.awareness.on("change", onRoster);
	session.readyFlags.observe(onRoster);

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
			return { name: session.user.name, kind: session.user.kind };
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
		// Straight off the wire, so an older client may have sent no kind.
		return { name: state.user.name, kind: state.user.kind ?? "human" };
	}

	function participants() {
		return session.getRemoteCursors().map((cursor: RemoteCursor) => ({
			name: cursor.user.name,
			color: cursor.user.color,
			kind: cursor.user.kind,
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
					Number.isInteger(candidate?.at) &&
					Number.isInteger(candidate?.remove) &&
					typeof candidate?.insert === "string"
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
		if (op === "moveTo" && Number.isInteger(command.index)) {
			moveCursor(session, command.index as number);
			return { ok: true, myIndex: session.getLocalIndex() };
		}
		if (
			op === "deleteRange" &&
			Number.isInteger(command.index) &&
			Number.isInteger(command.count)
		) {
			deleteRange(session, command.index as number, command.count as number);
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
			const since = parseNonNegativeInteger(url.searchParams.get("since"));
			const wait = Math.min(
				parseNonNegativeInteger(url.searchParams.get("wait")),
				LONG_POLL_LIMIT_MS,
			);
			const pending = feed(since);
			if (pending.events.length > 0 || pending.gap || wait === 0) {
				respond(200, pending);
				return;
			}
			// Long-poll: answer on the next event or when the wait expires.
			const timer = setTimeout(() => {
				waiters.delete(wake);
				respond(200, feed(since));
			}, wait);
			const wake = (): void => {
				clearTimeout(timer);
				respond(200, feed(since));
			};
			waiters.add(wake);
			return;
		}
		if (request.method === "POST" && url.pathname === "/cmd") {
			// Only a JSON content type is accepted. A browser sends any other
			// POST without a preflight, so a web page could otherwise drive this
			// port from anywhere; JSON forces the preflight, and with no CORS
			// headers on offer it fails there.
			const contentType = request.headers["content-type"] ?? "";
			if (!/^application\/json\b/i.test(contentType)) {
				respond(415, {
					ok: false,
					error: "content-type must be application/json",
				});
				return;
			}
			void readBody(request)
				.then((body) => JSON.parse(body) as Record<string, unknown>)
				.then((command) => enqueue(() => handleCommand(command)))
				.then((result) => respond(200, result))
				.catch((error) => {
					if (error instanceof BodyTooLargeError) {
						// Answer first, then drop the request: a socket destroyed
						// before the status leaves shows the agent nothing but a reset.
						response.writeHead(413, { "content-type": "application/json" });
						response.end(
							JSON.stringify({ ok: false, error: String(error) }),
							() => request.destroy(),
						);
						return;
					}
					respond(400, { ok: false, error: String(error) });
				});
			return;
		}
		respond(404, { ok: false, error: "not found" });
	});

	return listen(server, options.port ?? 0, "127.0.0.1").then(
		({ port, close }) => ({
			port,
			close() {
				session.text.unobserve(onText);
				session.awareness.off("change", onRoster);
				session.readyFlags.unobserve(onRoster);
				session.messages.unobserve(onMessages);
				if (textTimer !== undefined) clearTimeout(textTimer);
				waiters.forEach((wake) => wake());
				waiters.clear();
				return close();
			},
		}),
	);
}
