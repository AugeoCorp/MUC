// What `muc serve` shows: the session code, who's in the room, and what's been
// sent. There's no text box here — the server holds the document and does the
// sending, but never drafts, so there's nothing to type into.
//
// Like the Editor, this renders straight from Yjs and keeps no text of its own;
// a version counter bumps on every awareness or message change to re-render.

import { Box, Text } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import { type CollabSession, isHuman } from "../collab/session.ts";
import { Participant } from "./Participant.tsx";

interface ServerStatusProps {
	session: CollabSession;
	/** The code others join with — the whole point of the screen. */
	shareCode: string;
}

export function ServerStatus({
	session,
	shareCode,
}: ServerStatusProps): ReactElement {
	const [, setVersion] = useState(0);

	useEffect(() => {
		const bump = () => setVersion((version) => version + 1);
		session.awareness.on("change", bump);
		session.messages.observe(bump);
		session.colors.observe(bump);
		return () => {
			session.awareness.off("change", bump);
			session.messages.unobserve(bump);
			session.colors.unobserve(bump);
		};
	}, [session]);

	const drafters = session.getRemoteCursors();
	// Only humans gate the send — agents appear in the room but not the tally,
	// mirroring the Editor's legend and isEveryoneReady itself.
	const humans = drafters.filter((cursor) => isHuman(cursor.user));
	const readyCount = humans.filter((cursor) => cursor.ready).length;
	const everyoneReady = session.isEveryoneReady();
	const sentMessages = session.messages.toArray();

	return (
		<Box flexDirection="column" paddingX={1}>
			<Text>
				<Text bold color="magentaBright">
					muc · serving
				</Text>
				<Text color="gray"> · invite: </Text>
				<Text bold color="greenBright">
					muc connect {shareCode}
				</Text>
			</Text>
			<Box
				borderStyle="bold"
				borderLeft={false}
				borderRight={false}
				borderColor={everyoneReady ? "green" : "gray"}
				flexDirection="column"
			>
				{drafters.length === 0 ? (
					<Text color="gray">…waiting for someone to join</Text>
				) : (
					<Text wrap="truncate-end">
						{drafters.map((cursor, index) => (
							<Text key={cursor.clientId}>
								{index > 0 && <Text color="gray"> · </Text>}
								<Participant user={cursor.user} ready={cursor.ready} />
							</Text>
						))}
					</Text>
				)}
			</Box>
			<Text>
				<Text color={everyoneReady ? "green" : "yellow"}>
					{readyCount}/{humans.length} ready
				</Text>
				<Text color="gray">
					{everyoneReady ? " · sending…" : " · waiting on the room"}
				</Text>
			</Text>
			{sentMessages.length > 0 && (
				<Box flexDirection="column" marginTop={1}>
					<Text color="gray">┄ sent to the agent ┄</Text>
					{sentMessages.map((message, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: the log is append-only, so a row's index never changes
						<Text key={index} wrap="truncate">
							<Text color="cyan">▸ </Text>
							{message}
						</Text>
					))}
				</Box>
			)}
			<Text color="gray">⌃c to stop serving</Text>
		</Box>
	);
}
