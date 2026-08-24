// The front door: what `muc` shows when it's run with no subcommand. It asks
// for exactly what `serve` and `connect` take as arguments — the mode, the
// session code when joining, and the handle — then hands them back so the CLI
// can run the very same path. Nothing here is a separate way to start a
// session; it's a way to fill in the blanks.
//
// Input goes through ink's `useInput` rather than the raw stdin stream the
// Editor parses: a prompt only needs arrows, Enter and Backspace, none of the
// Cmd-versus-Alt precision that forced the Editor's hand.

import { Box, Text, useApp, useInput } from "ink";
import { type ReactElement, useState } from "react";
import { isSessionCode } from "../net/tunnel.ts";
import { Title } from "./Title.tsx";

/** What to launch — everything but who's launching it. */
export type SessionPlan = { mode: "serve" } | { mode: "connect"; code: string };

/** A plan plus the handle, i.e. everything a session needs to start. */
export type LaunchChoice = SessionPlan & { handle: string };

interface LauncherProps {
	/** Pre-fills the handle field. */
	defaultHandle: string;
	/**
	 * Set when the command line already decided the mode (`muc serve`,
	 * `muc connect <code>`) — the prompt then asks for the handle alone.
	 */
	plan?: SessionPlan;
	/** Called once with the finished choice; the prompt exits straight after. */
	onLaunch: (choice: LaunchChoice) => void;
}

const MODES = [
	{
		mode: "serve",
		label: "Host a session",
		hint: "you'll get a code to share",
	},
	{
		mode: "connect",
		label: "Join a session",
		hint: "you'll need the host's code",
	},
] as const;

type Mode = (typeof MODES)[number]["mode"];
type Step = "mode" | "code" | "handle";

export function Launcher({
	defaultHandle,
	plan,
	onLaunch,
}: LauncherProps): ReactElement {
	const { exit } = useApp();
	const [step, setStep] = useState<Step>(
		plan === undefined ? "mode" : "handle",
	);
	const [mode, setMode] = useState<Mode>(plan?.mode ?? "serve");
	const [code, setCode] = useState(plan?.mode === "connect" ? plan.code : "");
	const [handle, setHandle] = useState(defaultHandle);
	const [problem, setProblem] = useState<string>();

	useInput((input, key) => {
		setProblem(undefined);

		if (step === "mode") {
			if (key.upArrow || key.downArrow) {
				setMode((current) => (current === "serve" ? "connect" : "serve"));
				return;
			}
			if (key.return) setStep(mode === "connect" ? "code" : "handle");
			return;
		}

		// Both remaining steps are plain text fields, so they share one editor.
		const value = step === "code" ? code : handle;
		const setValue = step === "code" ? setCode : setHandle;

		// Nothing to step back to when the command line already fixed the plan.
		if (key.escape) {
			if (plan === undefined) {
				setStep(step === "handle" && mode === "connect" ? "code" : "mode");
			}
			return;
		}
		if (key.return) {
			if (step === "code") {
				if (!isSessionCode(code.trim())) {
					setProblem(
						"That isn't a session code — it's one word, like wide-blue-cat-42.",
					);
					return;
				}
				setStep("handle");
				return;
			}
			const name = handle.trim() === "" ? defaultHandle : handle.trim();
			onLaunch(
				mode === "serve"
					? { mode, handle: name }
					: { mode, code: code.trim(), handle: name },
			);
			exit();
			return;
		}
		if (key.backspace || key.delete) {
			setValue(value.slice(0, -1));
			return;
		}
		if (input !== "" && !key.ctrl && !key.meta) setValue(value + input);
	});

	const chosen = MODES.find((option) => option.mode === mode);

	return (
		<Box flexDirection="column" padding={1}>
			<Title />
			<Box marginTop={1} flexDirection="column">
				{step === "mode" ? (
					<>
						<Text>What would you like to do?</Text>
						<Box marginTop={1} flexDirection="column">
							{MODES.map((option) => (
								<Text key={option.mode}>
									<Text color={option.mode === mode ? "cyan" : "gray"}>
										{option.mode === mode ? "❯ " : "  "}
									</Text>
									<Text bold={option.mode === mode}>{option.label}</Text>
									<Text color="gray"> · {option.hint}</Text>
								</Text>
							))}
						</Box>
					</>
				) : (
					<>
						<Text color="gray">
							{chosen?.label}
							{mode === "connect" && step === "handle" ? ` · ${code}` : ""}
						</Text>
						<Box marginTop={1}>
							<Text>
								{step === "code" ? "Session code  " : "Your handle  "}
							</Text>
							<Text bold>{step === "code" ? code : handle}</Text>
							<Text inverse> </Text>
						</Box>
					</>
				)}
				{problem !== undefined && (
					<Box marginTop={1}>
						<Text color="red">{problem}</Text>
					</Box>
				)}
				<Box marginTop={1}>
					<Text color="gray">
						{step === "mode"
							? "↑↓ choose · ⏎ confirm · ⌃c quit"
							: plan === undefined
								? "⏎ confirm · esc back · ⌃c quit"
								: "⏎ confirm · ⌃c quit"}
					</Text>
				</Box>
			</Box>
		</Box>
	);
}
