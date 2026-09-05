import type { IncomingMessage } from "node:http";

/** The most a request body may carry. A frame is a few hundred bytes; a whole compacted document is far under this. */
export const BODY_LIMIT_BYTES = 1_048_576;

/** Thrown by `readBody` when a request runs past `BODY_LIMIT_BYTES`; answer it with 413, then destroy the request. */
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
 * into. An oversized request is left open, paused, so the caller can still
 * answer it (a destroyed socket carries no status); destroy it once the
 * response is out. Callers must handle the rejection or it escapes as an
 * unhandled one.
 */
export function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let data = "";
		let received = 0;
		let refused = false;
		// Decoding here, statefully, rather than chunk by chunk: a multibyte
		// character that straddles two chunks must come out whole.
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			if (refused) return;
			received += Buffer.byteLength(chunk);
			if (received > BODY_LIMIT_BYTES) {
				refused = true;
				request.pause();
				reject(new BodyTooLargeError());
				return;
			}
			data += chunk;
		});
		request.on("end", () => resolve(data));
		request.on("error", reject);
	});
}
