// A dumb fan-out hub. The host runs one of these locally; a Cloudflare tunnel
// exposes it publicly (see tunnel.ts). Clients hold open a streaming GET on
// /events to receive messages (Server-Sent Events) and POST to /send to
// broadcast (a JSON body). SSE matters here: Cloudflare buffers ordinary
// streaming responses — holding tiny chat lines back indefinitely — but won't
// buffer text/event-stream, so messages reach tunnelled clients live. Everyone
// connected shares one common space.

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";

// Cloudflare drops idle tunnel connections after ~100s, so we nudge each open
// stream with a blank line well inside that window. Clients skip empty lines.
const HEARTBEAT_INTERVAL = 20_000;

export interface Relay {
	port: number;
	close(): Promise<void>;
}

export function startRelay(): Promise<Relay> {
	// Every open response stream currently listening for messages.
	const subscribers = new Set<ServerResponse>();

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");

		if (request.method === "GET" && url.pathname === "/events") {
			openStream(subscribers, request, response);
			return;
		}
		if (request.method === "POST" && url.pathname === "/send") {
			void broadcast(subscribers, request, response);
			return;
		}
		response.writeHead(404).end();
	});

	const heartbeat = setInterval(() => {
		subscribers.forEach((subscriber) => subscriber.write(":\n\n"));
	}, HEARTBEAT_INTERVAL);

	return new Promise((resolve) => {
		server.listen(0, () => {
			const address = server.address();
			const port =
				typeof address === "object" && address !== null ? address.port : 0;
			resolve({
				port,
				close() {
					clearInterval(heartbeat);
					subscribers.forEach((subscriber) => subscriber.end());
					return new Promise((done) => server.close(() => done()));
				},
			});
		});
	});
}

function openStream(
	subscribers: Set<ServerResponse>,
	request: IncomingMessage,
	response: ServerResponse,
): void {
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-cache",
		connection: "keep-alive",
	});
	// Flush headers immediately so the client's fetch resolves before any message
	// arrives. A leading SSE comment (": …") is ignored by the client.
	response.write(":\n\n");

	subscribers.add(response);
	request.on("close", () => {
		subscribers.delete(response);
	});
}

async function broadcast(
	subscribers: Set<ServerResponse>,
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const body = await readBody(request);
	// One SSE event per message: a single `data:` line carrying the JSON, ended
	// by a blank line. JSON.stringify never emits raw newlines, so it stays one
	// line.
	const frame = `data: ${body}\n\n`;
	subscribers.forEach((subscriber) => subscriber.write(frame));
	response.writeHead(204).end();
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		request.on("data", (chunk) => {
			data += chunk;
		});
		request.on("end", () => resolve(data));
		request.on("error", reject);
	});
}
