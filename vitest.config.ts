import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "jsdom",
		setupFiles: ["./test/setup.ts"],
		include: ["test/**/*.test.ts"],
		coverage: {
			provider: "v8",
			include: ["src/svgToPng.ts"],
			reporter: ["text", "html"],
			thresholds: {
				"src/svgToPng.ts": {
					lines: 70,
					statements: 70,
					functions: 70,
					branches: 70,
				},
			},
		},
	},
});
