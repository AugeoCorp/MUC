// Spawns the `cloudflared` binary to open a free Quick Tunnel, giving the host
// a public https://*.trycloudflare.com address that proxies to their local
// relay. We drive the binary directly rather than pulling an npm wrapper — the
// wrappers download the same binary via a postinstall script, which is exactly
// the supply-chain surface we want to avoid.
//
// Every Quick Tunnel lives at <code>.trycloudflare.com, so the subdomain alone
// identifies a session. That single word is all the host shares; whoever joins
// hands it to `relayUrlFor`, which expands it back into the full URL.

import { spawn } from "node:child_process";

// cloudflared logs the assigned URL (to stderr) once the tunnel is live.
const TUNNEL_URL_PATTERN = /https:\/\/([a-z0-9-]+)\.trycloudflare\.com/;

// The shape of a bare session code, i.e. a Quick Tunnel subdomain label.
const SESSION_CODE_PATTERN = /^[a-z0-9-]+$/;

export interface Tunnel {
	/** The subdomain label identifying this session — what the host shares. */
	code: string;
	close(): void;
}

/** Expand a session code into the relay URL a `Channel` can talk to. */
export function relayUrlFor(code: string): string {
	return `https://${code}.trycloudflare.com`;
}

/** True when `value` could be a session code — checked before we try to join. */
export function isSessionCode(value: string): boolean {
	return SESSION_CODE_PATTERN.test(value);
}

export function startCloudflareTunnel(port: number): Promise<Tunnel> {
	return new Promise((resolve, reject) => {
		const child = spawn("cloudflared", [
			"tunnel",
			"--url",
			`http://localhost:${port}`,
		]);
		let settled = false;

		const inspect = (chunk: Buffer) => {
			const match = chunk.toString().match(TUNNEL_URL_PATTERN);
			if (match !== null && !settled) {
				settled = true;
				resolve({
					code: match[1],
					close() {
						child.kill();
					},
				});
			}
		};

		child.stdout.on("data", inspect);
		child.stderr.on("data", inspect);

		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if ((error as NodeJS.ErrnoException).code === "ENOENT") {
				reject(
					new Error(
						"cloudflared not found. Install it first: brew install cloudflared",
					),
				);
				return;
			}
			reject(error);
		});
	});
}
