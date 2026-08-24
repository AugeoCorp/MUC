#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { render } from "ink";
import { startAgentDaemon } from "./agent/index.ts";
import { App } from "./app.tsx";
import { createCollabSession, type UserInfo } from "./collab/session.ts";
import {
	type Channel,
	createLocalChannel,
	createTunnelChannel,
} from "./net/channel.ts";
import { startRelay } from "./net/relay.ts";
import {
	isSessionCode,
	relayUrlFor,
	startCloudflareTunnel,
} from "./net/tunnel.ts";
import { type LaunchChoice, Launcher } from "./ui/Launcher.tsx";
import { ServerStatus } from "./ui/ServerStatus.tsx";

// Deliberately no `default` — leaving it undefined is how we tell "the user
// didn't say" from "the user said anon", and the first case is what we prompt
// for. DEFAULT_HANDLE stands in wherever we can't ask.
const handleArg = {
	type: "string",
	description: "Display name other people see; asked for if omitted.",
} as const;

const descriptorArg = {
	type: "string",
	description:
		"Free-form note on who you are and why you're here, shown beside your handle.",
} as const;

const DEFAULT_HANDLE = "anon";

// Never published — a server holds a UserInfo the way it holds a doc, but its
// presence is deliberately kept off the wire (see collab/session.ts).
const SERVER_USER: UserInfo = { name: "muc", color: "gray" };

// `muc serve` — run the session, don't join it: a local relay, a public
// Cloudflare tunnel, and a headless document that does the sending. It takes no
// handle, because nobody here is drafting.
const serve = defineCommand({
	meta: {
		name: "serve",
		description: "Run a session others join: a relay behind a public tunnel.",
	},
	run: () => serveSession(),
});

// `muc connect <code>` — join someone else's session with the code they shared.
const connect = defineCommand({
	meta: {
		name: "connect",
		description: "Join a session using the code the host shared.",
	},
	args: {
		code: {
			type: "positional",
			description: "Session code from `muc serve` (e.g. wide-blue-cat-42).",
		},
		handle: handleArg,
		descriptor: descriptorArg,
	},
	async run({ args }) {
		const code = args.code ?? "";
		if (!isSessionCode(code)) {
			console.error(
				`"${code}" doesn't look like a session code. Expected a single word like wide-blue-cat-42 — if the host sent you a link, the code is the part before the first dot.`,
			);
			process.exitCode = 1;
			return;
		}

		const handle = await resolveHandle(args.handle, code);
		if (handle === undefined) return; // quit at the handle prompt
		return joinSession(code, handle, args.descriptor);
	},
});

// `muc solo` — skip the network entirely and poke at the box on your own.
const solo = defineCommand({
	meta: {
		name: "solo",
		description: "Skip the network; edit the box on your own.",
	},
	args: { handle: handleArg },
	run({ args }) {
		const openChannel = (): Promise<Channel> =>
			Promise.resolve(createLocalChannel());

		// Solo has no server to do the sending, so the lone user does both — and no
		// one to read the handle either, so this mode never stops to ask for it.
		const instance = render(
			<App
				user={userFrom(args.handle ?? DEFAULT_HANDLE)}
				connect={openChannel}
				role="solo"
			/>,
		);
		return instance.waitUntilExit();
	},
});

// `muc agent <code>` — join headless, as an AI agent's hands: no TUI, just a
// localhost control API (POST /cmd, GET /state, GET /events) the agent drives.
// An agent is an ordinary participant on the wire, but its kind marks it so it
// never gates the ready quorum — and it never hosts.
const agent = defineCommand({
	meta: {
		name: "agent",
		description:
			"Join headless as an agent: exposes a localhost control API instead of a TUI.",
	},
	args: {
		code: {
			type: "positional",
			description: "Session code from `muc serve` (e.g. wide-blue-cat-42).",
		},
		handle: handleArg,
		descriptor: descriptorArg,
		port: {
			type: "string",
			description: "Control API port; 0 picks a free one.",
			default: "0",
		},
	},
	async run({ args }) {
		const code = args.code ?? "";
		if (!isSessionCode(code)) {
			console.error(
				`"${code}" doesn't look like a session code. Expected a single word like wide-blue-cat-42.`,
			);
			process.exitCode = 1;
			return;
		}

		// Headless means no prompt to fall back on — take the default silently.
		const handle = args.handle ?? DEFAULT_HANDLE;

		let channel: Channel;
		try {
			channel = await createTunnelChannel(relayUrlFor(code));
		} catch (error) {
			console.error(
				`Couldn't reach session "${code}": ${error instanceof Error ? error.message : String(error)}`,
			);
			process.exitCode = 1;
			return;
		}
		const session = createCollabSession(
			channel,
			userFrom(handle, args.descriptor, "agent"),
			{ role: "participant" },
		);

		let shutdown = (): void => {};
		const closed = new Promise<void>((resolve) => {
			shutdown = resolve;
		});
		const daemon = await startAgentDaemon(session, {
			port: Number.parseInt(args.port, 10),
			onQuit: () => shutdown(),
		});
		process.on("SIGINT", () => shutdown());
		process.on("SIGTERM", () => shutdown());

		// One machine-readable line so the driving agent can find the API.
		console.log(JSON.stringify({ listening: daemon.port, handle, code }));

		await closed;
		await daemon.close();
		// destroy() drops our presence with a final frame; give it a beat to
		// flush before the poll loop stops.
		session.destroy();
		await new Promise((resolve) => setTimeout(resolve, 300));
		channel.disconnect();
	},
});

