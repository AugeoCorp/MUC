#!/usr/bin/env node
import { defineCommand, runMain } from "citty";
import { render } from "ink";
import { App } from "./app.tsx";

const main = defineCommand({
	meta: {
		name: "muc",
		description: "Peer-to-peer chat in your terminal.",
	},
	args: {
		handle: {
			type: "string",
			description: "Display name other peers see.",
			default: "anon",
		},
	},
	run({ args }) {
		const instance = render(<App handle={args.handle} />);
		return instance.waitUntilExit();
	},
});

runMain(main);
