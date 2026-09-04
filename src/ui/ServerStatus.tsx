// What `muc serve` shows: the session code, who's in the room, and what's been
// sent. There's no text box here — the server holds the document and does the
// sending, but never drafts, so there's nothing to type into.
//
// Like the Editor, this renders straight from Yjs and keeps no text of its own;
// a version counter bumps on every awareness or message change to re-render.

import { Box, Text, useApp, useStdin } from "ink";
import { type ReactElement, useEffect, useState } from "react";
import type { CollabSession } from "../collab/session.ts";
import { Participant } from "./Participant.tsx";
import { CTRL_C, useConfirmQuit } from "./useConfirmQuit.ts";

interface ServerStatusProps {
	session: CollabSession;
	/** The code others join with — the whole point of the screen. */
	shareCode: string;
}

export function ServerStatus({
	session,
	shareCode,
}: ServerStatusProps): ReactElement {
	const { exit } = useApp();
	const { stdin, setRawMode, isRawModeSupported } = useStdin();
	const [, setVersion] = useState(0);
	const { armed, press } = useConfirmQuit();

	// Taking the session down disconnects everyone, so ⌃c asks twice here too.
	//
	// It's read as a keystroke rather than caught as a SIGINT: Ink registers
	// signal-exit at startup, which force-exits whenever it believes it's the
	// only SIGINT listener — a judgement based on a listener count we'd be
	// racing. Raw mode sidesteps the whole question, since ⌃c then never becomes
	// a signal at all. Where raw mode isn't available (piped, no TTY) there's no
	// keyboard to ask twice with, and SIGINT keeps its usual meaning.
	useEffect(() => {
		if (!isRawModeSupported || stdin === undefined) return;
		setRawMode(true);
		const onData = (chunk: Buffer | string): void => {
			const data = typeof chunk === "string" ? chunk : chunk.toString("utf8");
			if (!data.includes(CTRL_C)) return;
			if (press()) exit();
		};
		stdin.on("data", onData);
		return () => {
			stdin.off("data", onData);
			setRawMode(false);
		};
	}, [stdin, setRawMode, isRawModeSupported, exit, press]);

	useEffect(() => {
		const bump = () => setVersion((version) => version + 1);
		session.awareness.on("change", bump);
		session.messages.observe(bump);
		session.readyFlags.observe(bump);
		session.colors.observe(bump);
		return () => {
			session.awareness.off("change", bump);
			session.messages.unobserve(bump);
			session.readyFlags.unobserve(bump);
			session.colors.unobserve(bump);
		};
	}, [session]);

	const drafters = session.getRemoteCursors();
	// Only humans gate the send — agents appear in the room but not the tally.
	const { ready: readyCount, total: humanCount } = session.readyTally();
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
					{readyCount}/{humanCount} ready
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
			{armed ? (
				<Text color="yellow" bold>
					⌃c again to stop serving — everyone here is disconnected
				</Text>
			) : (
				<Text color="gray">⌃c to stop serving</Text>
			)}
		</Box>
	);
}
