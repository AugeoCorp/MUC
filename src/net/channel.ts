// A generic frame channel over the relay (relay.ts), reached through a
// Cloudflare tunnel. It carries arbitrary JSON-serializable frames — the
// collaborative session (collab/session.ts) rides on it, posting Yjs document
// and awareness updates. Mechanics are identical to the chat transport that
// preceded it: POST a frame to /send, short-poll GET /messages?since=<cursor>
// for new ones. Polling rather than streaming is deliberate — Cloudflare's
// quick tunnel won't reliably forward a long-lived server→client stream.

export interface Channel {
	/**
	 * Broadcast a frame to every other participant. Frames leave in the order
	 * they were posted; the promise settles once this one has been handed off.
	 */
	post(frame: unknown): Promise<void>;
	/** Register a listener for inbound frames; returns an unsubscribe. */
	subscribe(listener: (frame: unknown) => void): () => void;
	/** Stop polling and drop all listeners, once every posted frame is out. */
	disconnect(): Promise<void>;
}

// How often we ask the relay for anything new. Fast enough to feel live, slow
// enough to stay cheap.
const POLL_INTERVAL = 800;

// How long one POST attempt may take. Posts go out one at a time so their
// order holds, which means one that hangs would hold up every frame behind it.
const POST_TIMEOUT = 10_000;

// A failed POST is tried again after this long, doubling each time up to the
// cap, until it lands or the channel disconnects. A frame that never lands
// is worse than a late one: every peer holds this client's later updates as
// pending until the gap fills, so the room quietly forks.
const RETRY_DELAY = 500;
const RETRY_DELAY_CAP = 8_000;

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

	// One POST at a time. Two in flight at once can land at the relay in either
	// order, and an edit overtaking the flag it withdrew is exactly the kind of
	// reorder the session must never see.
	let outbound: Promise<void> = Promise.resolve();
	let disconnected = false;
	let cancelBackoff: (() => void) | undefined;

	// Every frame gets at least one attempt, even after disconnect — the
	// departure frame is posted on the way out and must still leave.
	async function deliver(body: string): Promise<void> {
		let attempt = 0;
		while (true) {
			try {
				const response = await fetch(sendUrl, {
					method: "POST",
					body,
					signal: AbortSignal.timeout(POST_TIMEOUT),
				});
				if (response.ok) return;
			} catch {
				// Timed out or unreachable — same treatment as a refusal below.
			}
			if (disconnected) return;
			const delay = Math.min(RETRY_DELAY * 2 ** attempt, RETRY_DELAY_CAP);
			attempt += 1;
			await new Promise<void>((resolve) => {
				const timeout = setTimeout(resolve, delay);
				cancelBackoff = () => {
					clearTimeout(timeout);
					resolve();
				};
			});
			if (disconnected) return;
		}
	}

	return {
		post(frame) {
			const body = JSON.stringify(frame);
			outbound = outbound.then(() => deliver(body));
			return outbound;
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		async disconnect() {
			clearInterval(timer);
			listeners.clear();
			// Whatever is queued gets one more try each; nothing waits out a
			// backoff on the way out.
			disconnected = true;
			cancelBackoff?.();
			await outbound;
		},
	};
}

// Two channels wired back-to-back: whatever one posts, the other's listeners
// receive, synchronously. Used to connect two in-process sessions — tests, and
// eventually multiple agent personas sharing one process.
export function createChannelPair(): [Channel, Channel] {
	const listenersA = new Set<(frame: unknown) => void>();
	const listenersB = new Set<(frame: unknown) => void>();
	const endpoint = (
		own: Set<(frame: unknown) => void>,
		other: Set<(frame: unknown) => void>,
	): Channel => ({
		post(frame) {
			other.forEach((listener) => listener(frame));
			return Promise.resolve();
		},
		subscribe(listener) {
			own.add(listener);
			return () => own.delete(listener);
		},
		disconnect() {
			own.clear();
			return Promise.resolve();
		},
	});
	return [endpoint(listenersA, listenersB), endpoint(listenersB, listenersA)];
}

// A no-op channel for solo editing (`muc solo`): nothing is broadcast and
// nothing arrives, but the local document still works on its own.
export function createLocalChannel(): Channel {
	const listeners = new Set<(frame: unknown) => void>();
	return {
		post() {
			return Promise.resolve();
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		disconnect() {
			listeners.clear();
			return Promise.resolve();
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
