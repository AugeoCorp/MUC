import type { Server } from "node:http";

export interface Listening {
	/** The port actually bound — what the caller needs when it asked for 0. */
	port: number;
	/** Stop accepting connections; resolves once the server has closed. */
	close(): Promise<void>;
}

/**
 * Bind a server and report the port it landed on. A listen failure (the port
 * is taken, or privileged) becomes a rejection the caller can present, rather
 * than the uncaught exception Node raises when nothing listens for `error`.
 */
export function listen(
	server: Server,
	port: number,
	host?: string,
): Promise<Listening> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(port, host, () => {
			server.off("error", reject);
			const address = server.address();
			resolve({
				port:
					typeof address === "object" && address !== null ? address.port : 0,
				close() {
					return new Promise((done) => server.close(() => done()));
				},
			});
		});
	});
}
