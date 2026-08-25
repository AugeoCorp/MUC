// The colors participants are drawn in.
//
// Hex rather than the named terminal colors: the named set is sixteen entries,
// several of which (blue vs magenta, cyan vs green) render close together
// depending on the theme — and the theme is the user's, not ours. These eight
// are spaced evenly around the hue circle at a brightness that stays legible on
// a dark background, so two people beside each other never read as the same
// color.
//
// The server hands these out (see session.ts), which is the only way to
// guarantee no two people share one. `colorFromName` is the fallback for when
// there's no server to ask: `muc solo`, and the moment before the first
// assignment arrives.

export const PALETTE = [
	"#ff6b6b", // red
	"#ffa94d", // orange
	"#a9e34b", // lime
	"#38d9a9", // teal
	"#4dd2ff", // cyan
	"#748ffc", // indigo
	"#da77f2", // orchid
	"#ff6bb5", // pink
];

/** A stable color for a handle — the same name always gets the same one. */
export function colorFromName(name: string): string {
	let sum = 0;
	for (const character of name) sum += character.charCodeAt(0);
	return PALETTE[sum % PALETTE.length];
}
