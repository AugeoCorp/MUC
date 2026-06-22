import { createCollabSession, LOCAL_ORIGIN } from "./src/collab/session.ts";
import { createTunnelChannel } from "./src/net/channel.ts";
import { startRelay } from "./src/net/relay.ts";

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const relay = await startRelay();
const url = `http://localhost:${relay.port}`;

const aliceChannel = await createTunnelChannel(url);
const alice = createCollabSession(aliceChannel, { name: "alice", color: "cyan" });
const bobChannel = await createTunnelChannel(url);
const bob = createCollabSession(bobChannel, { name: "bob", color: "magenta" });

// Alice inserts at the front and announces her cursor.
alice.doc.transact(() => alice.text.insert(0, "hello "), LOCAL_ORIGIN);
alice.publishCursor(alice.text.length);
await wait(1200);

// Bob (now holding "hello ") appends concurrently.
bob.doc.transact(() => bob.text.insert(bob.text.length, "world"), LOCAL_ORIGIN);
bob.publishCursor(bob.text.length);
await wait(1500);

console.log("alice text:", JSON.stringify(alice.text.toString()));
console.log("bob text  :", JSON.stringify(bob.text.toString()));
console.log(
	"converged :",
	alice.text.toString() === bob.text.toString() ? "YES" : "NO",
);
console.log(
	"alice sees remote:",
	alice.getRemoteCursors().map((c) => `${c.user.name}@${c.index}`),
);
console.log(
	"bob sees remote  :",
	bob.getRemoteCursors().map((c) => `${c.user.name}@${c.index}`),
);

alice.destroy();
bob.destroy();
aliceChannel.disconnect();
bobChannel.disconnect();
await relay.close();
process.exit(0);
