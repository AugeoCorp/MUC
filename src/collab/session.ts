// The collaborative session — all Yjs wiring lives here. Adapted from Kirby
// Banman's multiplayer-tui-prototype, with his simulated two-doc relay replaced
// by our real Channel (net/channel.ts).
//
// Each participant has ONE Y.Doc. Every local edit makes Yjs emit a binary
// update, which we base64-encode into a frame and post on the channel; inbound
// frames are applied to the doc. Cursors travel the same way via y-protocols
// awareness; ready flags live in the doc itself (see READY_KEY). Because the
// relay replays its retained (compacted) log to a late joiner, applying that
// backlog reconstructs the full document automatically.

import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import type { Channel } from "../net/channel.ts";
import { fromBase64, toBase64 } from "../utilities/base64.ts";
import { clamp } from "../utilities/clamp.ts";
import { hexFromHue, hueInLargestGap } from "./colors.ts";
import { decodeCursor, encodeCursor } from "./cursors.ts";

/**
 * Who — or what — is at the other end. Everyone in the room is a peer; this
 * only says which kind of peer, so the legend can tell them apart at a glance.
 */
export type ParticipantKind = "human" | "agent";

export interface UserInfo {
	/** Display name shown in the legend. */
	name: string;
	/** Any ink-compatible color (named color or hex). */
	color: string;
	/**
	 * What kind of participant this is. Agents never gate the ready-to-send
	 * quorum. On the wire an absent kind counts as human — older clients that
	 * don't send one must still be able to hold up the send.
	 */
	kind: ParticipantKind;
	/**
	 * Free-form note on who this participant is and why they're here, shown
	 * beside their name. Meant for participants who aren't people: an agent can
	 * say what it is and what it's watching the draft for.
	 */
	descriptor?: string;
}

/** True when a participant should count toward the ready quorum. */
export function isHuman(user: { kind?: ParticipantKind }): boolean {
	return user.kind !== "agent";
}

/**
 * What a session is here to do. Two questions, and each role answers them
 * differently: does it appear in the room, and does it do the sending?
 *
 * - `participant` — drafts, and is seen drafting. Never sends.
 * - `server` — holds the document and sends, but publishes no presence, so no
 *   one sees a cursor for it and it isn't counted in "everyone ready".
 * - `solo` — alone with the box (`muc solo`), so it does both.
 */
export type Role = "participant" | "server" | "solo";

/** The collaborative text lives under this key in the doc. */
export const CONTENT_KEY = "content";

/** The shared log of submitted messages lives under this key in the doc. */
export const MESSAGES_KEY = "messages";

/** The server's color assignments — clientId (as a string) → hue, 0–360. */
export const COLORS_KEY = "colors";

/**
 * Ready flags — clientId (as a string) → whether that participant has signed
 * off on the draft. They live in the doc rather than in awareness so that an
 * edit and the flag it withdraws travel in one update: a flag can never be
 * seen beside text it wasn't set against.
 */
export const READY_KEY = "ready";

// Edits the local user makes are tagged LOCAL_ORIGIN (so undo can track only
// them); edits that arrived from a peer are tagged NETWORK_ORIGIN (so we never
// echo them back out and loop).
export const LOCAL_ORIGIN = "local-user";
export const NETWORK_ORIGIN = "network";

export interface RemoteCursor {
	clientId: number;
	user: UserInfo;
	/** Absolute index in the local doc, or undefined if not currently resolvable. */
	index: number | undefined;
	/** Whether this participant has marked themselves ready to send. */
	ready: boolean;
}

