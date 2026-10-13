import test from "node:test";
import assert from "node:assert/strict";
import { fetchPinnedText } from "../dist/common/fetch.js";
import { digest } from "../dist/common/security.js";
test("remote supply chain requires HTTPS, immutable hash and bounded content", async () => {
  const text = "audited skill";
  const mock = async () => new Response(text);
  assert.equal(
    await fetchPinnedText("https://example.test/skill.md", digest(text), {
      fetch: mock,
    }),
    text,
  );
  await assert.rejects(
    fetchPinnedText("http://example.test/skill.md", digest(text), {
      fetch: mock,
    }),
    /https/,
  );
  await assert.rejects(
    fetchPinnedText("https://example.test/skill.md", "0".repeat(64), {
      fetch: mock,
    }),
    /hash/,
  );
  await assert.rejects(
    fetchPinnedText("https://example.test/skill.md", digest(text), {
      fetch: mock,
      maxBytes: 3,
    }),
    /too-large/,
  );
});
