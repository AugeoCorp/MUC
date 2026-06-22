// A dumb message log with two endpoints. The host runs one of these locally; a
// Cloudflare tunnel exposes it publicly (see tunnel.ts). Clients POST to /send
// to append a message and GET /messages?since=N to pull everything newer than
// their cursor. We deliberately avoid a long-lived server→client stream:
// Cloudflare's quick tunnel won't reliably forward one, so clients short-poll
// over plain request/response instead. Everyone connected shares one common
// space, and the full log doubles as history for whoever joins late.

import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from "node:http";

export interface Relay {
	port: number;
	close(): Promise<void>;
}

export function startRelay(): Promise<Relay> {
	// Every message ever sent this session, in order. An index into this array is
	// a client's cursor; `since=N` returns everything from position N onward.
	const log: string[] = [];

	const server = createServer((request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");

		if (request.method === "GET" && url.pathname === "/messages") {
			const since = Number(url.searchParams.get("since"));
			const start = Number.isInteger(since) && since > 0 ? since : 0;
			const body = JSON.stringify({
				cursor: log.length,
				items: log.slice(start),
			});
			response.writeHead(200, {
				"content-type": "application/json",
				"cache-control": "no-cache",
			});
			response.end(body);
			return;
		}
		if (request.method === "POST" && url.pathname === "/send") {
			void append(log, request, response);
			return;
		}
		response.writeHead(404).end();
	});

	return new Promise((resolve) => {
		server.listen(0, () => {
			const address = server.address();
			const port =
				typeof address === "object" && address !== null ? address.port : 0;
			resolve({
				port,
				close() {
					return new Promise((done) => server.close(() => done()));
				},
			});
		});
	});
}

async function append(
	log: string[],
	request: IncomingMessage,
	response: ServerResponse,
): Promise<void> {
	const body = await readBody(request);
	if (body.trim() !== "") log.push(body);
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
