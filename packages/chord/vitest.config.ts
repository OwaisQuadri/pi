import { defineConfig } from "vitest/config";

// Workspace packages (pi-telemetry, pi-schema) resolve to their sources, so Chord's tests need no build.
export default defineConfig({
	test: { environment: "node", testTimeout: 15_000 },
	resolve: { conditions: ["source"] },
	ssr: { resolve: { conditions: ["source"] } },
});
