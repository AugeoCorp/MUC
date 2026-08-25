import { describe, expect, it } from "vitest";
import { colorFromName, hexFromHue, hueInLargestGap } from "./colors.ts";

describe("hueInLargestGap", () => {
	it("should place the first participant at a fixed hue", () => {
		expect(hueInLargestGap([])).toBe(210);
	});

	it("should place the second participant opposite the first", () => {
		expect(hueInLargestGap([0])).toBe(180);
		expect(hueInLargestGap([90])).toBe(270);
	});

	it("should split the widest remaining gap", () => {
		expect(hueInLargestGap([0, 180])).toBe(90);
		expect(hueInLargestGap([0, 90, 180])).toBe(270);
	});

	it("should wrap around the end of the circle", () => {
		// The widest gap runs from 300 through 0 to 60, so its middle is 0.
		expect(hueInLargestGap([60, 120, 180, 240, 300])).toBe(0);
	});

	it("should treat hues outside 0-360 as their wrapped equivalent", () => {
		expect(hueInLargestGap([360])).toBe(180);
		expect(hueInLargestGap([-90])).toBe(90);
	});

	it("should keep every hue well separated as the room fills", () => {
		const taken: number[] = [];
		for (let count = 0; count < 8; count++) {
			taken.push(hueInLargestGap(taken));
		}
		const sorted = [...taken].sort((first, second) => first - second);
		const gaps = sorted.map((hue, index) =>
			index === sorted.length - 1
				? sorted[0] + 360 - hue
				: sorted[index + 1] - hue,
		);
		// Eight evenly spread hues sit 45° apart; nothing should be tighter.
		expect(Math.min(...gaps)).toBe(45);
	});
});

describe("hexFromHue", () => {
	it("should render a six-digit hex color", () => {
		expect(hexFromHue(210)).toMatch(/^#[0-9a-f]{6}$/);
	});

	it("should give the same color for equivalent hues", () => {
		expect(hexFromHue(30)).toBe(hexFromHue(390));
	});

	it("should give different colors for hues far apart", () => {
		expect(hexFromHue(0)).not.toBe(hexFromHue(180));
	});
});

describe("colorFromName", () => {
	it("should give a handle the same color every time", () => {
		expect(colorFromName("echo")).toBe(colorFromName("echo"));
	});

	it("should render a six-digit hex color", () => {
		expect(colorFromName("nova")).toMatch(/^#[0-9a-f]{6}$/);
	});
});
