// The collaborative text box. Ported from Kirby Banman's
// multiplayer-tui-prototype (github.com/kdbanman/multiplayer-tui-prototype) and
// adapted to our project: it takes a CollabSession (collab/session.ts) instead
// of module-level Yjs globals, reads keystrokes from Ink's stdin stream, and
// renders every remote participant's cursor rather than a single peer.
//
// Yjs is the single source of truth. React never stores the text; on any Yjs or
// awareness change we bump a version counter to re-render from the doc.
//
// Input is parsed from the raw terminal byte stream rather than ink's
// `useInput`, because `useInput` cannot tell Cmd from Alt and reports the Mac
// Backspace as forward-delete. We need the exact escape sequences for line- and
// word-level editing.

import { Box, Text, useApp, useStdin } from "ink";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { type CollabSession, LOCAL_ORIGIN } from "../collab/session.ts";

const WIDTH = 60; // max characters per visual row
const VISIBLE_ROWS = 8; // fixed number of text rows shown
const DOC_NAME = "shared.txt";

// ---------------------------------------------------------------------------
// Text geometry: split into visual rows honoring newlines + width wrapping.
// ---------------------------------------------------------------------------

interface VisualRow {
	start: number; // string index of the first char on this row
	end: number; // string index just past the last char (where a trailing cursor sits)
	hasNewline: boolean; // whether a '\n' terminates this row
}

function computeRows(text: string, width: number): VisualRow[] {
	const rows: VisualRow[] = [];
	let rowStart = 0;
	let col = 0;
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "\n") {
			rows.push({ start: rowStart, end: i, hasNewline: true });
			rowStart = i + 1;
			col = 0;
		} else {
			col++;
			if (col > width) {
				rows.push({ start: rowStart, end: i, hasNewline: false });
				rowStart = i;
				col = 1;
			}
		}
	}
	rows.push({ start: rowStart, end: text.length, hasNewline: false });
	return rows;
}

function rowOfIndex(rows: VisualRow[], index: number): number {
	for (let r = 0; r < rows.length; r++) {
		if (index <= rows[r].end) return r;
	}
	return rows.length - 1;
}

// ---------------------------------------------------------------------------
// Word / line boundary helpers (operate on the plain string).
// ---------------------------------------------------------------------------

const WORD_RE = /[\p{L}\p{N}_]/u;
const isWord = (character: string | undefined): boolean =>
	character !== undefined && WORD_RE.test(character);

function wordLeft(text: string, i: number): number {
	let j = i;
	while (j > 0 && !isWord(text[j - 1])) j--;
	while (j > 0 && isWord(text[j - 1])) j--;
	return j;
}

function wordRight(text: string, i: number): number {
	let j = i;
	while (j < text.length && !isWord(text[j])) j++;
	while (j < text.length && isWord(text[j])) j++;
	return j;
}

function lineStart(text: string, i: number): number {
	if (i <= 0) return 0;
	return text.lastIndexOf("\n", i - 1) + 1; // -1 -> 0
}

function lineEnd(text: string, i: number): number {
	const newline = text.indexOf("\n", i);
	return newline === -1 ? text.length : newline;
}

// ---------------------------------------------------------------------------
// Raw input parsing.
// ---------------------------------------------------------------------------

const ESC = "\x1b";

