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

import { Box, Text, useApp, useStdin, useStdout, useWindowSize } from "ink";
import type { ReactElement, ReactNode } from "react";
import { useEffect, useRef, useState } from "react";
import type * as Y from "yjs";
import { type CollabSession, LOCAL_ORIGIN } from "../collab/session.ts";
import { Participant } from "./Participant.tsx";
import { useConfirmQuit } from "./useConfirmQuit.ts";

// The box spans the terminal: the app's own padding (1 each side) and the
// scrollbar gutter on the right are all that sit between the draft and the
// edge. The gutter is reserved even when there's nothing to scroll, so the
// draft doesn't reflow the moment it grows past the box.
const CHROME_COLUMNS = 3;
const MIN_WIDTH = 20;

// The box takes the whole terminal apart from the chrome: the title row, the
// rule above and below the draft, and the three footer rows. Keep this in step
// with what App and the footer actually render — if the frame ever ends up
// taller than the terminal, it scrolls its own top line away as you type.
const CHROME_ROWS = 6;
const MIN_ROWS = 3;

// ⌃t toggles the authorship lens. Chosen because it's free in every chord the
// editor already claims, and — unlike ⌃b — it isn't tmux's prefix key.
const TOGGLE_AUTHORS = "\x14";

// Handled in the component rather than applyKey — quitting isn't an edit, and
// it takes two presses (see useConfirmQuit).
const QUIT = "\x03";

const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
// One line of overlap between pages, so nothing passes by unread.
const PAGE_OVERLAP = 1;

// Mouse reporting. 1002 reports presses, releases and motion while a button is
// held; 1006 asks for the SGR encoding, which — unlike the original scheme —
// survives past column 223. While this is on, the terminal hands us the mouse
// instead of acting on it, so its own click-drag selection stops working:
// selection has to be reimplemented here (with OSC 52 to reach the clipboard)
// before this is a fair trade. Holding Shift bypasses capture meanwhile.
const MOUSE_ON = "\x1b[?1002h\x1b[?1006h";
const MOUSE_OFF = "\x1b[?1006l\x1b[?1002l";

// Rows above the draft — the title and the rule — for turning the terminal row
// in a mouse report into a row of the box.
const HEADER_ROWS = 2;

const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const LEFT_BUTTON = 0;
const LEFT_BUTTON_HELD = 32; // motion with the left button down
const WHEEL_STEP = 3;

const MOUSE_PATTERN = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/;

interface MouseReport {
	button: number;
	/** Both 1-based, counted from the top-left of the terminal. */
	column: number;
	row: number;
	pressed: boolean;
}

