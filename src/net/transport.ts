// The seam between the UI and however peers actually talk to each other.
// Today the only implementation is an in-memory loopback (transport.stub.ts);
// a real peer-to-peer transport drops in behind this same interface later.

export interface ChatMessage {
	id: string;
	handle: string;
	body: string;
	sentAt: number;
}

export interface TransportOptions {
	handle: string;
}

export interface Transport {
	/** Broadcast a message body to every connected peer. */
	send(body: string): void;
	/** Register a listener for inbound messages; returns an unsubscribe. */
	subscribe(listener: (message: ChatMessage) => void): () => void;
	/** Tear down connections and drop all listeners. */
	disconnect(): void;
}
