// Quitting takes two ⌃c in quick succession rather than one.
//
// A single ⌃c is too easy to hit by reflex, and in a shared draft the cost is
// other people's too: the client drops you out of something being written
// together, and the server takes the whole session down with it.
//
// The client presses this on a ⌃c keystroke and the server on a SIGINT — the
// deciding is the same either way, so it lives here rather than twice.

import { useCallback, useEffect, useRef, useState } from "react";

const QUIT_WINDOW = 1500;

/** The ⌃c keystroke, as it arrives on a raw stdin. */
export const CTRL_C = "\x03";

interface ConfirmQuit {
	/** True while a second ⌃c would quit — show the prompt saying so. */
	armed: boolean;
	/** Returns true when this press is the confirming one. */
	press: () => boolean;
	/** Stand down — anything else the user does means they didn't mean it. */
	cancel: () => void;
}

export function useConfirmQuit(): ConfirmQuit {
	const [armed, setArmed] = useState(false);
	const pressedAt = useRef(0);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	const clear = useCallback((): void => {
		if (timer.current === undefined) return;
		clearTimeout(timer.current);
		timer.current = undefined;
	}, []);

	// Don't leave a timer running past the component.
	useEffect(() => clear, [clear]);

	const press = useCallback((): boolean => {
		const now = Date.now();
		if (now - pressedAt.current < QUIT_WINDOW) return true;

		pressedAt.current = now;
		setArmed(true);
		clear();
		timer.current = setTimeout(() => setArmed(false), QUIT_WINDOW);
		return false;
	}, [clear]);

	const cancel = useCallback((): void => {
		pressedAt.current = 0;
		clear();
		setArmed(false);
	}, [clear]);

	return { armed, press, cancel };
}
