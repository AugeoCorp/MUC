import { afterEach, describe, expect, it } from "vitest";
import { type Channel, createChannelPair } from "../net/channel.ts";
import {
	type CollabSession,
	createCollabSession,
	isHuman,
	LOCAL_ORIGIN,
	type Role,
	type UserInfo,
} from "./session.ts";

const human = (name: string): UserInfo => ({
	name,
	color: "cyan",
	kind: "human",
});
const agent = (name: string): UserInfo => ({
	name,
	color: "magenta",
	kind: "agent",
});
// Never published, so its kind is moot — but the type wants one.
const serverUser: UserInfo = { name: "muc", color: "gray", kind: "human" };

const sessions: CollabSession[] = [];
function track(session: CollabSession): CollabSession {
	sessions.push(session);
	return session;
}
afterEach(() => {
	while (sessions.length > 0) sessions.pop()?.destroy();
});

/**
 * Two sessions wired back-to-back. The first is created first, so — like a
 * real late joiner — it only becomes visible to the second when it next
 * publishes; the second is visible to the first straight away.
 */
function createPair(
	userA: UserInfo,
	userB: UserInfo,
	roles: [Role, Role] = ["participant", "participant"],
): [CollabSession, CollabSession] {
	const [channelA, channelB] = createChannelPair();
	const sessionA = track(
		createCollabSession(channelA, userA, { role: roles[0] }),
	);
	const sessionB = track(
		createCollabSession(channelB, userB, { role: roles[1] }),
	);
	return [sessionA, sessionB];
}

/**
 * A tiny in-process hub: every post fans out to every other endpoint,
 * synchronously, and a late subscriber replays the backlog first — the same
 * contract as the real relay, which a session depends on now that the server
 * writes color assignments before everyone has joined.
 */
function createHub(endpointCount: number): Channel[] {
	const log: Array<{ from: number; frame: unknown }> = [];
	const listenerSets = Array.from(
		{ length: endpointCount },
		() => new Set<(frame: unknown) => void>(),
	);
	return listenerSets.map((own, index) => ({
		post(frame) {
			log.push({ from: index, frame });
			listenerSets.forEach((other, otherIndex) => {
				if (otherIndex === index) return;
				other.forEach((listener) => listener(frame));
			});
			return Promise.resolve();
		},
		subscribe(listener) {
			log.forEach((entry) => {
				if (entry.from !== index) listener(entry.frame);
			});
			own.add(listener);
			return () => own.delete(listener);
		},
		disconnect() {
			own.clear();
			return Promise.resolve();
		},
	}));
}

function setText(session: CollabSession, value: string): void {
	session.doc.transact(() => session.text.insert(0, value), LOCAL_ORIGIN);
}

describe("isHuman", () => {
	it("treats an absent kind as human, so old clients still gate the send", () => {
		expect(isHuman({})).toBe(true);
		expect(isHuman(human("kirby"))).toBe(true);
		expect(isHuman(agent("scribe"))).toBe(false);
	});
});

describe("document sync", () => {
	it("relays edits both ways over the channel", () => {
		const [sessionA, sessionB] = createPair(human("a"), human("b"));
		sessionA.doc.transact(() => sessionA.text.insert(0, "hi "), LOCAL_ORIGIN);
		sessionB.doc.transact(
			() => sessionB.text.insert(sessionB.text.length, "there"),
			LOCAL_ORIGIN,
		);
		expect(sessionA.text.toString()).toBe("hi there");
		expect(sessionB.text.toString()).toBe("hi there");
	});
});

