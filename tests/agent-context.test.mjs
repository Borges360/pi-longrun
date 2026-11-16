import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const read = (path) => readFileSync(path, 'utf8');
const normalize = (text) => text.replace(/\s+/gu, ' ').trim();

test('Longrun specialization and metadata match across clients', () => {
  const skill = read('.agents/skills/pi-longrun/SKILL.md');
  const cursorSkill = read('.cursor/skills/pi-longrun/SKILL.md');
  const metadata = read('.agents/skills/pi-longrun/metadata.yaml');
  const cursorMetadata = read('.cursor/skills/pi-longrun/metadata.yaml');
  assert.ok(skill.length > 0);
  assert.equal(cursorSkill, skill);
  assert.equal(cursorMetadata, metadata);
  for (const field of ['id: pi-longrun', 'owner: pi-longrun', 'version: 1.0.0', 'scope: "product-local; Pi, Codex and Cursor"']) {
    assert.ok(metadata.includes(field), field);
  }
});

test('product context is local and does not infer design-system adoption', () => {
  const agents = read('AGENTS.md');
  const marker = agents.indexOf('<!-- harness:start -->');
  assert.ok(marker > 0);
  const preamble = agents.slice(0, marker);
  assert.ok(preamble.includes('.agents/skills/pi-longrun/SKILL.md'));
  assert.doesNotMatch(preamble, /INTEIRO/i);
  const skill = read('.agents/skills/pi-longrun/SKILL.md');
  assert.match(skill, /design system unselected unless .* explicit adoption decision/u);
  assert.match(skill, /Do not add a mandatory sibling-extension dependency/u);
});

test('specialization matches the documented Longrun UI, storage, and security contracts', () => {
  const skill = read('.agents/skills/pi-longrun/SKILL.md');
  const readme = read('README.md');
  const architecture = read('ARCHITECTURE.md');
  const security = read('SECURITY.md');
  assert.equal(JSON.parse(read('package.json')).name, '@borges360/pi-longrun');
  for (const phrase of ['/longrun status', 'Execution, Progress, Recovery, and Settings', 'Ctrl+S', 'default file backend', 'ignore late results after cancellation']) {
    assert.ok(skill.includes(phrase), phrase);
  }
  for (const [source, phrase] of [
    [readme, 'Execution, Progress, Recovery and Settings'],
    [readme, 'active action cancels it and keeps the panel usable'],
    [architecture, 'No shared database or load order is required'],
    [security, 'The default backend never executes commands'],
  ]) assert.ok(normalize(source).includes(normalize(phrase)), phrase);
});
