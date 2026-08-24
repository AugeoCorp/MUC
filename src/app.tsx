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
	/** True for the participant hosting the session — the sole message submitter. */
	isHost: boolean;
	/** Set when hosting — the session code to share with others. */
	shareCode?: string;
}

export function App({ user, connect, isHost, shareCode }: AppProps) {
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
				live = createCollabSession(ready, user, { isHost });
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
	}, [connect, user, isHost]);

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
