// Participant colors, generated rather than picked from a list.
//
// A fixed palette has a fixed size: the ninth person wraps around and collides
// with the first, and with three people in the room you're using three colors
// that were chosen to be distinct from five others who aren't here. Working in
// hues instead, the server can put each arrival in the widest gap left on the
// color circle — two people land opposite each other, three at 120°, four at
// 90°, and it never runs out.
//
// Saturation and lightness are fixed so every hue comes out at a comparable
// weight; only the hue varies. These two values are tuned to stay legible on a
// dark terminal without glowing.

const SATURATION = 0.62;
const LIGHTNESS = 0.65;

// Where the first participant lands when the room is empty. Arbitrary — but
// fixed, so a session's first color doesn't change run to run.
const FIRST_HUE = 210;

/**
 * The hue furthest from every hue already in use: the middle of the widest gap
 * on the circle. Colors already handed out never move, so nobody's dot changes
 * underneath them as the room fills — each arrival just takes the roomiest spot
 * left, which stays close to an even spread.
 */
export function hueInLargestGap(taken: number[]): number {
	if (taken.length === 0) return FIRST_HUE;

	const sorted = taken
		.map(normalizeHue)
		.sort((first, second) => first - second);
	let chosen = FIRST_HUE;
	let widest = -1;

	sorted.forEach((hue, index) => {
		// Past the last hue the circle wraps back around to the first.
		const next =
			index === sorted.length - 1 ? sorted[0] + 360 : sorted[index + 1];
		const gap = next - hue;
		if (gap > widest) {
			widest = gap;
			chosen = normalizeHue(hue + gap / 2);
		}
	});

	return chosen;
}

/** Render a hue as the hex color Ink wants. */
export function hexFromHue(hue: number): string {
	const position = normalizeHue(hue) / 360;
	const upper =
		LIGHTNESS < 0.5
			? LIGHTNESS * (1 + SATURATION)
			: LIGHTNESS + SATURATION - LIGHTNESS * SATURATION;
	const lower = 2 * LIGHTNESS - upper;
	const channel = (offset: number): string =>
		Math.round(255 * channelAt(lower, upper, position + offset))
			.toString(16)
			.padStart(2, "0");
	return `#${channel(1 / 3)}${channel(0)}${channel(-1 / 3)}`;
}

/**
 * A stable color for a handle, used where there's no server to assign one —
 * `muc solo`, and the moment before the first assignment arrives.
 */
export function colorFromName(name: string): string {
	let sum = 0;
	for (const character of name) sum += character.charCodeAt(0);
	// Times a number coprime with 360, so neighbouring names land far apart.
	return hexFromHue(sum * 47);
}

function normalizeHue(hue: number): number {
	return ((hue % 360) + 360) % 360;
}

// The standard HSL→RGB channel curve, one channel at a time.
function channelAt(lower: number, upper: number, position: number): number {
	let point = position;
	if (point < 0) point += 1;
	if (point > 1) point -= 1;
	if (point < 1 / 6) return lower + (upper - lower) * 6 * point;
	if (point < 1 / 2) return upper;
	if (point < 2 / 3) return lower + (upper - lower) * (2 / 3 - point) * 6;
	return lower;
}
