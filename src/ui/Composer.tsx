import { Box, Text, useInput } from "ink";
import { useState } from "react";

interface ComposerProps {
	onSubmit: (body: string) => void;
}

export function Composer({ onSubmit }: ComposerProps) {
	const [draft, setDraft] = useState("");

	useInput((input, key) => {
		if (key.return) {
			const body = draft.trim();
			if (body.length > 0) {
				onSubmit(body);
			}
			setDraft("");
			return;
		}

		if (key.backspace || key.delete) {
			setDraft((current) => current.slice(0, -1));
			return;
		}

		if (input.length > 0 && !key.ctrl && !key.meta) {
			setDraft((current) => current + input);
		}
	});

	return (
		<Box>
			<Text color="green">› </Text>
			<Text>{draft}</Text>
		</Box>
	);
}
