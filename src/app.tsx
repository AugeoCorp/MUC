import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import {
	type CollabSession,
	createCollabSession,
	type UserInfo,
} from "./collab/session.ts";
import type { Channel } from "./net/channel.ts";
import { Editor } from "./ui/Editor.tsx";
import { Title } from "./ui/Title.tsx";

type ConnectionStatus = "connecting" | "ready" | "error";

interface AppProps {
	user: UserInfo;
	connect: () => Promise<Channel>;
	/** Set when hosting — the public relay URL to share with others. */
	shareUrl?: string;
}

export function App({ user, connect, shareUrl }: AppProps) {
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
				live = createCollabSession(ready, user);
				setSession(live);
				setStatus("ready");
			})
			.catch(() => {
				if (active) setStatus("error");
			});

		return () => {
			active = false;
			live?.destroy();
			channel?.disconnect();
		};
	}, [connect, user]);

	return (
		<Box flexDirection="column" padding={1}>
			<Title />
			{shareUrl !== undefined && (
				<Text color="greenBright">Invite others — share: {shareUrl}</Text>
			)}
			{status === "connecting" && <Text color="yellow">Connecting…</Text>}
			{status === "error" && <Text color="red">Could not connect.</Text>}
			{status === "ready" && session !== undefined && (
				<Editor session={session} />
			)}
		</Box>
	);
}
