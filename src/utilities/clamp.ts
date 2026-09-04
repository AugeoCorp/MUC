/** `value` held within `[low, high]`. NaN passes through every comparison, so it comes back as NaN — callers that can see NaN must check first. */
export function clamp(value: number, low: number, high: number): number {
	return Math.max(low, Math.min(value, high));
}
