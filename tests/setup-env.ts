// Keeps the suite independent of the developer's real ~/.pi/agent config.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.env.PI_CODING_AGENT_DIR) {
  process.env.PI_CODING_AGENT_DIR = mkdtempSync(join(tmpdir(), "pi-on-steroids-test-agent-"));
}
