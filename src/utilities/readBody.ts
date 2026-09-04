import type { IncomingMessage } from "node:http";

/** The most a request body may carry. A frame is a few hundred bytes; a whole compacted document is far under this. */
export const BODY_LIMIT_BYTES = 1_048_576;

/** Thrown by `readBody` when a request runs past `BODY_LIMIT_BYTES`; answer it with 413. */
export class BodyTooLargeError extends Error {
	constructor() {
		super(`request body exceeds ${BODY_LIMIT_BYTES} bytes`);
		this.name = "BodyTooLargeError";
	}
}

/**
 * Collect an HTTP request body into a string. Rejects when the request stream
 * errors (e.g. the client aborts mid-body) or grows past `BODY_LIMIT_BYTES` —
 * the relay is public, so an unbounded read is a memory hole anyone can pour
 * into. Callers must handle the rejection or it escapes as an unhandled one.
 */
export function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		let received = 0;
		request.on("data", (chunk: Buffer | string) => {
			received += chunk.length;
			if (received > BODY_LIMIT_BYTES) {
				request.destroy();
				reject(new BodyTooLargeError());
				return;
			}
			data += chunk;
		});
		request.on("end", () => resolve(data));
		request.on("error", reject);
	});
}
