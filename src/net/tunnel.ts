// Spawns the `cloudflared` binary to open a free Quick Tunnel, giving the host
// a public https://*.trycloudflare.com URL that proxies to their local relay.
// We drive the binary directly rather than pulling an npm wrapper — the
// wrappers download the same binary via a postinstall script, which is exactly
// the supply-chain surface we want to avoid.

import { spawn } from "node:child_process";

// cloudflared logs the assigned URL (to stderr) once the tunnel is live.
const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

export interface Tunnel {
	publicUrl: string;
	close(): void;
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
					publicUrl: match[0],
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
