import { describe, expect, it } from "vitest";
import { assertValue } from "./assertValue.ts";

describe("assertValue", () => {
	it("should return the value if it is not undefined", () => {
		const value = "value";
		expect(assertValue(value, "error")).toBe(value);
	});

	it("should throw an error if the value is undefined", () => {
		expect(() => assertValue(undefined, "error")).toThrowError("error");
	});
});
