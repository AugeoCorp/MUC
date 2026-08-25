// One entry in the legend: who's here, what they are, and whether they've
// signed off on the draft. The Editor's footer and the server's screen both
// list participants, so the row is rendered from one place.
//
// The marker does double duty — its color is the participant's, and its shape
// says what kind of participant they are: a filled circle for people, a diamond
// for agents. Shape rather than an extra glyph because the row runs on one line
// and truncates at the terminal edge; a wider row would just clip sooner.

import { Text } from "ink";
import type { ReactElement } from "react";
import type { ParticipantKind, UserInfo } from "../collab/session.ts";

const SHAPES: Record<ParticipantKind, string> = {
	human: "●",
	agent: "◆",
};

interface ParticipantProps {
	user: UserInfo;
	/** Whether they've marked themselves ready to send. */
	ready: boolean;
	/** Replaces the descriptor — the local user says "you · 3 edits" instead. */
	note?: string;
}

export function Participant({
	user,
	ready,
	note,
}: ParticipantProps): ReactElement {
	const aside = note ?? user.descriptor;

	return (
		<Text>
			<Text color={user.color}>{SHAPES[user.kind ?? "human"]} </Text>
			<Text bold>{user.name} </Text>
			{aside !== undefined && <Text color="gray">({aside}) </Text>}
			{ready ? <Text color="green">✓</Text> : <Text color="gray">○</Text>}
		</Text>
	);
}
