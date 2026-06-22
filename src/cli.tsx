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
import { startCloudflareTunnel } from "./net/tunnel.ts";

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

		const connect = (): Promise<Channel> => createTunnelChannel(localUrl);
		const instance = render(
			<App
				user={userFrom(args.handle)}
				connect={connect}
				shareUrl={tunnel.publicUrl}
			/>,
		);
		await instance.waitUntilExit();

		tunnel.close();
		await relay.close();
	},
});

const main = defineCommand({
	meta: {
		name: "muc",
		description: "A shared, collaboratively-edited text box in your terminal.",
	},
	args: {
		handle,
		url: {
			type: "string",
			description: "Relay URL shared by the host (from `muc serve`).",
			default: "",
		},
		loopback: {
			type: "boolean",
			description: "Skip the network; edit the box solo.",
			default: false,
		},
	},
	subCommands: { serve },
	run({ args }) {
		if (!args.loopback && args.url === "") {
			console.error(
				"Pass --url <relay-url> to join, or run `muc serve` to host.",
			);
			process.exitCode = 1;
			return;
		}

		const connect = (): Promise<Channel> =>
			args.loopback
				? Promise.resolve(createLocalChannel())
				: createTunnelChannel(args.url);

		const instance = render(
			<App user={userFrom(args.handle)} connect={connect} />,
		);
		return instance.waitUntilExit();
	},
});

runMain(main);
