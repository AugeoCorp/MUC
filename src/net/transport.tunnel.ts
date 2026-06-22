// The Transport that talks to a relay (relay.ts), reached over a Cloudflare
// tunnel. Sends by POSTing one message at a time; receives by short-polling
// GET /messages?since=<cursor> on a timer. Polling rather than streaming is
// deliberate — Cloudflare's quick tunnel won't reliably forward a long-lived
// server→client stream, but plain request/response sails through. The first
// poll starts at cursor 0, so a late joiner pulls the backlog as history.

import type { ChatMessage, Transport, TransportOptions } from "./transport.ts";

export interface TunnelTransportOptions extends TransportOptions {
	/** Relay URL to join — the trycloudflare.com address the host shared. */
	url: string;
}

// How often we ask the relay for anything new. Fast enough to feel live, slow
// enough to stay cheap.
const POLL_INTERVAL = 800;

interface MessagesResponse {
	cursor: number;
	items: string[];
}

export async function createTunnelTransport(
	options: TunnelTransportOptions,
): Promise<Transport> {
	const { handle, url } = options;
	const base = url.replace(/\/$/, "");
	const sendUrl = `${base}/send`;
	const messagesUrl = (since: number) => `${base}/messages?since=${since}`;

	const listeners = new Set<(message: ChatMessage) => void>();
	let cursor = 0;

	// Validate the relay up front so a bad URL surfaces as a connection error
	// rather than silent dead air. Leave the cursor at 0 so the first real poll
	// delivers any backlog to subscribers (who attach just after we return).
	const probe = await fetch(messagesUrl(0), {
		headers: { accept: "application/json" },
	});
	if (!probe.ok) {
		throw new Error(`Relay refused the connection (${probe.status}).`);
	}
	await probe.json().catch(() => undefined);

	const poll = async (): Promise<void> => {
		try {
			const response = await fetch(messagesUrl(cursor), {
				headers: { accept: "application/json" },
			});
			if (!response.ok) return;
			const data = (await response.json()) as MessagesResponse;
			cursor = data.cursor;
			data.items.forEach((item) => {
				const message = decodeMessage(item);
				if (message !== undefined) {
					listeners.forEach((listener) => listener(message));
				}
			});
		} catch {
			// Transient network hiccup — just try again on the next tick.
		}
	};

	const timer = setInterval(() => void poll(), POLL_INTERVAL);

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
			clearInterval(timer);
			listeners.clear();
		},
	};
}

function decodeMessage(item: string): ChatMessage | undefined {
	try {
		return JSON.parse(item) as ChatMessage;
	} catch {
		return undefined;
	}
}
