// The collaborative session — all Yjs wiring lives here. Adapted from Kirby
// Banman's multiplayer-tui-prototype, with his simulated two-doc relay replaced
// by our real Channel (net/channel.ts).
//
// Each participant has ONE Y.Doc. Every local edit makes Yjs emit a binary
// update, which we base64-encode into a frame and post on the channel; inbound
// frames are applied to the doc. Cursors travel the same way via y-protocols
// awareness. Because the relay replays its whole log to a late joiner, applying
// that backlog reconstructs the full document automatically.

import {
	Awareness,
	applyAwarenessUpdate,
	encodeAwarenessUpdate,
	removeAwarenessStates,
} from "y-protocols/awareness";
import * as Y from "yjs";
import type { Channel } from "../net/channel.ts";
import { decodeCursor, encodeCursor } from "./cursors.ts";

export interface UserInfo {
	/** Display name shown in the legend. */
	name: string;
	/** Any ink-compatible color (named color or hex). */
	color: string;
}

/** The collaborative text lives under this key in the doc. */
export const CONTENT_KEY = "content";

/** The shared log of submitted messages lives under this key in the doc. */
export const MESSAGES_KEY = "messages";

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
	awareness: Awareness;
	undoManager: Y.UndoManager;
	user: UserInfo;
	/** Publish the local cursor (as a relative position) into awareness. */
	publishCursor(index: number): void;
	/** Resolve the local cursor back to a clamped absolute index. */
	getLocalIndex(): number;
	/** Every other participant's cursor, resolved against the local doc. */
	getRemoteCursors(): RemoteCursor[];
	/** Mark (or clear) the local user as ready to send. No-op if unchanged. */
	setReady(ready: boolean): void;
	/** Whether the local user is currently ready. */
	isReady(): boolean;
	/** Whether every present participant — the local user included — is ready. */
	isEveryoneReady(): boolean;
	/** Tear everything down: drop presence and destroy the doc/awareness. */
	destroy(): void;
}

interface AwarenessChanges {
	added: number[];
	updated: number[];
	removed: number[];
}

const toBase64 = (bytes: Uint8Array): string =>
	Buffer.from(bytes).toString("base64");
const fromBase64 = (text: string): Uint8Array =>
	new Uint8Array(Buffer.from(text, "base64"));

export function createCollabSession(
	channel: Channel,
	user: UserInfo,
	options: { isHost?: boolean } = {},
): CollabSession {
	const doc = new Y.Doc();
	const text = doc.getText(CONTENT_KEY);
	const messages = doc.getArray<string>(MESSAGES_KEY);
	const awareness = new Awareness(doc);

	// Local awareness state (cursor + ready) is written from one place so the two
	// fields never clobber each other. The cursor is stored as a relative
	// position (see cursors.ts) so it survives concurrent edits.
	let localCursor = encodeCursor(text, text.length);
	let localReady = false;
	function publishLocalState(): void {
		awareness.setLocalState({ user, cursor: localCursor, ready: localReady });
	}

	function publishCursor(index: number): void {
		localCursor = encodeCursor(text, index);
		publishLocalState();
	}

	function setReady(ready: boolean): void {
		if (ready === localReady) return; // unchanged — stay off the wire
		localReady = ready;
		publishLocalState();
	}

	function isReady(): boolean {
		return localReady;
	}

	function getLocalIndex(): number {
		const state = awareness.getLocalState() as { cursor?: number[] } | null;
		const index = decodeCursor(state?.cursor, doc);
		if (index === undefined) return text.length;
		return Math.max(0, Math.min(index, text.length));
	}

	function getRemoteCursors(): RemoteCursor[] {
		const cursors: RemoteCursor[] = [];
		awareness.getStates().forEach((state, clientId) => {
			if (clientId === doc.clientID) return;
			const entry = state as {
				cursor?: number[];
				user?: UserInfo;
				ready?: boolean;
			};
			if (entry.user === undefined) return;
			cursors.push({
				clientId,
				user: entry.user,
				index: decodeCursor(entry.cursor, doc),
				ready: entry.ready === true,
			});
		});
		return cursors;
	}

	function isEveryoneReady(): boolean {
		if (!localReady) return false;
		return getRemoteCursors().every((cursor) => cursor.ready);
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
			publishCursor(Math.max(0, Math.min(absolutePosition.index, text.length)));
		}
	});

	// --- Ready → send ---------------------------------------------------------
	// The host is the single writer that turns "everyone ready" into a sent
	// message: it appends the trimmed draft to the shared log and clears the
	// composer, both in one transaction that syncs to every peer. Only the host
	// acts, so the log never gains duplicate copies from a simultaneous trigger.
	function submitIfEveryoneReady(): void {
		if (options.isHost !== true) return;
		if (!isEveryoneReady()) return;
		const draft = text.toString().trim();
		if (draft === "") return;
		doc.transact(() => {
			messages.push([draft]);
			text.delete(0, text.length);
		}, LOCAL_ORIGIN);
	}

	// Whenever a message lands — from our own submit or a peer's — every client
	// clears its own ready flag so the next draft starts clean. A client can only
	// reset itself, so this fires everywhere rather than the host reaching into
	// anyone else's presence.
	const onPresenceChange = (): void => submitIfEveryoneReady();
	const onMessageAdded = (): void => setReady(false);
	awareness.on("change", onPresenceChange);
	messages.observe(onMessageAdded);

	return {
		doc,
		text,
		messages,
		awareness,
		undoManager,
		user,
		publishCursor,
		getLocalIndex,
		getRemoteCursors,
		setReady,
		isReady,
		isEveryoneReady,
		destroy() {
			awareness.off("change", onPresenceChange);
			messages.unobserve(onMessageAdded);
			unsubscribe();
			undoManager.destroy();
			removeAwarenessStates(awareness, [doc.clientID], "destroy");
			awareness.destroy();
			doc.destroy();
		},
	};
}
