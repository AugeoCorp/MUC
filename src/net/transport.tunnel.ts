// The Transport that talks to a relay (relay.ts), reached over a Cloudflare
// tunnel. Receives by holding open a streaming GET of Server-Sent Events and
// reading the `data:` lines; sends by POSTing one message at a time. Node 24
// has no global EventSource, so we parse the SSE stream ourselves — which keeps
// this dependency-free.

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
		headers: { accept: "text/event-stream" },
	});
	if (!response.ok || response.body === null) {
		throw new Error(`Relay refused the connection (${response.status}).`);
	}

	void readEvents(response.body, (payload) => {
		const message = decodeMessage(payload);
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

// Pull chunks off the SSE stream, split into lines, and hand the JSON payload of
// each `data:` line to the listener. Blank lines (event boundaries) and `:`
// comment lines (relay heartbeats) are skipped.
async function readEvents(
	stream: ReadableStream<Uint8Array>,
	onData: (payload: string) => void,
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
			if (line.startsWith("data:")) onData(line.slice(5).trim());
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
