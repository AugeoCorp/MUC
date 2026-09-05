import type { IncomingMessage } from "node:http";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { BODY_LIMIT_BYTES, BodyTooLargeError, readBody } from "./readBody.ts";

function request(): PassThrough & IncomingMessage {
	return new PassThrough() as unknown as PassThrough & IncomingMessage;
}

describe("readBody", () => {
	it("keeps a multibyte character whole across a chunk boundary", async () => {
		const stream = request();
		const pending = readBody(stream);
		const bytes = Buffer.from("café");
		stream.write(bytes.subarray(0, 4)); // the cut falls inside the é
		stream.write(bytes.subarray(4));
		stream.end();
		expect(await pending).toBe("café");
	});

	it("refuses a body past the limit without tearing the request down", async () => {
		const stream = request();
		const pending = readBody(stream);
		stream.write(Buffer.alloc(BODY_LIMIT_BYTES, "x"));
		stream.write(Buffer.from("!"));
		await expect(pending).rejects.toBeInstanceOf(BodyTooLargeError);
		expect(stream.destroyed).toBe(false);
	});
});
