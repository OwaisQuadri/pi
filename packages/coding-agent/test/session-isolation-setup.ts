import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const agentDir = mkdtempSync(join(tmpdir(), "pi-test-agent-"));
process.env[ENV_AGENT_DIR] = agentDir;

afterAll(() => {
	rmSync(agentDir, { recursive: true, force: true });
});
