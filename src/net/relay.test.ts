import { connect } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { BODY_LIMIT_BYTES } from "../utilities/readBody.ts";
import {
	AWARENESS_RETENTION_MILLISECONDS,
	DOCUMENT_COMPACTION_THRESHOLD,
	type Relay,
	startRelay,
} from "./relay.ts";

interface MessagesResponse {
	cursor: number;
	items: string[];
}

describe("startRelay", () => {
	let relay: Relay;

	beforeEach(async () => {
		relay = await startRelay();
	});

	afterEach(async () => {
		await relay.close();
		vi.restoreAllMocks();
	});

	async function send(body: string): Promise<void> {
		await fetch(`http://127.0.0.1:${relay.port}/send`, {
			method: "POST",
			body,
		});
	}

	async function fetchMessages(
		since: number | string,
	): Promise<MessagesResponse> {
		const response = await fetch(
			`http://127.0.0.1:${relay.port}/messages?since=${since}`,
		);
		return (await response.json()) as MessagesResponse;
	}

	it("replays opaque frames and resumes from a cursor", async () => {
		await send("alpha");
		await send("   "); // whitespace-only bodies are ignored
		await send("beta");
		await send("gamma");

		const fromStart = await fetchMessages(0);
		expect(fromStart.cursor).toBe(3);
		expect(fromStart.items).toEqual(["alpha", "beta", "gamma"]);

		const resumed = await fetchMessages(2);
		expect(resumed.cursor).toBe(3);
		expect(resumed.items).toEqual(["gamma"]);

		const garbageCursor = await fetchMessages("nonsense");
		expect(garbageCursor.items).toEqual(["alpha", "beta", "gamma"]);
	});

	it("survives a client aborting a POST mid-body", async () => {
		await send("alpha");

		// Open a raw socket, declare a longer body than we send, then destroy
		// the connection so the request stream errors server-side.
		const socket = connect(relay.port, "127.0.0.1");
		await new Promise((resolve) => socket.once("connect", resolve));
		socket.write(
			"POST /send HTTP/1.1\r\nHost: relay\r\nContent-Length: 64\r\n\r\npartial",
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		socket.destroy();
		await new Promise((resolve) => setTimeout(resolve, 50));

		// The relay is still alive and the half-received frame never landed.
		await send("beta");
		const after = await fetchMessages(0);
		expect(after.items).toEqual(["alpha", "beta"]);
	});

	it("compacts document frames past the threshold into one merged update", async () => {
		const frameCount = DOCUMENT_COMPACTION_THRESHOLD + 10;
		const { frames, expectedText } = createDocumentFrames(frameCount);
		await frames.reduce(
			(previous, frame) => previous.then(() => send(frame)),
			Promise.resolve(),
		);

		const replay = await fetchMessages(0);
		expect(replay.cursor).toBe(frameCount);
		// One merged frame absorbed the first 50; the 10 after it are loose.
		expect(replay.items.length).toBe(11);
		expect(rebuildText(replay.items)).toBe(expectedText);
	});

	it("delivers the merged frame to a mid-run cursor and converges", async () => {
		const frameCount = DOCUMENT_COMPACTION_THRESHOLD + 10;
		const { frames, expectedText } = createDocumentFrames(frameCount);

		const firstBatch = frames.slice(0, 30);
		const secondBatch = frames.slice(30);
		await firstBatch.reduce(
			(previous, frame) => previous.then(() => send(frame)),
			Promise.resolve(),
		);
		const beforeCompaction = await fetchMessages(0);
		expect(beforeCompaction.cursor).toBe(30);
		expect(beforeCompaction.items.length).toBe(30);

		await secondBatch.reduce(
			(previous, frame) => previous.then(() => send(frame)),
			Promise.resolve(),
		);
		// The client's cursor (30) sits inside the run the merge absorbed
		// (1–50), so it receives the merged frame plus the loose tail.
		const afterCompaction = await fetchMessages(beforeCompaction.cursor);
		expect(afterCompaction.cursor).toBe(frameCount);
		expect(afterCompaction.items.length).toBe(11);
		expect(
			rebuildText([...beforeCompaction.items, ...afterCompaction.items]),
		).toBe(expectedText);
	});

	it("ages awareness frames out of the replay", async () => {
		const clock = installClock();

		await send(awarenessFrame("early-1"));
		await send(awarenessFrame("early-2"));
		clock.advance(AWARENESS_RETENTION_MILLISECONDS + 1_000);
		await send(awarenessFrame("recent"));

		const replay = await fetchMessages(0);
		expect(replay.cursor).toBe(3);
		expect(replay.items).toEqual([awarenessFrame("recent")]);

		// Pruning also happens on read, so ghosts fade with no new traffic.
		clock.advance(AWARENESS_RETENTION_MILLISECONDS + 1_000);
		const later = await fetchMessages(0);
		expect(later.cursor).toBe(3);
		expect(later.items).toEqual([]);
	});

	it("preserves per-type behavior and ordering under mixed traffic", async () => {
		const { frames } = createDocumentFrames(2);
		const mixed = [
			frames[0],
			awarenessFrame("presence-1"),
			"plain text",
			frames[1],
			awarenessFrame("presence-2"),
			JSON.stringify({ hello: "world" }),
		];
		await mixed.reduce(
			(previous, frame) => previous.then(() => send(frame)),
			Promise.resolve(),
		);

		const replay = await fetchMessages(0);
		expect(replay.cursor).toBe(mixed.length);
		expect(replay.items).toEqual(mixed);

		const resumed = await fetchMessages(4);
		expect(resumed.items).toEqual(mixed.slice(4));
	});

	it("treats undecodable document-shaped frames as opaque, never merging them", async () => {
		const bogus = JSON.stringify({ t: "u", d: "!!!not-a-yjs-update!!!" });
		await send(bogus);
		const { frames, expectedText } = createDocumentFrames(
			DOCUMENT_COMPACTION_THRESHOLD,
		);
		await frames.reduce(
			(previous, frame) => previous.then(() => send(frame)),
			Promise.resolve(),
		);

		const replay = await fetchMessages(0);
		expect(replay.items.length).toBe(2);
		expect(replay.items[0]).toBe(bogus);
		expect(rebuildText(replay.items.slice(1))).toBe(expectedText);
	});

	it("keeps an awareness frame between the document runs it separated", async () => {
		const { frames, expectedText } = createDocumentFrames(
			DOCUMENT_COMPACTION_THRESHOLD + 1,
		);
		const before = frames.slice(0, DOCUMENT_COMPACTION_THRESHOLD - 1);
		const after = frames.slice(DOCUMENT_COMPACTION_THRESHOLD - 1);
		const traffic = [...before, awarenessFrame("ready"), ...after];
		await traffic.reduce(
			(previous, frame) => previous.then(() => send(frame)),
			Promise.resolve(),
		);

		// The threshold tripped on the last frame, so the run before the
		// awareness frame merged. The frames after it must still follow it.
		const replay = await fetchMessages(10);
		const kinds = replay.items.map(
			(item) => (JSON.parse(item) as { t: string }).t,
		);
		expect(kinds).toEqual(["u", "a", "u", "u"]);
		expect(rebuildText(replay.items)).toBe(expectedText);
	});

	it("answers 413 to an oversized body and stays up", async () => {
		const response = await fetch(`http://127.0.0.1:${relay.port}/send`, {
			method: "POST",
			body: "x".repeat(BODY_LIMIT_BYTES + 1),
		});
		expect(response.status).toBe(413);

		await send("alive");
		const replay = await fetchMessages(0);
		expect(replay.items).toEqual(["alive"]);
	});

	it("keeps a 500-frame session's replay bounded", async () => {
		const clock = installClock();
		const totalFrames = 500;
		const { frames, expectedText } = createDocumentFrames(totalFrames / 2);
		const traffic = frames.flatMap((frame, index) => [
			frame,
			awarenessFrame(`keepalive-${index}`),
		]);

		await traffic.reduce(
			(previous, frame) =>
				previous.then(() => {
					clock.advance(1_000); // one frame a second, an 8-minute session
					return send(frame);
				}),
			Promise.resolve(),
		);

		const replay = await fetchMessages(0);
		expect(replay.cursor).toBe(totalFrames);
		// Far fewer than the 500 posted: at most 50 document frames survive
		// between merges, and only ~90 seconds of awareness remains.
		expect(replay.items.length).toBeLessThan(120);
		expect(rebuildText(replay.items)).toBe(expectedText);
	});
});

// Build one Yjs update frame per inserted character, the way the collab
// session does: each local edit emits a binary update, base64-wrapped as
// {t:"u", d}. Returns the frames and the text they reconstruct.
function createDocumentFrames(characterCount: number): {
	frames: string[];
	expectedText: string;
} {
	const alphabet = "abcdefghijklmnopqrstuvwxyz";
	const expectedText = Array.from(
		{ length: characterCount },
		(_, index) => alphabet[index % alphabet.length],
	).join("");
	const doc = new Y.Doc();
	const text = doc.getText("content");
	const frames: string[] = [];
	doc.on("update", (update: Uint8Array) => {
		frames.push(
			JSON.stringify({ t: "u", d: Buffer.from(update).toString("base64") }),
		);
	});
	expectedText.split("").forEach((character, index) => {
		text.insert(index, character);
	});
	return { frames, expectedText };
}

// Apply every document frame in a replay to a fresh doc and read the text
// back — this is what a late joiner effectively does.
function rebuildText(items: string[]): string {
	const doc = new Y.Doc();
	items.forEach((item) => {
		const frame = JSON.parse(item) as { t?: string; d?: string };
		if (frame.t === "u" && typeof frame.d === "string") {
			Y.applyUpdate(doc, new Uint8Array(Buffer.from(frame.d, "base64")));
		}
	});
	return doc.getText("content").toString();
}

function awarenessFrame(payload: string): string {
	return JSON.stringify({
		t: "a",
		d: Buffer.from(payload).toString("base64"),
	});
}

// Pin Date.now (the only clock the relay reads) to a controllable offset.
function installClock(): { advance(milliseconds: number): void } {
	const baseTime = 1_700_000_000_000;
	let offset = 0;
	vi.spyOn(Date, "now").mockImplementation(() => baseTime + offset);
	return {
		advance(milliseconds) {
			offset += milliseconds;
		},
	};
}