describe("presence at creation", () => {
	it("announces a fresh participant without waiting for a cursor publish", () => {
		const [channelA, channelB] = createChannelPair();
		const observer = track(
			createCollabSession(channelA, human("watcher"), {
				role: "participant",
			}),
		);
		track(
			createCollabSession(channelB, human("joiner"), {
				role: "participant",
			}),
		);
		expect(
			observer.getRemoteCursors().map((cursor) => cursor.user.name),
		).toEqual(["joiner"]);
	});

	it("keeps a server invisible: it publishes no presence at all", () => {
		const [channelA, channelB] = createChannelPair();
		const participant = track(
			createCollabSession(channelA, human("kirby"), { role: "participant" }),
		);
		track(
			createCollabSession(channelB, serverUser, {
				role: "server",
			}),
		);
		expect(participant.getRemoteCursors()).toEqual([]);
	});
});

describe("ready quorum", () => {
	it("requires every human, local included", () => {
		const [sessionA, sessionB] = createPair(human("a"), human("b"));
		expect(sessionA.isEveryoneReady()).toBe(false);
		sessionA.setReady(true);
		expect(sessionA.isEveryoneReady()).toBe(false);
		sessionB.setReady(true);
		expect(sessionA.isEveryoneReady()).toBe(true);
		expect(sessionB.isEveryoneReady()).toBe(true);
	});

	it("ignores agents: a drafting agent cannot block the send", () => {
		const [humanSession, agentSession] = createPair(
			human("kirby"),
			agent("scribe"),
		);
		humanSession.setReady(true);
		expect(agentSession.isReady()).toBe(false);
		expect(humanSession.isEveryoneReady()).toBe(true);
	});

	it("is ready on an agent's session once every human is, without the agent", () => {
		const [humanChannel, agentChannel] = createHub(2);
		const humanSession = track(
			createCollabSession(humanChannel, human("kirby")),
		);
		const agentSession = track(
			createCollabSession(agentChannel, agent("scribe")),
		);
		expect(agentSession.isEveryoneReady()).toBe(false);
		humanSession.setReady(true);
		expect(agentSession.isEveryoneReady()).toBe(true);
	});

	it("is never ready with no humans present", () => {
		const [agentA, agentB] = createPair(agent("scribe"), agent("sprite"));
		agentA.setReady(true);
		agentB.setReady(true);
		expect(agentA.isEveryoneReady()).toBe(false);
		expect(agentB.isEveryoneReady()).toBe(false);
	});
});

