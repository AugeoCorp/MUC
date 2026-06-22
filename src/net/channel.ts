// A generic frame channel over the relay (relay.ts), reached through a
// Cloudflare tunnel. It carries arbitrary JSON-serializable frames — the
// collaborative session (collab/session.ts) rides on it, posting Yjs document
// and awareness updates. Mechanics are identical to the chat transport that
// preceded it: POST a frame to /send, short-poll GET /messages?since=<cursor>
// for new ones. Polling rather than streaming is deliberate — Cloudflare's
// quick tunnel won't reliably forward a long-lived server→client stream.

export interface Channel {
	/** Broadcast a frame to every other participant. */
	post(frame: unknown): void;
	/** Register a listener for inbound frames; returns an unsubscribe. */
	subscribe(listener: (frame: unknown) => void): () => void;
	/** Stop polling and drop all listeners. */
	disconnect(): void;
}

// How often we ask the relay for anything new. Fast enough to feel live, slow
// enough to stay cheap.
const POLL_INTERVAL = 800;

interface MessagesResponse {
	cursor: number;
	items: string[];
}

export async function createTunnelChannel(url: string): Promise<Channel> {
	const base = url.replace(/\/$/, "");
	const sendUrl = `${base}/send`;
	const messagesUrl = (since: number) => `${base}/messages?since=${since}`;

	const listeners = new Set<(frame: unknown) => void>();
	let cursor = 0;

	// Validate the relay up front so a bad URL surfaces as a connection error
	// rather than silent dead air. Leave the cursor at 0 so the first real poll
	// delivers the whole backlog — for Yjs that backlog reconstructs the document.
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
				const frame = decodeFrame(item);
				if (frame !== undefined) {
					listeners.forEach((listener) => listener(frame));
				}
			});
		} catch {
			// Transient network hiccup — just try again on the next tick.
		}
	};

	const timer = setInterval(() => void poll(), POLL_INTERVAL);

	return {
		post(frame) {
			void fetch(sendUrl, {
				method: "POST",
				body: JSON.stringify(frame),
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

// A no-op channel for solo editing (`--loopback`): nothing is broadcast and
// nothing arrives, but the local document still works on its own.
export function createLocalChannel(): Channel {
	const listeners = new Set<(frame: unknown) => void>();
	return {
		post() {},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		disconnect() {
			listeners.clear();
		},
	};
}

function decodeFrame(item: string): unknown {
	try {
		return JSON.parse(item);
	} catch {
		return undefined;
	}
}
