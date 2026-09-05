import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { listen } from "../utilities/listen.ts";
import { readBody } from "../utilities/readBody.ts";
import { createTunnelChannel } from "./channel.ts";

// A stand-in relay that refuses the first POST and records every one it sees.
async function createFlakyRelay(refuseFirst: number): Promise<{
	url: string;
	received: string[];
	close(): Promise<void>;
}> {
	const received: string[] = [];
	let posts = 0;
	const server: Server = createServer((request, response) => {
		if (request.method === "POST") {
			void readBody(request).then((body) => {
				posts += 1;
				if (posts <= refuseFirst) {
					response.writeHead(500).end();
					return;
				}
				received.push(body);
				response.writeHead(204).end();
			});
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ cursor: 0, items: [] }));
	});
	const { port, close } = await listen(server, 0, "127.0.0.1");
	return { url: `http://127.0.0.1:${port}`, received, close };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length > 0) await cleanups.pop()?.();
});

describe("tunnel channel", () => {
	it("retries a refused frame before sending the next, keeping order", async () => {
		const relay = await createFlakyRelay(1);
		cleanups.push(relay.close);
		const channel = await createTunnelChannel(relay.url);
		const first = channel.post({ t: "u", d: "first" });
		const second = channel.post({ t: "a", d: "second" });
		await first;
		expect(relay.received).toEqual([JSON.stringify({ t: "u", d: "first" })]);
		await second;
		await channel.disconnect();
		expect(relay.received).toEqual([
			JSON.stringify({ t: "u", d: "first" }),
			JSON.stringify({ t: "a", d: "second" }),
		]);
	});

	it("stops retrying once disconnected, after one last attempt each", async () => {
		const relay = await createFlakyRelay(1);
		cleanups.push(relay.close);
		const channel = await createTunnelChannel(relay.url);
		void channel.post({ t: "u", d: "refused once" });
		void channel.post({ t: "a", d: "departure" });
		const started = Date.now();
		await channel.disconnect();
		// The first frame's retry was cancelled; the second still got its try.
		expect(Date.now() - started).toBeLessThan(2_000);
		expect(relay.received).toEqual([
			JSON.stringify({ t: "a", d: "departure" }),
		]);
	});
});