describe("server submit", () => {
	it("appends the draft and clears the composer when all humans are ready", () => {
		const [serverSession, participantSession] = createPair(
			serverUser,
			human("kirby"),
			["server", "participant"],
		);
		setText(participantSession, "  ship it  ");
		participantSession.setReady(true);
		expect(serverSession.messages.toArray()).toEqual(["ship it"]);
		expect(serverSession.text.toString()).toBe("");
		expect(participantSession.messages.toArray()).toEqual(["ship it"]);
		expect(participantSession.text.toString()).toBe("");
	});

	it("clears the participant's ready flag after a send", () => {
		const [, participantSession] = createPair(serverUser, human("kirby"), [
			"server",
			"participant",
		]);
		setText(participantSession, "draft");
		participantSession.setReady(true);
		expect(participantSession.isReady()).toBe(false);
	});

	it("sends on the human's say-so alone when an agent is still drafting", () => {
		const [serverChannel, humanChannel, agentChannel] = createHub(3);
		const serverSession = track(
			createCollabSession(serverChannel, serverUser, {
				role: "server",
			}),
		);
		const humanSession = track(
			createCollabSession(humanChannel, human("kirby"), {
				role: "participant",
			}),
		);
		const agentSession = track(
			createCollabSession(agentChannel, agent("scribe"), {
				role: "participant",
			}),
		);
		setText(humanSession, "go");
		humanSession.setReady(true);
		expect(agentSession.isReady()).toBe(false);
		expect(serverSession.messages.toArray()).toEqual(["go"]);
		expect(humanSession.messages.toArray()).toEqual(["go"]);
		expect(agentSession.messages.toArray()).toEqual(["go"]);
	});

	it("never sends a keystroke the room did not sign off on", () => {
		// An edit and the flag it withdraws are one update, so the server can't
		// see the new text beside the old approval — however the frames travel.
		const [serverChannel, aliceChannel, bobChannel] = createHub(3);
		const serverSession = track(
			createCollabSession(serverChannel, serverUser, { role: "server" }),
		);
		const alice = track(createCollabSession(aliceChannel, human("alice")));
		const bob = track(createCollabSession(bobChannel, human("bob")));
		alice.setReady(true);
		bob.setReady(true);
		alice.edit(() => alice.text.insert(0, "h"));
		expect(serverSession.messages.toArray()).toEqual([]);
		expect(alice.isReady()).toBe(false);
		expect(bob.isReady()).toBe(true);
		expect(serverSession.text.toString()).toBe("h");
	});

	it("sends when an agent supplies the draft to a room already ready", () => {
		const [serverChannel, humanChannel, agentChannel] = createHub(3);
		const serverSession = track(
			createCollabSession(serverChannel, serverUser, { role: "server" }),
		);
		const humanSession = track(
			createCollabSession(humanChannel, human("kirby")),
		);
		const agentSession = track(
			createCollabSession(agentChannel, agent("scribe")),
		);
		// Ready before there's anything to send — an agent then supplies the
		// draft. Its edit touches no one's flag, so the room is still ready and
		// the draft goes out on the text change.
		humanSession.setReady(true);
		expect(serverSession.messages.toArray()).toEqual([]);
		agentSession.edit(() => agentSession.text.insert(0, "go"));
		expect(serverSession.messages.toArray()).toEqual(["go"]);
		expect(humanSession.messages.toArray()).toEqual(["go"]);
	});

	it("leaves a human's flag alone when an agent edits", () => {
		const [humanChannel, agentChannel] = createHub(2);
		const humanSession = track(
			createCollabSession(humanChannel, human("kirby")),
		);
		const agentSession = track(
			createCollabSession(agentChannel, agent("scribe")),
		);
		setText(humanSession, "draft");
		humanSession.setReady(true);
		agentSession.edit(() => agentSession.text.insert(0, "note: "));
		expect(humanSession.isReady()).toBe(true);
		expect(agentSession.getRemoteCursors()[0]?.ready).toBe(true);
	});

	it("drops a departed participant's flag so it can't hold the room ready", () => {
		const [serverChannel, aliceChannel, bobChannel] = createHub(3);
		const serverSession = track(
			createCollabSession(serverChannel, serverUser, { role: "server" }),
		);
		const alice = track(createCollabSession(aliceChannel, human("alice")));
		const bob = createCollabSession(bobChannel, human("bob"));
		setText(alice, "draft");
		bob.setReady(true);
		bob.destroy();
		expect(serverSession.readyFlags.size).toBe(0);
		expect(serverSession.messages.toArray()).toEqual([]);
		alice.setReady(true);
		expect(serverSession.messages.toArray()).toEqual(["draft"]);
	});
});

describe("ready tally", () => {
	it("counts humans present and ready, local included", () => {
		const [sessionA, sessionB] = createPair(human("a"), human("b"));
		expect(sessionA.readyTally()).toEqual({ ready: 0, total: 2 });
		sessionB.setReady(true);
		expect(sessionA.readyTally()).toEqual({ ready: 1, total: 2 });
	});

	it("leaves agents and the server out of both numbers", () => {
		const [serverChannel, humanChannel, agentChannel] = createHub(3);
		const serverSession = track(
			createCollabSession(serverChannel, serverUser, { role: "server" }),
		);
		track(createCollabSession(humanChannel, human("kirby")));
		const agentSession = track(
			createCollabSession(agentChannel, agent("scribe")),
		);
		expect(serverSession.readyTally()).toEqual({ ready: 0, total: 1 });
		expect(agentSession.readyTally()).toEqual({ ready: 0, total: 1 });
	});
});