/** Read one SGR mouse report, or undefined if the token isn't one. */
export function parseMouse(seq: string): MouseReport | undefined {
	const match = MOUSE_PATTERN.exec(seq);
	if (match === null) return undefined;
	return {
		button: Number.parseInt(match[1], 10),
		column: Number.parseInt(match[2], 10),
		row: Number.parseInt(match[3], 10),
		pressed: match[4] === "M",
	};
}

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
	/^\x1b\[<\d+;\d+;\d+[Mm]/, // SGR mouse report — see parseMouse
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
 * cursor is republished to awareness as a relative position. `width` is the
 * current text column, which only up / down need — they move by visual row.
 */
export function applyKey(
	session: CollabSession,
	seq: string,
	width: number,
): void {
	// Every edit clears the ready flag: changing the draft means you're no longer
	// signed off on it. setReady(false) is a no-op when already un-ready.
	// Every insert is stamped with who made it, which is what the authorship lens
	// (⌃t) reads back. Yjs already knows internally; the attribute just puts it
	// somewhere public.
	const insert = (index: number, value: string): void => {
		session.doc.transact(
			() => session.text.insert(index, value, { author: session.doc.clientID }),
			LOCAL_ORIGIN,
		);
		session.setReady(false);
	};
	const remove = (index: number, count: number): void => {
		session.doc.transact(() => session.text.delete(index, count), LOCAL_ORIGIN);
		session.setReady(false);
	};

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
				const rows = computeRows(text, width);
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

interface CellProps {
	character: string;
	key: string;
	/** True when the local cursor sits on this character. */
	isLocalCursor: boolean;
	/** Set when a remote cursor sits here — their color. */
	remoteColor: string | undefined;
	/** Set only while the authorship lens is on — who wrote this character. */
	authorColor: string | undefined;
}

// A cursor sitting on a character always wins over the authorship tint: where
// someone is is more urgent than who typed it, and the two would fight for the
// same color slot.
function cell({
	character,
	key,
	isLocalCursor,
	remoteColor,
	authorColor,
}: CellProps): ReactElement {
	const display = character === "" || character === "\n" ? " " : character;

	if (isLocalCursor && remoteColor !== undefined) {
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
	if (isLocalCursor) {
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
	return (
		<Text key={key} color={authorColor}>
			{display}
		</Text>
	);
}

interface EditorProps {
	session: CollabSession;
	/** Set when hosting — shown in the footer so others can be invited. */
	shareCode?: string;
}

export function Editor({ session, shareCode }: EditorProps): ReactElement {
	const { exit } = useApp();
	const { stdin, setRawMode } = useStdin();
	const { stdout } = useStdout();
	const { rows: terminalRows, columns: terminalColumns } = useWindowSize();
	const textWidth = Math.max(MIN_WIDTH, terminalColumns - CHROME_COLUMNS);
	// The authorship lens: off by default, because a permanently multi-colored
	// draft is harder to read than the plain one.
	const [showAuthors, setShowAuthors] = useState(false);
	// Where the view sits when the reader has taken it somewhere the cursor
	// isn't. Undefined means "follow the cursor", which is the resting state —
	// typing anything puts it back.
	const [scrolledTo, setScrolledTo] = useState<number>();
	const {
		armed: quitArmed,
		press: pressQuit,
		cancel: cancelQuit,
	} = useConfirmQuit();
	// What the key and mouse handlers need to know about a render they can't see.
	const view = useRef({
		startRow: 0,
		visibleRows: 1,
		totalRows: 1,
		gutterColumn: 1,
	});
	const [, setVersion] = useState(0);
	const localOps = useRef(0);

	// Subscribe to Yjs as the single source of truth; React only mirrors it.
	useEffect(() => {
		session.publishCursor(session.text.length);

		const onText = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
			if (transaction.origin === LOCAL_ORIGIN) localOps.current += 1;
			setVersion((version) => version + 1);
		};
		const bump = () => setVersion((version) => version + 1);

		session.text.observe(onText);
		session.awareness.on("change", bump);
		// The server reassigns colors as people come and go.
		session.colors.observe(bump);
		return () => {
			session.text.unobserve(onText);
			session.awareness.off("change", bump);
			session.colors.unobserve(bump);
		};
	}, [session]);

	// Ask the terminal for mouse reports, and give the mouse back on the way out.
	// Ink's unmount covers a clean quit; the exit hook covers the paths that skip
	// it, since a terminal left in reporting mode prints `[<0;12;4M` at the shell
	// on every click and needs a `reset` to recover.
	useEffect(() => {
		if (stdin === undefined) return;
		stdout.write(MOUSE_ON);
		const restore = (): void => {
			stdout.write(MOUSE_OFF);
		};
		process.once("exit", restore);
		return () => {
			restore();
			process.off("exit", restore);
		};
	}, [stdin, stdout]);

	// Drive editing from the raw terminal byte stream (see applyKey above).
	useEffect(() => {
		if (stdin === undefined) return;
		setRawMode(true);
		const onData = (chunk: Buffer | string) => {
			const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			// Moves the view without touching the cursor, clamped to the draft.
			const scrollBy = (lines: number): void => {
				const { startRow, visibleRows, totalRows } = view.current;
				const furthest = Math.max(0, totalRows - visibleRows);
				setScrolledTo(Math.max(0, Math.min(furthest, startRow + lines)));
			};

			// A press anywhere on the gutter jumps proportionally: click near the
			// top and you're near the top of the draft. Motion with the button held
			// arrives the same way, so the thumb drags for free.
			const scrollToGutter = (report: MouseReport): void => {
				const { visibleRows, totalRows, gutterColumn } = view.current;
				if (report.column !== gutterColumn) return;
				const offset = report.row - (HEADER_ROWS + 1);
				if (offset < 0 || offset >= visibleRows) return;
				const furthest = Math.max(0, totalRows - visibleRows);
				const reach = Math.max(1, visibleRows - 1);
				setScrolledTo(Math.round((offset / reach) * furthest));
			};

			const handleMouse = (report: MouseReport): void => {
				if (report.button === WHEEL_UP) scrollBy(-WHEEL_STEP);
				else if (report.button === WHEEL_DOWN) scrollBy(WHEEL_STEP);
				else if (
					report.pressed &&
					(report.button === LEFT_BUTTON || report.button === LEFT_BUTTON_HELD)
				) {
					scrollToGutter(report);
				}
			};

			tokenize(data).forEach((token) => {
				const mouse = parseMouse(token);
				if (mouse !== undefined) {
					handleMouse(mouse);
					return;
				}
				// These three are handled here rather than in applyKey: they change
				// how the draft is drawn, not what it says, so they never touch the
				// document.
				if (token === TOGGLE_AUTHORS) {
					setShowAuthors((shown) => !shown);
					return;
				}
				if (token === PAGE_UP || token === PAGE_DOWN) {
					const page = Math.max(1, view.current.visibleRows - PAGE_OVERLAP);
					scrollBy(token === PAGE_UP ? -page : page);
					return;
				}
				if (token === QUIT) {
					if (pressQuit()) exit();
					return;
				}
				// Any other key means they've thought better of quitting.
				cancelQuit();
				// It's an edit or a cursor move, so the view goes back to wherever the
				// cursor is — you can't type off-screen.
				setScrolledTo(undefined);
				applyKey(session, token, textWidth);
			});
		};
		stdin.on("data", onData);
		return () => {
			stdin.off("data", onData);
			setRawMode(false);
		};
	}, [stdin, setRawMode, exit, session, textWidth, pressQuit, cancelQuit]);

	// ---- Render straight from Yjs ----
	const text = session.text.toString();
	const localIndex = session.getLocalIndex();
	const remoteCursors = session.getRemoteCursors();
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

	// Only paid for while the lens is on. One color lookup per author rather than
	// per character, since a draft is mostly long runs by the same person.
	const authors = showAuthors ? session.getAuthors() : undefined;
	const authorColors = new Map<number, string | undefined>();
	function authorColorAt(index: number): string | undefined {
		const clientId = authors?.[index];
		if (clientId === undefined) return undefined;
		if (!authorColors.has(clientId)) {
			authorColors.set(clientId, session.colorFor(clientId));
		}
		return authorColors.get(clientId);
	}

	const rows = computeRows(text, textWidth);

	// The draft fills whatever the chrome leaves, however short it is.
	const visibleRows = Math.max(MIN_ROWS, terminalRows - CHROME_ROWS);

	// Vertical window. Normally it follows the cursor; while the reader has
	// paged away from it, their position wins — clamped here rather than when it
	// was set, since the draft may have grown or shrunk underneath them.
	const localRow = rowOfIndex(rows, localIndex);
	const furthestStart = Math.max(0, rows.length - visibleRows);
	let startRow = 0;
	if (scrolledTo !== undefined) {
		startRow = Math.max(0, Math.min(scrolledTo, furthestStart));
	} else if (rows.length > visibleRows) {
		startRow = Math.max(
			0,
			Math.min(localRow - Math.floor(visibleRows / 2), furthestStart),
		);
	}

	// Read back by the handlers on the next keypress or mouse report. The gutter
	// column is 1-based: one column of app padding, then the text, then the bar.
	view.current = {
		startRow,
		visibleRows,
		totalRows: rows.length,
		gutterColumn: textWidth + 2,
	};

	const rendered: ReactNode[] = [];
	for (let vr = 0; vr < visibleRows; vr++) {
		const globalRow = startRow + vr;
		const row = rows[globalRow];
		if (!row) {
			rendered.push(<Text key={vr}> </Text>);
			continue;
		}
		const spans: ReactNode[] = [];
		for (let i = row.start; i < row.end; i++) {
			spans.push(
				cell({
					character: text[i],
					key: `${vr}:${i}`,
					isLocalCursor: i === localIndex,
					remoteColor: remoteByIndex.get(i),
					authorColor: authorColorAt(i),
				}),
			);
		}
		const showTrailing = row.hasNewline || globalRow === rows.length - 1;
		if (
			showTrailing &&
			(localIndex === row.end || remoteByIndex.has(row.end))
		) {
			spans.push(
				cell({
					character: " ",
					key: `${vr}:trail`,
					isLocalCursor: localIndex === row.end,
					remoteColor: remoteByIndex.get(row.end),
					authorColor: undefined,
				}),
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

	// The gutter: a thumb sized by how much of the draft is on screen, positioned
	// by how far down it you are. Blank rather than absent when it all fits, so
	// the column stays reserved and the text never reflows.
	const scrollable = rows.length > visibleRows;
	const thumbRows = scrollable
		? Math.max(1, Math.round((visibleRows * visibleRows) / rows.length))
		: 0;
	const thumbStart =
		furthestStart === 0
			? 0
			: Math.round((startRow / furthestStart) * (visibleRows - thumbRows));

	const gutter: ReactNode[] = [];
	for (let vr = 0; vr < visibleRows; vr++) {
		if (!scrollable) {
			gutter.push(<Text key={vr}> </Text>);
			continue;
		}
		const onThumb = vr >= thumbStart && vr < thumbStart + thumbRows;
		gutter.push(
			<Text key={vr} color="gray" dimColor={!onThumb}>
				{onThumb ? "┃" : "│"}
			</Text>,
		);
	}

	return (
		<Box flexDirection="column">
			{/* The sent-message log used to sit here. It's still in the document and
			    still on the server's screen — it just doesn't compete with the draft
			    for height any more. */}
			{/* Heavy rules above and below, no sides — the draft runs the full
			    width of the terminal between them. */}
			<Box
				borderStyle="bold"
				borderLeft={false}
				borderRight={false}
				borderColor={everyoneReady ? "green" : "gray"}
				width={textWidth + 1}
				flexDirection="row"
			>
				<Box width={textWidth} flexDirection="column">
					{rendered}
				</Box>
				<Box width={1} flexDirection="column">
					{gutter}
				</Box>
			</Box>
			{/* The footer: where the draft stands, then who's here, then the keys.
			    The invite sits beside the ready count because both are things you
			    act on — one tells you who you're waiting for, the other how to
			    stop waiting. */}
			<Text wrap="truncate-end">
				<Text color={everyoneReady ? "green" : "yellow"}>
					{readyCount}/{participantCount} ready
				</Text>
				<Text color="gray">
					{everyoneReady ? " · sending…" : " · ⌃s toggles ready"}
				</Text>
				{shareCode !== undefined && (
					<>
						<Text color="gray"> · invite: </Text>
						<Text color="greenBright" bold>
							muc connect {shareCode}
						</Text>
					</>
				)}
			</Text>
			{/* Everyone on one row rather than one row each: ✓ / ○ carry the ready
			    state that the count above spells out in words. */}
			<Text wrap="truncate-end">
				<Participant
					user={{ ...session.user, color: session.localColor() }}
					ready={localReady}
					note={`you · ${localOps.current} edits`}
				/>
				{remoteCursors.map((cursor) => (
					<Text key={cursor.clientId}>
						<Text color="gray"> · </Text>
						<Participant user={cursor.user} ready={cursor.ready} />
					</Text>
				))}
				{remoteCursors.length === 0 && (
					<Text color="gray"> · no one else here yet</Text>
				)}
			</Text>
			{/* The ⌃t hint doubles as the lens's only indicator: lit while it's on,
			    so a multi-colored draft always has something saying why. */}
			<Text wrap="truncate-end">
				<Text color="gray">
					←→ move · ⌥/⌘←→ word/line · ⇞⇟ scroll · ⇧drag select · ⌃z/⌃y undo ·{" "}
				</Text>
				<Text color={showAuthors ? "cyan" : "gray"} bold={showAuthors}>
					⌃t authors
				</Text>
				{quitArmed ? (
					<Text color="yellow" bold>
						{" "}
						· ⌃c again to quit
					</Text>
				) : (
					<Text color="gray"> · ⌃c quit</Text>
				)}
			</Text>
		</Box>
	);
}
