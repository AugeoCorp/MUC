// Relative-position helpers for cursors. Ported from Kirby Banman's
// multiplayer-tui-prototype (github.com/kdbanman/multiplayer-tui-prototype).
//
// A cursor must NOT be stored as a raw integer index: when another participant
// inserts or deletes text earlier in the document, a raw index would point at
// the wrong character. A Yjs *relative position* is anchored to an actual item
// in the CRDT, so it stays correct as the text shifts around it.
//
// Awareness state has to be JSON-serializable, so we encode the relative
// position to a Uint8Array and store it as a plain number array.

import * as Y from "yjs";

/** Encode the relative position at `index` in `text` as a serializable number array. */
export function encodeCursor(text: Y.Text, index: number): number[] {
	const relativePosition = Y.createRelativePositionFromTypeIndex(text, index);
	return Array.from(Y.encodeRelativePosition(relativePosition));
}

/**
 * Decode a serialized cursor back into a renderable absolute index within `doc`.
 * Returns undefined if the position can't currently be resolved (e.g. the doc
 * hasn't yet received the items the position refers to).
 */
export function decodeCursor(
	encoded: number[] | undefined,
	doc: Y.Doc,
): number | undefined {
	if (encoded === undefined || encoded.length === 0) return undefined;
	const relativePosition = Y.decodeRelativePosition(Uint8Array.from(encoded));
	const absolutePosition = Y.createAbsolutePositionFromRelativePosition(
		relativePosition,
		doc,
	);
	return absolutePosition ? absolutePosition.index : undefined;
}
