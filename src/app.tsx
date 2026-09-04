import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import {
	type CollabSession,
	createCollabSession,
	type Role,
	type UserInfo,
} from "./collab/session.ts";
import type { Channel } from "./net/channel.ts";
import { Editor } from "./ui/Editor.tsx";
import { Title } from "./ui/Title.tsx";

type ConnectionStatus = "connecting" | "ready" | "error";

interface AppProps {
	user: UserInfo;
	connect: () => Promise<Channel>;
	/**
	 * Whoever is at the box: a `participant` drafts and lets the server send,
	 * `solo` does both. A server never renders an App at all.
	 */
	role: Extract<Role, "participant" | "solo">;
	/** The session code, shown in the footer so anyone here can invite others. */
	shareCode?: string;
}

export function App({ user, connect, role, shareCode }: AppProps) {
	const [status, setStatus] = useState<ConnectionStatus>("connecting");
	const [session, setSession] = useState<CollabSession>();

	useEffect(() => {
		let active = true;
		let channel: Channel | undefined;
		let live: CollabSession | undefined;

		connect()
			.then((ready) => {
				if (!active) {
					ready.disconnect();
					return;
				}
				channel = ready;
				live = createCollabSession(ready, user, { role });
				setSession(live);
				setStatus("ready");
			})
			.catch(() => {
				if (active) setStatus("error");
			});

		return () => {
			active = false;
			live?.destroy();
			void channel?.disconnect();
		};
	}, [connect, user, role]);

	return (
		// paddingX only — vertical padding is two rows the box could be using.
		<Box flexDirection="column" paddingX={1}>
			<Title />
			{status === "connecting" && <Text color="yellow">Connecting…</Text>}
			{status === "error" && <Text color="red">Could not connect.</Text>}
			{status === "ready" && session !== undefined && (
				// The code rides down to the Editor's footer, next to the ready count.
				<Editor session={session} shareCode={shareCode} />
			)}
		</Box>
	);
}
