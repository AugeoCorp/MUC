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
}

export interface CollabSession {
	doc: Y.Doc;
	text: Y.Text;
	awareness: Awareness;
	undoManager: Y.UndoManager;
	user: UserInfo;
	/** Publish the local cursor (as a relative position) into awareness. */
	publishCursor(index: number): void;
	/** Resolve the local cursor back to a clamped absolute index. */
	getLocalIndex(): number;
	/** Every other participant's cursor, resolved against the local doc. */
	getRemoteCursors(): RemoteCursor[];
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
): CollabSession {
	const doc = new Y.Doc();
	const text = doc.getText(CONTENT_KEY);
	const awareness = new Awareness(doc);

	function publishCursor(index: number): void {
		awareness.setLocalState({ user, cursor: encodeCursor(text, index) });
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
			const entry = state as { cursor?: number[]; user?: UserInfo };
			if (entry.user === undefined) return;
			cursors.push({
				clientId,
				user: entry.user,
				index: decodeCursor(entry.cursor, doc),
			});
		});
		return cursors;
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

	return {
		doc,
		text,
		awareness,
		undoManager,
		user,
		publishCursor,
		getLocalIndex,
		getRemoteCursors,
		destroy() {
			unsubscribe();
			undoManager.destroy();
			removeAwarenessStates(awareness, [doc.clientID], "destroy");
			awareness.destroy();
			doc.destroy();
		},
	};
}
