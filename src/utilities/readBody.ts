import type { IncomingMessage } from "node:http";

/**
 * Collect an HTTP request body into a string. Rejects when the request stream
 * errors (e.g. the client aborts mid-body) — callers must handle that path or
 * the rejection escapes as an unhandled one.
 */
export function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		request.on("data", (chunk) => {
			data += chunk;
		});
		request.on("end", () => resolve(data));
		request.on("error", reject);
	});
}
