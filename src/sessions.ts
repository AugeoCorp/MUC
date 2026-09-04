// Keeping what the room sent.
//
// Once everyone has signed off, the server appends the draft to the shared log
// and clears the box (see collab/session.ts) — at which point the draft only
// exists in memory, in a session that ends when the host stops serving. This
// writes it down as it goes.
//
// The collaboration layer decides *when* something is sent; this decides where
// it lands. They stay apart so that a Yjs doc never learns about the disk.

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Relative to wherever `muc serve` was run from. */
const DIRECTORY = "sessions";

/**
 * Write one submitted draft to `sessions/<timestamp>--<hash>.md`, returning the
 * path it landed at. The hash is of the content, so two drafts sent in the same
 * second can't collide, and the same text sent twice is recognisable at a
 * glance.
 */
export async function saveSubmission(
	content: string,
	at: Date,
): Promise<string> {
	await mkdir(DIRECTORY, { recursive: true });
	const path = join(DIRECTORY, `${stamp(at)}--${shortHash(content)}.md`);
	await writeFile(path, content.endsWith("\n") ? content : `${content}\n`);
	return path;
}

function stamp(at: Date): string {
	// ISO 8601 without the milliseconds, and with the colons swapped for
	// hyphens: colons are illegal in Windows filenames and need quoting in most
	// shells, which is a poor trade for a punctuation mark.
	return at
		.toISOString()
		.replace(/\.\d+Z$/, "Z")
		.replaceAll(":", "-");
}

function shortHash(content: string): string {
	return createHash("sha256").update(content).digest("hex").slice(0, 8);
}
