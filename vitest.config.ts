import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		clearMocks: true,
		environment: "node",
		exclude: ["node_modules", "dist", ".claude"],
	},
});