// Known multi-byte escape sequences, tried longest/most-specific first.
const ESCAPE_PATTERNS: RegExp[] = [
	/^\x1b\[1;\d+[ABCD]/, // modified arrows: \x1b[1;<mod><A|B|C|D>
	/^\x1b\[3;\d+~/, // modified forward-delete: \x1b[3;<mod>~
	/^\x1b\[\d+~/, // tilde keys: 1~ 3~ 4~ 7~ 8~ ...
	/^\x1b\[[ABCDFH]/, // arrows / End / Home
	/^\x1bO[ABCDFH]/, // application-mode arrows / End / Home
	/^\x1b[\r\n]/, // ESC+Enter — Shift+Enter / Option+Enter (the "ready" chord)
	/^\x1b\x7f/, // Alt+Backspace
	/^\x1b[bBfF]/, // Meta word nav (ESC b / ESC f)
];

function matchEscape(text: string, at: number): string | undefined {
	const sub = text.slice(at);
	for (const pattern of ESCAPE_PATTERNS) {
		const match = pattern.exec(sub);
		if (match) return match[0];
	}
	return undefined;
}

/**
 * Split a raw stdin chunk into individual key tokens. A token is either one
 * recognized escape/control sequence or a maximal run of printable text (so a
 * paste lands as a single insert). Robust against several keypresses arriving
 * batched in one chunk (e.g. key auto-repeat).
 */
export function tokenize(chunk: string): string[] {
	const tokens: string[] = [];
	let i = 0;
	while (i < chunk.length) {
		const code = chunk.charCodeAt(i);
		if (chunk[i] === ESC) {
			const match = matchEscape(chunk, i);
			if (match) {
				tokens.push(match);
				i += match.length;
			} else {
				tokens.push(ESC); // lone / unknown escape
				i += 1;
			}
		} else if (code >= 0x20 && code !== 0x7f) {
			let j = i + 1;
			while (j < chunk.length) {
				const next = chunk.charCodeAt(j);
				if (chunk[j] !== ESC && next >= 0x20 && next !== 0x7f) j++;
				else break;
			}
			tokens.push(chunk.slice(i, j));
			i = j;
		} else {
			tokens.push(chunk[i]); // single control char
			i += 1;
		}
	}
	return tokens;
}

type Direction = "up" | "down" | "left" | "right";

function directionOf(letter: string): Direction | undefined {
	if (letter === "A") return "up";
	if (letter === "B") return "down";
	if (letter === "C") return "right";
	if (letter === "D") return "left";
	return undefined;
}

/** Parse an arrow token into a direction plus an xterm modifier bitfield. */
function parseArrow(seq: string): { dir: Direction; mod: number } | undefined {
	let match = /^\x1b\[([ABCD])$/.exec(seq) ?? /^\x1bO([ABCD])$/.exec(seq);
	if (match) {
		const dir = directionOf(match[1]);
		return dir ? { dir, mod: 0 } : undefined;
	}
	match = /^\x1b\[1;(\d+)([ABCD])$/.exec(seq);
	if (match) {
		const dir = directionOf(match[2]);
		return dir ? { dir, mod: Number.parseInt(match[1], 10) - 1 } : undefined;
	}
	return undefined;
}

const HOME_KEYS = new Set(["\x01", "\x1b[H", "\x1bOH", "\x1b[1~", "\x1b[7~"]);
const END_KEYS = new Set(["\x05", "\x1b[F", "\x1bOF", "\x1b[4~", "\x1b[8~"]);

/**
 * Translate one key token into an edit / cursor move against the session. All
 * edits go through the local Y.Text in a transaction tagged LOCAL_ORIGIN; the
 * cursor is republished to awareness as a relative position.
 */
export function applyKey(
	session: CollabSession,
	seq: string,
	exit: () => void,
): void {
	// Every edit clears the ready flag: changing the draft means you're no longer
	// signed off on it. setReady(false) is a no-op when already un-ready.
	const insert = (index: number, value: string): void => {
		session.doc.transact(() => session.text.insert(index, value), LOCAL_ORIGIN);
		session.setReady(false);
	};
	const remove = (index: number, count: number): void => {
		session.doc.transact(() => session.text.delete(index, count), LOCAL_ORIGIN);
		session.setReady(false);
	};

	if (seq === "\x03") {
		exit(); // Ctrl+C
		return;
	}
	if (seq === "\x1a") {
		session.undoManager.undo(); // Ctrl+Z
		return;
	}
	if (seq === "\x19") {
		session.undoManager.redo(); // Ctrl+Y
		return;
	}

	// Toggle "ready to send". Ctrl+S is the reliable chord — it reaches the app
	// identically in every terminal (raw mode disables its legacy XOFF meaning).
	// Shift+Enter / Option+Enter also work where the terminal emits ESC+Enter
	// (Ghostty, kitty); iTerm2 and Terminal.app don't by default. Plain Enter (a
	// bare \r) stays a newline below. When everyone is ready the host sends the
	// draft (see collab/session.ts).
	if (seq === "\x13" || seq === "\x1b\r" || seq === "\x1b\n") {
		session.setReady(!session.isReady());
		return;
	}

	const text = session.text.toString();
	const len = text.length;
	const idx = session.getLocalIndex();

	// ---- Deletion ----
	if (seq === "\x7f") {
		if (idx > 0) {
			remove(idx - 1, 1);
			session.publishCursor(idx - 1);
		}
		return;
	}
	if (seq === "\x1b\x7f" || seq === "\x17") {
		// Alt+Backspace / Ctrl+W -> delete the word before the cursor.
		const from = wordLeft(text, idx);
		if (from < idx) {
			remove(from, idx - from);
			session.publishCursor(from);
		}
		return;
	}
	if (seq === "\x15") {
		// Ctrl+U / Cmd+Backspace -> delete from line start to the cursor.
		const from = lineStart(text, idx);
		if (from < idx) {
			remove(from, idx - from);
			session.publishCursor(from);
		}
		return;
	}
	if (seq === "\x1b[3~") {
		// Forward delete.
		if (idx < len) {
			remove(idx, 1);
			session.publishCursor(idx);
		}
		return;
	}
	if (/^\x1b\[3;\d+~$/.test(seq)) {
		// Alt+Forward-delete -> delete the word after the cursor.
		const to = wordRight(text, idx);
		if (to > idx) {
			remove(idx, to - idx);
			session.publishCursor(idx);
		}
		return;
	}

	// ---- Newline ----
	if (seq === "\r" || seq === "\n") {
		insert(idx, "\n");
		session.publishCursor(idx + 1);
		return;
	}

	// ---- Line navigation (Cmd, Ctrl+A/E, Home/End) ----
	if (HOME_KEYS.has(seq)) {
		session.publishCursor(lineStart(text, idx));
		return;
	}
	if (END_KEYS.has(seq)) {
		session.publishCursor(lineEnd(text, idx));
		return;
	}

	// ---- Word navigation (Option as Meta: ESC b / ESC f) ----
	if (seq === "\x1bb" || seq === "\x1bB") {
		session.publishCursor(wordLeft(text, idx));
		return;
	}
	if (seq === "\x1bf" || seq === "\x1bF") {
		session.publishCursor(wordRight(text, idx));
		return;
	}

	// ---- Arrow keys (with optional modifiers) ----
	const arrow = parseArrow(seq);
	if (arrow) {
		const alt = (arrow.mod & 2) !== 0;
		const ctrl = (arrow.mod & 4) !== 0;
		const cmd = (arrow.mod & 8) !== 0;
		switch (arrow.dir) {
			case "left":
				session.publishCursor(
					cmd
						? lineStart(text, idx)
						: alt || ctrl
							? wordLeft(text, idx)
							: Math.max(0, idx - 1),
				);
				return;
			case "right":
				session.publishCursor(
					cmd
						? lineEnd(text, idx)
						: alt || ctrl
							? wordRight(text, idx)
							: Math.min(len, idx + 1),
				);
				return;
			default: {
				if (cmd) {
					session.publishCursor(arrow.dir === "up" ? 0 : len);
					return;
				}
				const rows = computeRows(text, WIDTH);
				const r = rowOfIndex(rows, idx);
				const col = idx - rows[r].start;
				const targetRow = Math.max(
					0,
					Math.min(rows.length - 1, r + (arrow.dir === "up" ? -1 : 1)),
				);
				const target = rows[targetRow];
				session.publishCursor(Math.min(target.start + col, target.end));
				return;
			}
		}
	}

	// ---- Printable text / paste (insert as one chunk) ----
	if (!seq.startsWith(ESC) && seq.charCodeAt(0) >= 0x20 && seq !== "\x7f") {
		insert(idx, seq);
		session.publishCursor(idx + seq.length);
	}
}

// ---------------------------------------------------------------------------
// Rendering.
// ---------------------------------------------------------------------------

function cell(
	character: string,
	index: number,
	localIndex: number,
	remoteColor: string | undefined,
	key: string,
): ReactElement {
	const isLocal = index === localIndex;
	const display = character === "" || character === "\n" ? " " : character;

	if (isLocal && remoteColor !== undefined) {
		return (
			<Text
				key={key}
				backgroundColor={remoteColor}
				color="black"
				underline
				bold
			>
				{display}
			</Text>
		);
	}
	if (isLocal) {
		return (
			<Text key={key} inverse>
				{display}
			</Text>
		);
	}
	if (remoteColor !== undefined) {
		return (
			<Text key={key} backgroundColor={remoteColor} color="black">
				{display}
			</Text>
		);
	}
	return <Text key={key}>{display}</Text>;
}

export function Editor({ session }: { session: CollabSession }): ReactElement {
	const { exit } = useApp();
	const { stdin, setRawMode } = useStdin();
	const [, setVersion] = useState(0);
	const localOps = useRef(0);

	// Subscribe to Yjs as the single source of truth; React only mirrors it.
	useEffect(() => {
		session.publishCursor(session.text.length);

		const onText = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
			if (transaction.origin === LOCAL_ORIGIN) localOps.current += 1;
			setVersion((version) => version + 1);
		};
		const onAwareness = () => setVersion((version) => version + 1);
		const onMessages = () => setVersion((version) => version + 1);

		session.text.observe(onText);
		session.awareness.on("change", onAwareness);
		session.messages.observe(onMessages);
		return () => {
			session.text.unobserve(onText);
			session.awareness.off("change", onAwareness);
			session.messages.unobserve(onMessages);
		};
	}, [session]);

	// Drive editing from the raw terminal byte stream (see applyKey above).
	useEffect(() => {
		if (stdin === undefined) return;
		setRawMode(true);
		const onData = (chunk: Buffer | string) => {
			const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			tokenize(data).forEach((token) => applyKey(session, token, exit));
		};
		stdin.on("data", onData);
		return () => {
			stdin.off("data", onData);
			setRawMode(false);
		};
	}, [stdin, setRawMode, exit, session]);

	// ---- Render straight from Yjs ----
	const text = session.text.toString();
	const localIndex = session.getLocalIndex();
	const remoteCursors = session.getRemoteCursors();
	const sentMessages = session.messages.toArray();
	const localReady = session.isReady();
	const participantCount = 1 + remoteCursors.length;
	const readyCount =
		(localReady ? 1 : 0) +
		remoteCursors.filter((cursor) => cursor.ready).length;
	const everyoneReady = readyCount === participantCount;

	// index -> color for the first remote cursor sitting on each cell.
	const remoteByIndex = new Map<number, string>();
	remoteCursors.forEach((cursor) => {
		if (cursor.index !== undefined && !remoteByIndex.has(cursor.index)) {
			remoteByIndex.set(cursor.index, cursor.user.color);
		}
	});

	const rows = computeRows(text, WIDTH);

	// Vertical window so the local cursor stays in view in the fixed-height box.
	const localRow = rowOfIndex(rows, localIndex);
	let startRow = 0;
	if (rows.length > VISIBLE_ROWS) {
		startRow = Math.max(
			0,
			Math.min(
				localRow - Math.floor(VISIBLE_ROWS / 2),
				rows.length - VISIBLE_ROWS,
			),
		);
	}

	const rendered: ReactNode[] = [];
	for (let vr = 0; vr < VISIBLE_ROWS; vr++) {
		const globalRow = startRow + vr;
		const row = rows[globalRow];
		if (!row) {
			rendered.push(<Text key={vr}> </Text>);
			continue;
		}
		const spans: ReactNode[] = [];
		for (let i = row.start; i < row.end; i++) {
			spans.push(
				cell(text[i], i, localIndex, remoteByIndex.get(i), `${vr}:${i}`),
			);
		}
		const showTrailing = row.hasNewline || globalRow === rows.length - 1;
		if (
			showTrailing &&
			(localIndex === row.end || remoteByIndex.has(row.end))
		) {
			spans.push(
				cell(
					" ",
					row.end,
					localIndex,
					remoteByIndex.get(row.end),
					`${vr}:trail`,
				),
			);
		}
		if (spans.length === 0) {
			rendered.push(<Text key={vr}> </Text>);
			continue;
		}
		rendered.push(
			<Text key={vr} wrap="truncate">
				{spans}
			</Text>,
		);
	}

	return (
		<Box flexDirection="column" marginTop={1}>
			{sentMessages.length > 0 && (
				<Box flexDirection="column" marginBottom={1}>
					<Text color="gray">┄ sent to the agent ┄</Text>
					{sentMessages.map((message, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the log is append-only, so a row's index never changes
						<Text key={index} wrap="truncate">
							<Text color="cyan">▸ </Text>
							{message}
						</Text>
					))}
				</Box>
			)}
			<Text>
				<Text color="gray">┄ </Text>
				<Text bold>{DOC_NAME}</Text>
				<Text color="gray"> ┄ co-draft it together, ⌃s when you're ready</Text>
			</Text>
			<Box
				borderStyle="round"
				borderColor={everyoneReady ? "green" : "gray"}
				width={WIDTH + 4}
				flexDirection="column"
				paddingX={1}
			>
				{rendered}
			</Box>
			<Box marginTop={1}>
				<Text color={everyoneReady ? "green" : "yellow"}>
					{readyCount}/{participantCount} ready
				</Text>
				<Text color="gray">
					{everyoneReady ? " · sending…" : " · ⌃s toggles ready"}
				</Text>
			</Box>
			<Box marginTop={1} flexDirection="column">
				<Box>
					<Text color={session.user.color}>● </Text>
					<Text bold>{session.user.name}</Text>
					<Text color="gray"> (you · {localOps.current} edits) </Text>
					{localReady ? (
						<Text color="green">✓ ready</Text>
					) : (
						<Text color="gray">○ drafting</Text>
					)}
				</Box>
				{remoteCursors.map((cursor) => (
					<Box key={cursor.clientId}>
						<Text color={cursor.user.color}>● </Text>
						<Text bold>{cursor.user.name} </Text>
						{cursor.ready ? (
							<Text color="green">✓ ready</Text>
						) : (
							<Text color="gray">○ drafting</Text>
						)}
					</Box>
				))}
				{remoteCursors.length === 0 && (
					<Text color="gray"> …no one else here yet — share the link.</Text>
				)}
			</Box>
			<Text color="gray">move: ←→ char · ⌥←→ word · ⌘←→ line · ⌘↑↓ doc</Text>
			<Text color="gray">
				edit: ⌫ char · ⌥⌫ word · ⌘⌫ line · ⏎ newline · ⌃z undo · ⌃y redo · ⌃c
				quit
			</Text>
		</Box>
	);
}
