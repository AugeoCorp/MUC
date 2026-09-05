// The base64 frame codec shared by both ends of the wire: sessions encode
// binary Yjs payloads into frames before posting, and the relay decodes them
// again during compaction. One definition so the two sides can't drift.

export function toBase64(bytes: Uint8Array): string {
	return Buffer.from(bytes).toString("base64");
}

export function fromBase64(text: string): Uint8Array {
	return new Uint8Array(Buffer.from(text, "base64"));
}
