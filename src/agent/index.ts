export {
	type AgentDaemon,
	type AgentDaemonOptions,
	startAgentDaemon,
} from "./daemon.ts";
export {
	appendLine,
	applySplices,
	deleteRange,
	insertAtCursor,
	moveCursor,
	type ReplaceOptions,
	replaceText,
	type Splice,
	typeText,
} from "./operations.ts";
