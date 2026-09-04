/**
 * A query-string number as a non-negative integer, or `fallback` when it is
 * absent, negative, fractional, or not a number at all. Cursors and waits
 * both arrive this way, and a NaN slipping into either misbehaves quietly.
 */
export function parseNonNegativeInteger(
	value: string | null,
	fallback = 0,
): number {
	if (value === null) return fallback;
	const parsed = Number(value);
	return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}
