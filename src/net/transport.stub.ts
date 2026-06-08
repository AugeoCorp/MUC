import type { ChatMessage, Transport, TransportOptions } from "./transport.ts";

// Placeholder transport: echoes everything you send straight back to your own
// subscribers, as if a single peer were mirroring you. It needs no network and
// exists only to exercise the UI until a real peer-to-peer transport lands.
export function createLoopbackTransport({
	handle,
}: TransportOptions): Transport {
	const listeners = new Set<(message: ChatMessage) => void>();

	return {
		send(body) {
			const message: ChatMessage = {
				id: crypto.randomUUID(),
				handle,
				body,
				sentAt: Date.now(),
			};
			listeners.forEach((listener) => listener(message));
		},
		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},
		disconnect() {
			listeners.clear();
		},
	};
}
