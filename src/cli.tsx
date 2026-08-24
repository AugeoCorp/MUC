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

const handle = {
	type: "string",
	description: "Display name other people see.",
	default: "anon",
} as const;

// A small set of distinct cursor colors, chosen deterministically from the
// handle so the same name keeps the same color across a session.
const PALETTE = ["cyan", "magenta", "green", "yellow", "blue", "redBright"];
function userFrom(name: string): UserInfo {
	let sum = 0;
	for (const character of name) sum += character.charCodeAt(0);
	return { name, color: PALETTE[sum % PALETTE.length] };
}

// `muc serve` — host the shared box: stand up a local relay, expose it through a
// public Cloudflare tunnel, then join your own relay so you can edit too.
const serve = defineCommand({
	meta: {
		name: "serve",
		description:
			"Host the shared box: start a relay and a public Cloudflare tunnel.",
	},
	args: { handle },
	async run({ args }) {
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
				user={userFrom(args.handle)}
				connect={openChannel}
				isHost
				shareCode={tunnel.code}
			/>,
		);
		await instance.waitUntilExit();

		tunnel.close();
		await relay.close();
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
		handle,
	},
	run({ args }) {
		const code = args.code ?? "";
		if (!isSessionCode(code)) {
			console.error(
				`"${code}" doesn't look like a session code. Expected a single word like wide-blue-cat-42 — if the host sent you a link, the code is the part before the first dot.`,
			);
			process.exitCode = 1;
			return;
		}

		const openChannel = (): Promise<Channel> =>
			createTunnelChannel(relayUrlFor(code));

		// Whoever joins is a guest, never the submitter — the host sends.
		const instance = render(
			<App user={userFrom(args.handle)} connect={openChannel} isHost={false} />,
		);
		return instance.waitUntilExit();
	},
});

// `muc solo` — skip the network entirely and poke at the box on your own.
const solo = defineCommand({
	meta: {
		name: "solo",
		description: "Skip the network; edit the box on your own.",
	},
	args: { handle },
	run({ args }) {
		const openChannel = (): Promise<Channel> =>
			Promise.resolve(createLocalChannel());

		// Solo has no relay, so that lone user hosts their own session.
		const instance = render(
			<App user={userFrom(args.handle)} connect={openChannel} isHost />,
		);
		return instance.waitUntilExit();
	},
});

// The root command is pure dispatch — citty runs a parent's `run` *after* the
// subcommand it dispatched to, so a root with both would fire twice.
const main = defineCommand({
	meta: {
		name: "muc",
		description: "A shared, collaboratively-edited text box in your terminal.",
	},
	subCommands: { serve, connect, solo },
});

runMain(main);
