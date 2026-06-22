#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { render } from "ink";
import { App } from "./app.tsx";
import { startRelay } from "./net/relay.ts";
import { createLoopbackTransport } from "./net/transport.stub.ts";
import type { Transport } from "./net/transport.ts";
import { createTunnelTransport } from "./net/transport.tunnel.ts";
import { startCloudflareTunnel } from "./net/tunnel.ts";

const handle = {
	type: "string",
	description: "Display name other peers see.",
	default: "anon",
} as const;

// `muc serve` — host the room: stand up a local relay, expose it through a
// public Cloudflare tunnel, then join your own relay so you can chat too.
const serve = defineCommand({
	meta: {
		name: "serve",
		description: "Host the room: start a relay and a public Cloudflare tunnel.",
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

		const connect = (): Promise<Transport> =>
			createTunnelTransport({ handle: args.handle, url: localUrl });

		const instance = render(
			<App
				handle={args.handle}
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
		description: "Peer-to-peer chat in your terminal.",
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
			description: "Skip the network; echo your own messages locally.",
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

		const connect = (): Promise<Transport> =>
			args.loopback
				? Promise.resolve(createLoopbackTransport({ handle: args.handle }))
				: createTunnelTransport({ handle: args.handle, url: args.url });

		const instance = render(<App handle={args.handle} connect={connect} />);
		return instance.waitUntilExit();
	},
});

runMain(main);
