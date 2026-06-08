import { defineConfig } from "tsdown";

export default defineConfig({
	entry: { cli: "src/cli.tsx" },
	outDir: "dist",
	format: "esm",
	fixedExtension: false,
	platform: "node",
	target: "node24",
	clean: true,
});
