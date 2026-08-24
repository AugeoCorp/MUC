#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { render } from "ink";
import { App } from "./app.tsx";
import type { UserInfo } from "./collab/session.ts";
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
import {
	type LaunchChoice,
	Launcher,
	type SessionPlan,
} from "./ui/Launcher.tsx";

// Deliberately no `default` — leaving it undefined is how we tell "the user
// didn't say" from "the user said anon", and the first case is what we prompt
// for. DEFAULT_HANDLE stands in wherever we can't ask.
const handleArg = {
	type: "string",
	description: "Display name other people see; asked for if omitted.",
} as const;

const DEFAULT_HANDLE = "anon";

// `muc serve` — host the shared box: stand up a local relay, expose it through a
// public Cloudflare tunnel, then join your own relay so you can edit too.
const serve = defineCommand({
	meta: {
		name: "serve",
		description:
			"Host the shared box: start a relay and a public Cloudflare tunnel.",
	},
	args: { handle: handleArg },
	async run({ args }) {
		const handle = await resolveHandle(args.handle, { mode: "serve" });
		if (handle === undefined) return; // quit at the handle prompt
		return hostSession(handle);
	},
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

		const handle = await resolveHandle(args.handle, { mode: "connect", code });
		if (handle === undefined) return; // quit at the handle prompt
		return joinSession(code, handle);
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

		// Solo has no relay, so that lone user hosts their own session — and no
		// one to read the handle either, so this mode never stops to ask for it.
		const instance = render(
			<App
				user={userFrom(args.handle ?? DEFAULT_HANDLE)}
				connect={openChannel}
				isHost
			/>,
		);
		return instance.waitUntilExit();
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
			? hostSession(choice.handle)
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
	subCommands: { serve, connect, solo, start },
	default: "start",
});

runMain(main);

// ---------------------------------------------------------------------------
// The session modes, shared by the subcommands and the interactive prompt.
// ---------------------------------------------------------------------------

async function hostSession(handle: string): Promise<void> {
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

	const openChannel = (): Promise<Channel> => createTunnelChannel(localUrl);
	const instance = render(
		<App
			user={userFrom(handle)}
			connect={openChannel}
			isHost
			shareCode={tunnel.code}
		/>,
	);
	await instance.waitUntilExit();

	tunnel.close();
	await relay.close();
}

async function joinSession(code: string, handle: string): Promise<void> {
	const openChannel = (): Promise<Channel> =>
		createTunnelChannel(relayUrlFor(code));

	// Whoever joins is a guest, never the submitter — the host sends.
	const instance = render(
		<App user={userFrom(handle)} connect={openChannel} isHost={false} />,
	);
	await instance.waitUntilExit();
}

/**
 * The handle to run as: whatever `--handle` carried, else asked for. Undefined
 * means the user quit the prompt rather than answering.
 */
async function resolveHandle(
	explicit: string | undefined,
	plan: SessionPlan,
): Promise<string | undefined> {
	if (explicit !== undefined) return explicit;
	// Nothing to ask with, but the mode is already settled — just get going.
	if (!isInteractive()) return DEFAULT_HANDLE;

	const choice = await runLauncher(DEFAULT_HANDLE, plan);
	return choice?.handle;
}

/** Run the prompt; resolves undefined if the user quit instead of choosing. */
async function runLauncher(
	defaultHandle: string,
	plan?: SessionPlan,
): Promise<LaunchChoice | undefined> {
	let choice: LaunchChoice | undefined;
	const instance = render(
		<Launcher
			defaultHandle={defaultHandle}
			plan={plan}
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
function userFrom(name: string): UserInfo {
	let sum = 0;
	for (const character of name) sum += character.charCodeAt(0);
	return { name, color: PALETTE[sum % PALETTE.length] };
}
