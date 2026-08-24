import { afterEach, describe, expect, it } from "vitest";
import {
	type CollabSession,
	createCollabSession,
	type UserInfo,
} from "../collab/session.ts";
import { createChannelPair } from "../net/channel.ts";
import { type AgentDaemon, startAgentDaemon } from "./daemon.ts";

const agentUser: UserInfo = { name: "scribe", color: "green", kind: "agent" };
const humanUser: UserInfo = { name: "kirby", color: "cyan", kind: "human" };

interface Fixture {
	daemon: AgentDaemon;
	agentSession: CollabSession;
	humanSession: CollabSession;
	base: string;
}

const fixtures: Fixture[] = [];
afterEach(async () => {
	while (fixtures.length > 0) {
		const fixture = fixtures.pop();
		if (fixture === undefined) continue;
		await fixture.daemon.close();
		fixture.agentSession.destroy();
		fixture.humanSession.destroy();
	}
});

async function createFixture(): Promise<Fixture> {
	const [channelA, channelB] = createChannelPair();
	const agentSession = createCollabSession(channelA, agentUser, {
		role: "participant",
	});
	const humanSession = createCollabSession(channelB, humanUser, {
		role: "participant",
	});
	const daemon = await startAgentDaemon(agentSession);
	const fixture = {
		daemon,
		agentSession,
		humanSession,
		base: `http://127.0.0.1:${daemon.port}`,
	};
	fixtures.push(fixture);
	return fixture;
}

async function command(
	fixture: Fixture,
	body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const response = await fetch(`${fixture.base}/cmd`, {
		method: "POST",
		body: JSON.stringify(body),
	});
	return (await response.json()) as Record<string, unknown>;
}

describe("agent daemon", () => {
	it("serves a state snapshot including the human peer", async () => {
		const fixture = await createFixture();
		const response = await fetch(`${fixture.base}/state`);
		const state = (await response.json()) as {
			participants: Array<{ name: string; kind: string }>;
			myReady: boolean;
		};
		expect(state.myReady).toBe(false);
		expect(state.participants).toEqual([
			expect.objectContaining({ name: "kirby", kind: "human" }),
		]);
	});

	it("appendLine lands in both sessions", async () => {
		const fixture = await createFixture();
		const result = await command(fixture, {
			op: "appendLine",
			line: "scribe: hello",
		});
		expect(result.ok).toBe(true);
		expect(fixture.humanSession.text.toString()).toBe("scribe: hello\n");
	});

	it("replace misses harmlessly and reports the failure", async () => {
		const fixture = await createFixture();
		const result = await command(fixture, {
			op: "replace",
			find: "absent",
			insert: "x",
		});
		expect(result).toEqual({ ok: false, error: "find: no match" });
	});

	it("rejects unknown ops", async () => {
		const fixture = await createFixture();
		const result = await command(fixture, { op: "selfDestruct" });
		expect(result.ok).toBe(false);
	});

	it("streams remote edits through /events with a cursor", async () => {
		const fixture = await createFixture();
		fixture.humanSession.doc.transact(() =>
			fixture.humanSession.text.insert(0, "hi from kirby"),
		);
		// Text events coalesce for 300ms; long-poll until the event arrives.
		const response = await fetch(`${fixture.base}/events?since=0&wait=2000`);
		const feed = (await response.json()) as {
			seq: number;
			events: Array<{ type: string; text?: string }>;
		};
		const textEvent = feed.events.find((event) => event.type === "text");
		expect(textEvent?.text).toBe("hi from kirby");
		// The cursor resumes cleanly: nothing new after the reported seq.
		const idle = await fetch(`${fixture.base}/events?since=${feed.seq}`);
		const idleFeed = (await idle.json()) as { events: unknown[] };
		expect(idleFeed.events).toEqual([]);
	});

	it("attributes a remote edit to the human who made it", async () => {
		const fixture = await createFixture();
		fixture.humanSession.doc.transact(() =>
			fixture.humanSession.text.insert(0, "hi from kirby"),
		);
		// Text events coalesce for 300ms; long-poll until the event arrives.
		const response = await fetch(`${fixture.base}/events?since=0&wait=2000`);
		const feed = (await response.json()) as {
			events: Array<{ type: string; edits?: unknown[] }>;
		};
		const textEvent = feed.events.find((event) => event.type === "text");
		expect(textEvent?.edits).toEqual([
			expect.objectContaining({
				origin: "remote",
				by: { name: "kirby", kind: "human" },
			}),
		]);
	});

	it("attributes a local edit to the daemon's own user", async () => {
		const fixture = await createFixture();
		await command(fixture, { op: "appendLine", line: "scribe: present" });
		const response = await fetch(`${fixture.base}/events?since=0&wait=2000`);
		const feed = (await response.json()) as {
			events: Array<{ type: string; edits?: unknown[] }>;
		};
		const textEvent = feed.events.find((event) => event.type === "text");
		expect(textEvent?.edits).toEqual([
			expect.objectContaining({
				origin: "local",
				by: { name: "scribe", kind: "agent" },
			}),
		]);
	});

	it("emits a roster event when the peer readies up", async () => {
		const fixture = await createFixture();
		fixture.humanSession.setReady(true);
		const response = await fetch(`${fixture.base}/events?since=0&wait=2000`);
		const feed = (await response.json()) as {
			events: Array<{
				type: string;
				participants?: Array<{ name: string; ready: boolean }>;
			}>;
		};
		const roster = feed.events
			.filter((event) => event.type === "roster")
			.at(-1);
		expect(roster?.participants).toEqual([
			expect.objectContaining({ name: "kirby", ready: true }),
		]);
	});

	it("acknowledges quit and invokes the shutdown hook", async () => {
		const [channelA, channelB] = createChannelPair();
		const agentSession = createCollabSession(channelA, agentUser, {
			role: "participant",
		});
		const humanSession = createCollabSession(channelB, humanUser, {
			role: "participant",
		});
		let quitCalled = false;
		const daemon = await startAgentDaemon(agentSession, {
			onQuit: () => {
				quitCalled = true;
			},
		});
		fixtures.push({
			daemon,
			agentSession,
			humanSession,
			base: `http://127.0.0.1:${daemon.port}`,
		});
		const response = await fetch(`http://127.0.0.1:${daemon.port}/cmd`, {
			method: "POST",
			body: JSON.stringify({ op: "quit" }),
		});
		expect(((await response.json()) as { bye?: boolean }).bye).toBe(true);
		await new Promise((resolve) => setTimeout(resolve, 100));
		expect(quitCalled).toBe(true);
	});
});