export interface CollabSession {
	doc: Y.Doc;
	text: Y.Text;
	/** The shared log of submitted messages, oldest first. */
	messages: Y.Array<string>;
	/** The server's hue assignments; observe it to re-render when they change. */
	colors: Y.Map<number>;
	/** Everyone's ready flags; observe it to re-render when they change. */
	readyFlags: Y.Map<boolean>;
	awareness: Awareness;
	undoManager: Y.UndoManager;
	user: UserInfo;
	/** Publish the local cursor (as a relative position) into awareness. */
	publishCursor(index: number): void;
	/** Resolve the local cursor back to a clamped absolute index. */
	getLocalIndex(): number;
	/** Every other participant's cursor, resolved against the local doc. */
	getRemoteCursors(): RemoteCursor[];
	/** The local user's color — the server's assignment, or their own pick. */
	localColor(): string;
	/**
	 * Apply a local edit. `mutate` runs in one transaction together with the
	 * ready flags it withdraws — the local user's, since the draft they signed
	 * off on no longer exists; and, when the local user is an agent, every
	 * human's, because an agent can't sign off for anyone and so hands the
	 * decision back to the people who can.
	 */
	edit(mutate: () => void): void;
	/** A participant's color, or undefined if we've never heard of them. */
	colorFor(clientId: number): string | undefined;
	/**
	 * Who inserted each character of the draft, as clientIds indexed the same way
	 * the text is. A CRDT has no in-place edit — changing a character is a delete
	 * and an insert — so this is authorship of what's there now, which is the
	 * question the authorship lens actually asks.
	 */
	getAuthors(): (number | undefined)[];
	/** Mark (or clear) the local user as ready to send. No-op if unchanged. */
	setReady(ready: boolean): void;
	/** Whether the local user is currently ready. */
	isReady(): boolean;
	/**
	 * How many humans are present and how many of them are ready. The local
	 * user counts too, except for a `server` (no draft of its own to sign off
	 * on) or an agent (agents never gate the send).
	 */
	readyTally(): { ready: number; total: number };
	/**
	 * Whether every present human is ready. A room with no humans in it is
	 * never ready.
	 */
	isEveryoneReady(): boolean;
	/** Tear everything down: drop presence and destroy the doc/awareness. */
	destroy(): void;
}

interface AwarenessChanges {
	added: number[];
	updated: number[];
	removed: number[];
}

