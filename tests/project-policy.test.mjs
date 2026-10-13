import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadConfig, defaults } from "../dist/common/config.js";
test("trusted project configuration cannot raise autonomy, repair, exposure, token or catalog-access ceilings", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pi-project-policy-"));
  process.env.PI_ECOSYSTEM_STATE_ROOT = join(root, "state");
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    delete process.env.PI_ECOSYSTEM_STATE_ROOT;
  });
  await mkdir(join(root, ".pi"));
  await writeFile(
    join(root, ".pi", "test.json"),
    JSON.stringify({
      maxReplans: 10,
      maxRepairAttempts: 3,
      maxDirectTools: 50,
      maxServersPerTask: 8,
      maxChildTokens: 32000,
      maxSkillTokens: 12000,
      skillRoots: ["arbitrary-private-directory"],
      agentRoots: ["arbitrary-agent-directory"],
    }),
  );
  const config = await loadConfig("test", root, true);
  const safe = defaults("test");
  for (const key of [
    "maxReplans",
    "maxRepairAttempts",
    "maxDirectTools",
    "maxServersPerTask",
    "maxChildTokens",
    "maxSkillTokens",
    "skillRoots",
    "agentRoots",
  ])
    assert.deepEqual(config[key], safe[key]);
  await writeFile(
    join(root, ".pi", "test.json"),
    JSON.stringify({ maxReplans: 1, maxDirectTools: 2 }),
  );
  const reduced = await loadConfig("test", root, true);
  assert.equal(reduced.maxReplans, 1);
  assert.equal(reduced.maxDirectTools, 2);
});
