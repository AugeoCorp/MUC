// The Transport that talks to a relay (relay.ts), reached over a Cloudflare
// tunnel. Receives by holding open a streaming GET and parsing newline-
// delimited JSON off the body; sends by POSTing one message at a time. Node 24
// has no global EventSource, so we read the stream ourselves — which keeps this
// dependency-free and the wire format trivial.

import type { ChatMessage, Transport, TransportOptions } from "./transport.ts";

export interface TunnelTransportOptions extends TransportOptions {
	/** Relay URL to join — the trycloudflare.com address the host shared. */
	url: string;
}

export async function createTunnelTransport(
	options: TunnelTransportOptions,
): Promise<Transport> {
	const { handle, url } = options;
	const base = url.replace(/\/$/, "");
	const eventsUrl = `${base}/events`;
	const sendUrl = `${base}/send`;

	const listeners = new Set<(message: ChatMessage) => void>();
	const controller = new AbortController();

	const response = await fetch(eventsUrl, {
		signal: controller.signal,
		headers: { accept: "application/x-ndjson" },
	});
	if (!response.ok || response.body === null) {
		throw new Error(`Relay refused the connection (${response.status}).`);
	}

	void readLines(response.body, (line) => {
		const message = decodeMessage(line);
		if (message !== undefined) {
			listeners.forEach((listener) => listener(message));
		}
	});

	return {
		send(body) {
			const message: ChatMessage = {
				id: crypto.randomUUID(),
				handle,
				body,
				sentAt: Date.now(),
			};
			void fetch(sendUrl, {
				method: "POST",
				body: JSON.stringify(message),
			}).catch(() => undefined);
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		disconnect() {
			controller.abort();
			listeners.clear();
		},
	};
}

// Pull chunks off the stream, split on newlines, and hand each non-empty line
// to the listener. Blank lines are relay heartbeats and are skipped.
async function readLines(
	stream: ReadableStream<Uint8Array>,
	onLine: (line: string) => void,
): Promise<void> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";

	const pump = async (): Promise<void> => {
		const { done, value } = await reader.read();
		if (done) return;
		buffer += decoder.decode(value, { stream: true });
		const lines = buffer.split("\n");
		buffer = lines.pop() ?? "";
		lines.forEach((line) => {
			if (line.trim() !== "") onLine(line);
		});
		return pump();
	};

	await pump().catch(() => undefined);
}

function decodeMessage(line: string): ChatMessage | undefined {
	try {
		return JSON.parse(line) as ChatMessage;
	} catch {
		return undefined;
	}
}
