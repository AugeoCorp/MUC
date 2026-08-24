// Edit operations an agent can perform against a CollabSession. These mirror
// the human Editor's applyKey semantics — every edit is a LOCAL_ORIGIN
// transaction and clears the ready flag — but are shaped for programmatic use:
// atomic where possible, explicit about cursor movement.
//
// Lessons from the first live swarm session are baked in:
// - `replace` must NOT move the local cursor. The cursor is a Yjs relative
//   position and survives splices on its own; repositioning it let a
//   background replace hijack a concurrent paced `type` mid-sentence.
// - Paced per-character typing at a shared cursor interleaves with other
//   participants' typing ("CRDT soup"). `appendLine` posts a whole line in one
//   transaction and is the preferred way for an agent to speak.

import { type CollabSession, LOCAL_ORIGIN } from "../collab/session.ts";

export interface ReplaceOptions {
	/** Exact text to find (first occurrence). */
	find: string;
	/** Replacement text. */
	insert: string;
	/** When set, search only after the first occurrence of this anchor. */
	after?: string;
}

export interface Splice {
	/** Index into the document as it was before this batch. */
	at: number;
	/** Characters to remove at `at`. */
	remove: number;
	/** Text to insert at `at` after removal. */
	insert: string;
}

const clamp = (value: number, low: number, high: number): number =>
	Math.max(low, Math.min(value, high));

/**
 * Append `line` as its own line at the end of the document, atomically. The
 * collision-safe way for an agent to say something.
 */
export function appendLine(session: CollabSession, line: string): void {
	const text = session.text.toString();
	const needsLeadingNewline = text.length > 0 && !text.endsWith("\n");
	const value = `${needsLeadingNewline ? "\n" : ""}${line}\n`;
	session.doc.transact(
		() => session.text.insert(session.text.length, value),
		LOCAL_ORIGIN,
	);
	session.setReady(false);
}

/**
 * Atomic find-and-replace of the first occurrence. Leaves the local cursor
 * where it was. Returns the index replaced at, or undefined when not found.
 */
export function replaceText(
	session: CollabSession,
	options: ReplaceOptions,
): number | undefined {
	const text = session.text.toString();
	let from = 0;
	if (options.after !== undefined) {
		const anchor = text.indexOf(options.after);
		if (anchor === -1) return undefined;
		from = anchor + options.after.length;
	}
	const index = text.indexOf(options.find, from);
	if (index === -1) return undefined;
	session.doc.transact(() => {
		session.text.delete(index, options.find.length);
		session.text.insert(index, options.insert);
	}, LOCAL_ORIGIN);
	session.setReady(false);
	return index;
}

/**
 * Apply several splices in one transaction. Indices refer to the document as
 * it stands before the batch; splices are applied highest-index first so
 * earlier ones don't shift later ones. Overlapping splices are the caller's
 * mistake.
 */
export function applySplices(session: CollabSession, splices: Splice[]): void {
	const length = session.text.length;
	const ordered = [...splices].sort((a, b) => b.at - a.at);
	session.doc.transact(() => {
		ordered.forEach((splice) => {
			const at = clamp(splice.at, 0, length);
			const remove = clamp(splice.remove, 0, length - at);
			if (remove > 0) session.text.delete(at, remove);
			if (splice.insert !== "") session.text.insert(at, splice.insert);
		});
	}, LOCAL_ORIGIN);
	session.setReady(false);
}

/** Insert at the local cursor and advance it — one keystroke's worth. */
export function insertAtCursor(session: CollabSession, value: string): void {
	const index = session.getLocalIndex();
	session.doc.transact(() => session.text.insert(index, value), LOCAL_ORIGIN);
	session.setReady(false);
	session.publishCursor(index + value.length);
}

/** Delete a clamped range and park the cursor at its start. */
export function deleteRange(
	session: CollabSession,
	index: number,
	count: number,
): void {
	const length = session.text.length;
	const at = clamp(index, 0, length);
	const removed = clamp(count, 0, length - at);
	if (removed === 0) return;
	session.doc.transact(() => session.text.delete(at, removed), LOCAL_ORIGIN);
	session.setReady(false);
	session.publishCursor(at);
}

/** Publish the cursor at a clamped index. */
export function moveCursor(session: CollabSession, index: number): void {
	session.publishCursor(clamp(index, 0, session.text.length));
}

const sleep = (milliseconds: number): Promise<void> =>
	new Promise((resolve) => setTimeout(resolve, milliseconds));

/**
 * Human-paced typing at the live cursor: one character per transaction so
 * remote participants watch the text arrive. Interleaves with concurrent
 * typing at the same position — prefer `appendLine` unless the theater is the
 * point. Callers should serialize this behind the daemon's operation queue.
 */
export async function typeText(
	session: CollabSession,
	value: string,
	charactersPerSecond = 14,
): Promise<void> {
	const delay = 1000 / clamp(charactersPerSecond, 1, 100);
	for (const character of value) {
		insertAtCursor(session, character);
		await sleep(delay);
	}
}
