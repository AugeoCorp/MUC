import { afterEach, describe, expect, it } from "vitest";
import {
	type CollabSession,
	createCollabSession,
	LOCAL_ORIGIN,
	type UserInfo,
} from "../collab/session.ts";
import { createChannelPair } from "../net/channel.ts";
import {
	appendLine,
	applySplices,
	deleteRange,
	insertAtCursor,
	moveCursor,
	replaceText,
	typeText,
} from "./operations.ts";

const agentUser: UserInfo = { name: "scribe", color: "green", kind: "agent" };
const humanUser: UserInfo = { name: "kirby", color: "cyan", kind: "human" };

const sessions: CollabSession[] = [];
afterEach(() => {
	while (sessions.length > 0) sessions.pop()?.destroy();
});

/** An agent session wired to a human peer over a loopback channel. */
function createAgentWithPeer(): [CollabSession, CollabSession] {
	const [channelA, channelB] = createChannelPair();
	const agentSession = createCollabSession(channelA, agentUser, {
		role: "participant",
	});
	const humanSession = createCollabSession(channelB, humanUser, {
		role: "participant",
	});
	sessions.push(agentSession, humanSession);
	return [agentSession, humanSession];
}

function setText(session: CollabSession, value: string): void {
	session.doc.transact(() => {
		session.text.delete(0, session.text.length);
		session.text.insert(0, value);
	}, LOCAL_ORIGIN);
}

describe("appendLine", () => {
	it("lands as its own line, atomically", () => {
		const [agentSession] = createAgentWithPeer();
		setText(agentSession, "hello");
		appendLine(agentSession, "scribe: hi");
		expect(agentSession.text.toString()).toBe("hello\nscribe: hi\n");
	});

	it("does not double a trailing newline", () => {
		const [agentSession] = createAgentWithPeer();
		setText(agentSession, "hello\n");
		appendLine(agentSession, "scribe: hi");
		expect(agentSession.text.toString()).toBe("hello\nscribe: hi\n");
	});

	it("starts an empty document cleanly", () => {
		const [agentSession] = createAgentWithPeer();
		appendLine(agentSession, "first");
		expect(agentSession.text.toString()).toBe("first\n");
	});

	it("clears the ready flag", () => {
		const [agentSession] = createAgentWithPeer();
		agentSession.setReady(true);
		appendLine(agentSession, "words");
		expect(agentSession.isReady()).toBe(false);
	});
});

describe("replaceText", () => {
	it("replaces the first occurrence and reports its index", () => {
		const [agentSession] = createAgentWithPeer();
		setText(agentSession, "the teh quick teh fox");
		expect(replaceText(agentSession, { find: "teh", insert: "the" })).toEqual({
			index: 4,
		});
		expect(agentSession.text.toString()).toBe("the the quick teh fox");
	});

	it("honors an anchor so later occurrences are reachable", () => {
		const [agentSession] = createAgentWithPeer();
		setText(agentSession, "teh one, teh two");
		const result = replaceText(agentSession, {
			find: "teh",
			insert: "the",
			after: "one,",
		});
		expect(result).toEqual({ index: 9 });
		expect(agentSession.text.toString()).toBe("teh one, the two");
	});

	it("names which string missed and changes nothing", () => {
		const [agentSession] = createAgentWithPeer();
		setText(agentSession, "all good here");
		expect(replaceText(agentSession, { find: "absent", insert: "x" })).toEqual({
			miss: "find",
		});
		expect(
			replaceText(agentSession, {
				find: "good",
				insert: "x",
				after: "absent anchor",
			}),
		).toEqual({ miss: "after" });
		expect(agentSession.text.toString()).toBe("all good here");
	});

	it("leaves the local cursor anchored through the splice", () => {
		const [agentSession] = createAgentWithPeer();
		setText(agentSession, "abc TARGET xyz");
		moveCursor(agentSession, agentSession.text.length); // cursor after "xyz"
		replaceText(agentSession, { find: "TARGET", insert: "LONGER-TEXT" });
		expect(agentSession.getLocalIndex()).toBe(agentSession.text.length);
	});
});

describe("applySplices", () => {
	it("applies a batch against pre-batch indices in one transaction", () => {
		const [agentSession] = createAgentWithPeer();
		setText(agentSession, "one two three");
		applySplices(agentSession, [
			{ at: 0, remove: 3, insert: "ONE" },
			{ at: 8, remove: 5, insert: "THREE" },
		]);
		expect(agentSession.text.toString()).toBe("ONE two THREE");
	});
});

describe("cursor operations", () => {
	it("insertAtCursor advances the cursor past the insert", () => {
		const [agentSession] = createAgentWithPeer();
		setText(agentSession, "ab");
		moveCursor(agentSession, 1);
		insertAtCursor(agentSession, "X");
		expect(agentSession.text.toString()).toBe("aXb");
		expect(agentSession.getLocalIndex()).toBe(2);
	});

	it("deleteRange clamps and parks the cursor at the cut", () => {
		const [agentSession] = createAgentWithPeer();
		setText(agentSession, "abcdef");
		deleteRange(agentSession, 2, 100);
		expect(agentSession.text.toString()).toBe("ab");
		expect(agentSession.getLocalIndex()).toBe(2);
	});
});

describe("typeText", () => {
	it("falls back to the default pace when cps is not finite", async () => {
		const [agentSession] = createAgentWithPeer();
		const started = Date.now();
		await typeText(agentSession, "hi!", Number.NaN);
		const elapsed = Date.now() - started;
		expect(agentSession.text.toString()).toBe("hi!");
		// Three characters at the default 14 cps is ~214ms; a NaN delay would
		// finish in single-digit milliseconds.
		expect(elapsed).toBeGreaterThan(100);
	});
});

describe("sync", () => {
	it("edits reach the human peer", () => {
		const [agentSession, humanSession] = createAgentWithPeer();
		appendLine(agentSession, "scribe: present");
		expect(humanSession.text.toString()).toBe("scribe: present\n");
	});
});
