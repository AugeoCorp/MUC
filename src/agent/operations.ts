// Edit operations an agent can perform against a CollabSession. These mirror
// the human Editor's applyKey semantics — every edit goes through
// `session.edit`, one LOCAL_ORIGIN transaction that also withdraws the ready
// flags it invalidates — but are shaped for programmatic use: atomic where
// possible, explicit about cursor movement.
//
// Lessons from the first live swarm session are baked in:
// - `replace` must NOT move the local cursor. The cursor is a Yjs relative
//   position and survives splices on its own; repositioning it let a
//   background replace hijack a concurrent paced `type` mid-sentence.
// - Paced per-character typing at a shared cursor interleaves with other
//   participants' typing ("CRDT soup"). `appendLine` posts a whole line in one
//   transaction and is the preferred way for an agent to speak.

import type { CollabSession } from "../collab/session.ts";
import { clamp } from "../utilities/clamp.ts";

// Every insert is stamped with its author, like the Editor's, so the
// authorship lens (⌃t) colours an agent's text the same way as a person's.
function stamp(session: CollabSession): { author: number } {
	return { author: session.doc.clientID };
}

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

/**
 * Append `line` as its own line at the end of the document, atomically. The
 * collision-safe way for an agent to say something.
 */
export function appendLine(session: CollabSession, line: string): void {
	const text = session.text.toString();
	const needsLeadingNewline = text.length > 0 && !text.endsWith("\n");
	const value = `${needsLeadingNewline ? "\n" : ""}${line}\n`;
	session.edit(() =>
		session.text.insert(session.text.length, value, stamp(session)),
	);
}

/**
 * Atomic find-and-replace of the first occurrence. Leaves the local cursor
 * where it was. A miss names which string failed to match — the anchor and
 * the find text fail for different reasons, and a caller debugging "no
 * match" needs to know which one moved under it.
 */
export function replaceText(
	session: CollabSession,
	options: ReplaceOptions,
): { index: number } | { miss: "after" | "find" } {
	const text = session.text.toString();
	let from = 0;
	if (options.after !== undefined) {
		const anchor = text.indexOf(options.after);
		if (anchor === -1) return { miss: "after" };
		from = anchor + options.after.length;
	}
	const index = text.indexOf(options.find, from);
	if (index === -1) return { miss: "find" };
	session.edit(() => {
		session.text.delete(index, options.find.length);
		session.text.insert(index, options.insert, stamp(session));
	});
	return { index };
}

/**
 * Apply several splices in one transaction. Indices refer to the document as
 * it stands before the batch; splices are applied highest-index first so
 * earlier ones don't shift later ones. Splices at the same index land in the
 * order given. Overlapping splices are the caller's mistake.
 */
export function applySplices(session: CollabSession, splices: Splice[]): void {
	const length = session.text.length;
	// Applying the later of two same-index splices first is what leaves the
	// earlier one in front of it.
	const ordered = splices
		.map((splice, position) => ({ splice, position }))
		.sort((a, b) => b.splice.at - a.splice.at || b.position - a.position)
		.map((entry) => entry.splice);
	session.edit(() => {
		ordered.forEach((splice) => {
			const at = clamp(splice.at, 0, length);
			const remove = clamp(splice.remove, 0, length - at);
			if (remove > 0) session.text.delete(at, remove);
			if (splice.insert !== "") {
				session.text.insert(at, splice.insert, stamp(session));
			}
		});
	});
}

/** Insert at the local cursor and advance it — one keystroke's worth. */
export function insertAtCursor(session: CollabSession, value: string): void {
	const index = session.getLocalIndex();
	session.edit(() => session.text.insert(index, value, stamp(session)));
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
	session.edit(() => session.text.delete(at, removed));
	session.publishCursor(at);
}

/** Publish the cursor at a clamped index. */
export function moveCursor(session: CollabSession, index: number): void {
	session.publishCursor(clamp(index, 0, session.text.length));
}

const DEFAULT_CHARACTERS_PER_SECOND = 14;

function sleep(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/**
 * Human-paced typing at the live cursor: one character per transaction so
 * remote participants watch the text arrive. Interleaves with concurrent
 * typing at the same position — prefer `appendLine` unless visible typing is
 * the point. Callers should serialize this behind the daemon's operation queue.
 *
 * Returns false, having typed nothing, when every human is already ready: a
 * ready room sends on the next edit, and the next edit here would be the
 * first character alone. `appendLine` lands whole and is the op for that room.
 */
export async function typeText(
	session: CollabSession,
	value: string,
	charactersPerSecond = DEFAULT_CHARACTERS_PER_SECOND,
): Promise<boolean> {
	if (session.isEveryoneReady()) return false;
	// NaN slips through clamp (every comparison is false), and a NaN delay
	// types at event-loop speed — the opposite of pacing. Fall back instead.
	const pace = Number.isFinite(charactersPerSecond)
		? clamp(charactersPerSecond, 1, 100)
		: DEFAULT_CHARACTERS_PER_SECOND;
	const delay = 1000 / pace;
	for (const character of value) {
		insertAtCursor(session, character);
		await sleep(delay);
	}
	return true;
}
