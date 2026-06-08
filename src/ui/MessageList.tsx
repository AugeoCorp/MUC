import { Box, Text } from "ink";
import type { ChatMessage } from "../net/transport.ts";

interface MessageListProps {
	messages: ChatMessage[];
}

export function MessageList({ messages }: MessageListProps) {
	if (messages.length === 0) {
		return <Text dimColor>No messages yet.</Text>;
	}

	return (
		<Box flexDirection="column" flexGrow={1}>
			{messages.map((message) => (
				<Text key={message.id}>
					<Text color="cyan">{message.handle}</Text>
					<Text dimColor> › </Text>
					{message.body}
				</Text>
			))}
		</Box>
	);
}