// `muc start` — the bare `muc` path: ask which mode, and for whatever that mode
// needs, then run it. Reached as the default subcommand, so it never has to be
// typed.
const start = defineCommand({
	meta: {
		name: "start",
		description: "Pick host or join interactively (what bare `muc` runs).",
	},
	args: { handle: handleArg },
	async run({ args }) {
		// Asking requires a keyboard. Piped or redirected (CI, `muc < /dev/null`)
		// there's no mode to fall back on, so say which command they meant.
		if (!isInteractive()) {
			console.error(
				"muc needs an interactive terminal to ask what you'd like to do. Run `muc serve` to host, `muc connect <code>` to join, or `muc solo` to edit on your own.",
			);
			process.exitCode = 1;
			return;
		}

		const choice = await runLauncher(args.handle ?? DEFAULT_HANDLE);
		if (choice === undefined) return; // quit at the prompt
		return choice.mode === "serve"
			? serveSession()
			: joinSession(choice.code, choice.handle);
	},
});

// The root command is pure dispatch — citty runs a parent's `run` *after* the
// subcommand it dispatched to, so a root with both would fire twice. `default`
// is how a bare `muc` gets a behaviour without that double-fire.
const main = defineCommand({
	meta: {
		name: "muc",
		description: "A shared, collaboratively-edited text box in your terminal.",
	},
	subCommands: { serve, connect, solo, agent, start },
	default: "start",
});

runMain(main);

// ---------------------------------------------------------------------------
// The session modes, shared by the subcommands and the interactive prompt.
// ---------------------------------------------------------------------------

/**
 * Run a session without joining it. The relay carries the frames, the tunnel
 * makes it reachable, and a headless document rides the same channel everyone
 * else does — holding the draft and doing the sending, but publishing no
 * presence, so nobody sees a cursor for it.
 */
async function serveSession(): Promise<void> {
	const relay = await startRelay();
	const localUrl = `http://localhost:${relay.port}`;

	let tunnel: Awaited<ReturnType<typeof startCloudflareTunnel>>;
	try {
		tunnel = await startCloudflareTunnel(relay.port);
	} catch (error) {
		await relay.close();
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return;
	}

	let channel: Channel;
	try {
		channel = await createTunnelChannel(localUrl);
	} catch (error) {
		tunnel.close();
		await relay.close();
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
		return;
	}

	const session = createCollabSession(channel, SERVER_USER, { role: "server" });
	const instance = render(
		<ServerStatus session={session} shareCode={tunnel.code} />,
	);

	// Nothing here reads the keyboard, so raw mode is off and ⌃c arrives as a
	// signal rather than a keystroke. Catch it so the tunnel and relay get shut
	// down properly instead of being orphaned.
	const stop = (): void => instance.unmount();
	process.once("SIGINT", stop);
	await instance.waitUntilExit();
	process.off("SIGINT", stop);

	session.destroy();
	channel.disconnect();
	tunnel.close();
	await relay.close();
}

async function joinSession(
	code: string,
	handle: string,
	descriptor?: string,
): Promise<void> {
	const openChannel = (): Promise<Channel> =>
		createTunnelChannel(relayUrlFor(code));

	// Everyone at the box drafts; the server does the sending. The code comes
	// along so the footer can show it — anyone here can invite anyone else.
	const instance = render(
		<App
			user={userFrom(handle, descriptor)}
			connect={openChannel}
			role="participant"
			shareCode={code}
		/>,
	);
	await instance.waitUntilExit();
}

/**
 * The handle to run as: whatever `--handle` carried, else asked for. Undefined
 * means the user quit the prompt rather than answering.
 */
async function resolveHandle(
	explicit: string | undefined,
	code: string,
): Promise<string | undefined> {
	if (explicit !== undefined) return explicit;
	// Nothing to ask with, but the session is already settled — just get going.
	if (!isInteractive()) return DEFAULT_HANDLE;

	const choice = await runLauncher(DEFAULT_HANDLE, code);
	return choice?.mode === "connect" ? choice.handle : undefined;
}

/** Run the prompt; resolves undefined if the user quit instead of choosing. */
async function runLauncher(
	defaultHandle: string,
	joining?: string,
): Promise<LaunchChoice | undefined> {
	let choice: LaunchChoice | undefined;
	const instance = render(
		<Launcher
			defaultHandle={defaultHandle}
			joining={joining}
			onLaunch={(made) => {
				choice = made;
			}}
		/>,
	);
	await instance.waitUntilExit();
	return choice;
}

// ink needs raw mode to read keys, which only a real terminal provides.
function isInteractive(): boolean {
	return process.stdin.isTTY === true;
}

// A small set of distinct cursor colors, chosen deterministically from the
// handle so the same name keeps the same color across a session.
const PALETTE = ["cyan", "magenta", "green", "yellow", "blue", "redBright"];
function userFrom(
	name: string,
	descriptor?: string,
	kind?: UserInfo["kind"],
): UserInfo {
	let sum = 0;
	for (const character of name) sum += character.charCodeAt(0);
	return { name, color: PALETTE[sum % PALETTE.length], descriptor, kind };
}