export function createCollabSession(
	channel: Channel,
	user: UserInfo,
	options: { role?: Role } = {},
): CollabSession {
	const role = options.role ?? "participant";
	const doc = new Y.Doc();
	const text = doc.getText(CONTENT_KEY);
	const messages = doc.getArray<string>(MESSAGES_KEY);
	const colors = doc.getMap<number>(COLORS_KEY);
	const readyFlags = doc.getMap<boolean>(READY_KEY);
	const awareness = new Awareness(doc);
	const localKey = String(doc.clientID);

	// The cursor is stored as a relative position (see cursors.ts) so it
	// survives concurrent edits.
	function publishCursor(index: number): void {
		// A server watches the room without being in it: publishing nothing is
		// what keeps it out of everyone's cursor list.
		if (role === "server") return;
		awareness.setLocalState({ user, cursor: encodeCursor(text, index) });
	}

	function edit(mutate: () => void): void {
		doc.transact(() => {
			mutate();
			if (isHuman(user)) {
				if (readyFlags.get(localKey) === true) readyFlags.delete(localKey);
			} else {
				readyFlags.forEach((_, key) => readyFlags.delete(key));
			}
		}, LOCAL_ORIGIN);
	}

	function setReady(ready: boolean): void {
		if (role === "server") return; // holds no draft, so has nothing to sign
		if (ready === isReady()) return; // unchanged — stay off the wire
		doc.transact(() => {
			if (ready) readyFlags.set(localKey, true);
			else readyFlags.delete(localKey);
		}, LOCAL_ORIGIN);
	}

	function isReady(): boolean {
		return readyFlags.get(localKey) === true;
	}

	function getLocalIndex(): number {
		const state = awareness.getLocalState() as { cursor?: number[] } | null;
		const index = decodeCursor(state?.cursor, doc);
		if (index === undefined) return text.length;
		return clamp(index, 0, text.length);
	}

	function getRemoteCursors(): RemoteCursor[] {
		const cursors: RemoteCursor[] = [];
		awareness.getStates().forEach((state, clientId) => {
			if (clientId === doc.clientID) return;
			const entry = state as { cursor?: number[]; user?: UserInfo };
			if (entry.user === undefined) return;
			cursors.push({
				clientId,
				user: {
					...entry.user,
					// An older client sends no kind; on the wire that means human.
					kind: entry.user.kind === "agent" ? "agent" : "human",
					// The assigned color wins over the one they picked for themselves.
					color: colorOf(clientId, entry.user.color),
				},
				index: decodeCursor(entry.cursor, doc),
				ready: readyFlags.get(String(clientId)) === true,
			});
		});
		return cursors;
	}

	function colorFor(clientId: number): string | undefined {
		const hue = colors.get(String(clientId));
		if (hue !== undefined) return hexFromHue(hue);
		// No assignment yet (or no server at all) — fall back to whatever they
		// picked for themselves, which is all we know about someone who has left.
		const state = awareness.getStates().get(clientId) as
			| { user?: UserInfo }
			| undefined;
		return state?.user?.color;
	}

	function colorOf(clientId: number, fallback: string): string {
		return colorFor(clientId) ?? fallback;
	}

	function localColor(): string {
		return colorOf(doc.clientID, user.color);
	}

	function readyTally(): { ready: number; total: number } {
		// Only humans gate the send: agents draft alongside everyone else but
		// never hold a message up. A server holds no draft, so it has no flag of
		// its own to add — it waits on the people who do.
		const remoteHumans = getRemoteCursors().filter((cursor) =>
			isHuman(cursor.user),
		);
		const localCounts = role !== "server" && isHuman(user);
		return {
			ready:
				remoteHumans.filter((cursor) => cursor.ready).length +
				(localCounts && isReady() ? 1 : 0),
			total: remoteHumans.length + (localCounts ? 1 : 0),
		};
	}

	function getAuthors(): (number | undefined)[] {
		const authors: (number | undefined)[] = [];
		text.toDelta().forEach((operation: { insert?: unknown }) => {
			if (typeof operation.insert !== "string") return;
			const attributes = (operation as { attributes?: { author?: unknown } })
				.attributes;
			const author =
				typeof attributes?.author === "number" ? attributes.author : undefined;
			// One entry per UTF-16 unit, so an index into the text is an index into
			// this — the same counting `computeRows` and the cursor use.
			for (let i = 0; i < operation.insert.length; i++) authors.push(author);
		});
		return authors;
	}

	function isEveryoneReady(): boolean {
		// Some human must actually be present, or the quorum would pass
		// vacuously the moment the last person left.
		const tally = readyTally();
		return tally.total > 0 && tally.ready === tally.total;
	}

	// --- The wire: relay binary doc updates over the channel -------------------
	doc.on("update", (update: Uint8Array, origin: unknown) => {
		if (origin === NETWORK_ORIGIN) return; // arrived from a peer; don't echo
		channel.post({ t: "u", d: toBase64(update) });
	});

	// --- The same wire for presence: relay awareness (cursors) ----------------
	awareness.on("update", (changes: AwarenessChanges, origin: unknown) => {
		if (origin === NETWORK_ORIGIN) return;
		const clients = [...changes.added, ...changes.updated, ...changes.removed];
		channel.post({
			t: "a",
			d: toBase64(encodeAwarenessUpdate(awareness, clients)),
		});
	});

	const unsubscribe = channel.subscribe((frame) => {
		const message = frame as { t?: string; d?: string };
		if (typeof message.d !== "string") return;
		if (message.t === "u") {
			Y.applyUpdate(doc, fromBase64(message.d), NETWORK_ORIGIN);
		} else if (message.t === "a") {
			applyAwarenessUpdate(awareness, fromBase64(message.d), NETWORK_ORIGIN);
		}
	});

	// Announce ourselves now that the wire is attached — until a participant's
	// user info reaches the channel, peers can't see them, and an invisible
	// human can't gate the ready quorum (the host would submit as if alone).
	publishCursor(text.length);

	// --- Local-only undo/redo -------------------------------------------------
	// Scoped to LOCAL_ORIGIN so undo/redo never touch a peer's edits. Yjs still
	// computes the correct inverse even when remote edits shifted the text.
	const undoManager = new Y.UndoManager(text, {
		trackedOrigins: new Set([LOCAL_ORIGIN]),
		captureTimeout: 400,
	});
	type StackEvent = { stackItem: { meta: Map<string, unknown> } };
	undoManager.on("stack-item-added", (event: StackEvent) => {
		event.stackItem.meta.set(
			"cursor",
			Y.createRelativePositionFromTypeIndex(text, getLocalIndex()),
		);
	});
	undoManager.on("stack-item-popped", (event: StackEvent) => {
		const relativePosition = event.stackItem.meta.get("cursor") as
			| Y.RelativePosition
			| undefined;
		if (relativePosition === undefined) return;
		const absolutePosition = Y.createAbsolutePositionFromRelativePosition(
			relativePosition,
			doc,
		);
		if (absolutePosition) {
			publishCursor(clamp(absolutePosition.index, 0, text.length));
		}
	});

	// --- Ready → send ---------------------------------------------------------
	// One session is the single writer that turns "everyone ready" into a sent
	// message: it appends the trimmed draft to the shared log, clears the
	// composer, and withdraws every ready flag, all in one transaction that
	// syncs to every peer. Exactly one acts, so the log never gains duplicate
	// copies from a simultaneous trigger — the server where there is one, and
	// the lone user in `muc solo`.
	function submitIfEveryoneReady(): void {
		if (role === "participant") return;
		if (!isEveryoneReady()) return;
		const draft = text.toString().trim();
		if (draft === "") return;
		doc.transact(() => {
			messages.push([draft]);
			text.delete(0, text.length);
			readyFlags.forEach((_, key) => readyFlags.delete(key));
		}, LOCAL_ORIGIN);
	}

	// --- Presence bookkeeping -------------------------------------------------
	// Handing out colors needs one view of who's in the room, which is exactly
	// what the server has and no client does. Each arrival gets the hue furthest
	// from everyone already here (see colors.ts), written into a shared map that
	// everyone renders from. Clients fall back to their own pick where there's no
	// server to ask (`muc solo`, or the instant before the assignment lands).
	// Whoever left takes their hue and their ready flag with them — a flag with
	// no one behind it must not linger in the doc.
	function reconcilePresence(): void {
		if (role !== "server") return;

		const present = new Set<string>();
		awareness.getStates().forEach((state, clientId) => {
			if (clientId === doc.clientID) return;
			if ((state as { user?: UserInfo }).user === undefined) return;
			present.add(String(clientId));
		});

		const departed = [
			...new Set([...colors.keys(), ...readyFlags.keys()]),
		].filter((key) => !present.has(key));
		const arrived = [...present].filter((key) => !colors.has(key));
		if (departed.length === 0 && arrived.length === 0) return;

		doc.transact(() => {
			// Freeing a departed participant's hue first reopens that gap.
			departed.forEach((key) => {
				colors.delete(key);
				readyFlags.delete(key);
			});
			// Reading the map back each time — rather than once up front — is what
			// spreads a burst of simultaneous arrivals instead of stacking them.
			arrived.forEach((key) =>
				colors.set(key, hueInLargestGap([...colors.values()])),
			);
		}, LOCAL_ORIGIN);
	}

	// Only a ready flag can complete the quorum, so only a flag change is worth
	// re-checking on. Text changes never send: an edit travels with the flags it
	// withdraws, so a draft is only ever sent against the flags set for it.
	const onReadyChanged = (): void => submitIfEveryoneReady();
	// Whenever a message lands — from our own submit or a peer's — every client
	// also clears its own flag, covering the one race the submit's own clear
	// can't: a flag set in the same instant the draft went out.
	const onMessageAdded = (): void => setReady(false);
	awareness.on("change", reconcilePresence);
	readyFlags.observe(onReadyChanged);
	messages.observe(onMessageAdded);

	return {
		doc,
		text,
		messages,
		colors,
		readyFlags,
		awareness,
		undoManager,
		user,
		publishCursor,
		getLocalIndex,
		getRemoteCursors,
		localColor,
		edit,
		colorFor,
		getAuthors,
		setReady,
		isReady,
		readyTally,
		isEveryoneReady,
		destroy() {
			awareness.off("change", reconcilePresence);
			readyFlags.unobserve(onReadyChanged);
			messages.unobserve(onMessageAdded);
			unsubscribe();
			undoManager.destroy();
			removeAwarenessStates(awareness, [doc.clientID], "destroy");
			awareness.destroy();
			doc.destroy();
		},
	};
}
