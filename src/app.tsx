import { Box, Text } from "ink";
import { useEffect, useMemo, useState } from "react";
import { createLoopbackTransport } from "./net/transport.stub.ts";
import type { ChatMessage } from "./net/transport.ts";
import { Composer } from "./ui/Composer.tsx";
import { MessageList } from "./ui/MessageList.tsx";

interface AppProps {
	handle: string;
}

export function App({ handle }: AppProps) {
	const transport = useMemo(
		() => createLoopbackTransport({ handle }),
		[handle],
	);
	const [messages, setMessages] = useState<ChatMessage[]>([]);

	useEffect(() => {
		const unsubscribe = transport.subscribe((message) => {
			setMessages((current) => [...current, message]);
		});

		return () => {
			unsubscribe();
			transport.disconnect();
		};
	}, [transport]);

	return (
		<Box flexDirection="column" padding={1}>
			<Text bold color="magentaBright">
				muc · {handle}
			</Text>
			<Text dimColor>
				Loopback transport — no peers yet. Type a message and press enter.
			</Text>
			<Box marginY={1}>
				<MessageList messages={messages} />
			</Box>
			<Composer onSubmit={(body) => transport.send(body)} />
		</Box>
	);
}
