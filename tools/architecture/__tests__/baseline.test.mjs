import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateBaseline, verifyEvidence } from '../validate-baseline.mjs';

const baselineUrl = new URL('../../../architecture/baseline/v1/authoritative-baseline.json', import.meta.url);
const baseline = JSON.parse(await readFile(baselineUrl, 'utf8'));

test('authoritative baseline is complete and evidence hashes verify', async () => {
  const result = validateBaseline(baseline);
  assert.equal(result.components, 15);
  assert.equal(result.evidenceInputs, 6);
  assert.deepEqual(await verifyEvidence(baseline), { verifiedEvidenceInputs: 6 });
});

test('duplicate component ids fail closed', () => {
  const invalid = structuredClone(baseline);
  invalid.components.push(structuredClone(invalid.components[0]));
  assert.throws(() => validateBaseline(invalid), /duplicate component id/);
});

test('missing required component fails closed', () => {
  const invalid = structuredClone(baseline);
  invalid.components = invalid.components.filter((component) => component.id !== 'messages');
  assert.throws(() => validateBaseline(invalid), /missing required component: messages/);
});

test('secret-like keys fail closed', () => {
  const invalid = structuredClone(baseline);
  invalid.components[0].secretValue = 'not-allowed';
  assert.throws(() => validateBaseline(invalid), /prohibited secret-like key/);
});

test('unknown evidence references fail closed', () => {
  const invalid = structuredClone(baseline);
  invalid.components[0].evidence = ['missing_evidence'];
  assert.throws(() => validateBaseline(invalid), /unknown component evidence/);
});

test('production components must remain protected', () => {
  const invalid = structuredClone(baseline);
  invalid.components.find((component) => component.lifecycle === 'PRODUCTION').protected = false;
  assert.throws(() => validateBaseline(invalid), /production component must be protected/);
});

test('formal top-level shape fails closed', () => {
  const invalid = structuredClone(baseline);
  invalid.unreviewed = true;
  assert.throws(() => validateBaseline(invalid), /unexpected top-level property/);
});

test('lifecycle categories cannot be implicit', () => {
  const invalid = structuredClone(baseline);
  delete invalid.lifecycle_separation.rejected_branches;
  assert.throws(() => validateBaseline(invalid), /lifecycle category required: rejected_branches/);
});
