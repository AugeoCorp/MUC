import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { ChatMessage, Transport } from "./net/transport.ts";
import { Composer } from "./ui/Composer.tsx";
import { MessageList } from "./ui/MessageList.tsx";

type ConnectionStatus = "connecting" | "ready" | "error";

interface AppProps {
	handle: string;
	connect: () => Promise<Transport>;
	/** Set when hosting — the public relay URL to share with others. */
	shareUrl?: string;
}

export function App({ handle, connect, shareUrl }: AppProps) {
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [status, setStatus] = useState<ConnectionStatus>("connecting");
	const [transport, setTransport] = useState<Transport>();

	useEffect(() => {
		let active = true;
		let connected: Transport | undefined;

		connect()
			.then((ready) => {
				if (!active) {
					ready.disconnect();
					return;
				}
				connected = ready;
				setTransport(ready);
				setStatus("ready");
			})
			.catch(() => {
				if (active) setStatus("error");
			});

		return () => {
			active = false;
			connected?.disconnect();
		};
	}, [connect]);

	useEffect(() => {
		if (transport === undefined) return;
		return transport.subscribe((message) => {
			setMessages((current) => [...current, message]);
		});
	}, [transport]);

	return (
		<Box flexDirection="column" padding={1}>
			<Text bold color="magentaBright">
				muc · {handle}
			</Text>
			{shareUrl !== undefined && (
				<Text color="greenBright">Invite others — share: {shareUrl}</Text>
			)}
			<StatusLine status={status} />
			<Box marginY={1}>
				<MessageList messages={messages} />
			</Box>
			<Composer
				onSubmit={(body) => {
					transport?.send(body);
				}}
			/>
		</Box>
	);
}

function StatusLine({ status }: { status: ConnectionStatus }) {
	if (status === "connecting") {
		return <Text color="yellow">Joining the network — finding peers…</Text>;
	}
	if (status === "error") {
		return <Text color="red">Could not start the transport.</Text>;
	}
	return <Text dimColor>Connected. Searching for roommates — say hello.</Text>;
}
