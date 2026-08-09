import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateContexts, verifyContextIndex } from '../validate-context-manifests.mjs';

const repositoryRoot = new URL('../../../', import.meta.url);
const load = async (relative) => JSON.parse(await readFile(new URL(relative, repositoryRoot), 'utf8'));
const index = await load('architecture/contexts/v1/context-index.json');
const bundle = {
  decisions: await load('architecture/contexts/v1/context-decisions.json'),
  inventory: await load('architecture/evidence/v1/module-inventory.json'),
  dependencies: await load('architecture/evidence/v1/dependency-graph.json'),
  writes: await load('architecture/evidence/v1/write-sites.json'),
  ownership: await load('architecture/evidence/v1/data-ownership-candidates.json'),
  index,
  manifests: await Promise.all(index.contexts.map((entry) => load(entry.path))),
  foreignPlan: await load('architecture/contexts/v1/foreign-write-migration-plan.json'),
  dependencyPlan: await load('architecture/contexts/v1/dependency-transition-plan.json'),
};

test('bounded contexts cover modules, owned data, dependencies and foreign writes', async () => {
  assert.deepEqual(validateContexts(bundle), {
    contexts: 16,
    dependencyRelationships: 106,
    foreignWriteSites: 195,
    manifests: 16,
    migrationPlans: 79,
    ownedData: 96,
    technicalModules: 27,
  });
  assert.deepEqual(await verifyContextIndex(index, repositoryRoot.pathname), { verifiedControls: 8, verifiedManifests: 16, verifiedOutputs: 2 });
});

test('duplicate technical-module assignment fails closed', () => {
  const invalid = structuredClone(bundle);
  invalid.manifests[1].technical_modules.push(invalid.manifests[0].technical_modules[0]);
  assert.throws(() => validateContexts(invalid), /technical module assigned twice/);
});

test('duplicate data ownership fails closed', () => {
  const invalid = structuredClone(bundle);
  const owned = invalid.manifests.find((manifest) => manifest.owned_data.length > 0).owned_data[0];
  invalid.manifests.find((manifest) => manifest.context.id !== invalid.manifests.find((candidate) => candidate.owned_data.some((entry) => entry.id === owned.id)).context.id).owned_data.push(owned);
  assert.throws(() => validateContexts(invalid), /owned data assigned twice/);
});

test('unversioned public surface fails closed', () => {
  const invalid = structuredClone(bundle);
  invalid.manifests[0].public_surface = ['UnversionedContract'];
  assert.throws(() => validateContexts(invalid), /unversioned public surface/);
});

test('missing foreign-write coverage fails closed', () => {
  const invalid = structuredClone(bundle);
  invalid.foreignPlan.coverage.covered_site_ids.pop();
  assert.throws(() => validateContexts(invalid), /foreign-write coverage count mismatch/);
});

test('credential values fail closed', () => {
  const invalid = structuredClone(bundle);
  invalid.manifests[0].credential_relationships.value = 'forbidden';
  assert.throws(() => validateContexts(invalid), /credential value field forbidden/);
});

test('hidden dependency-transition gap fails closed', () => {
  const invalid = structuredClone(bundle);
  invalid.dependencyPlan.current_relationships.pop();
  assert.throws(() => validateContexts(invalid), /dependency transition coverage mismatch/);
});

test('cyclic target dependency policy fails closed', () => {
  const invalid = structuredClone(bundle);
  const first = invalid.manifests.find((manifest) => manifest.context.id === 'contacts');
  const second = invalid.manifests.find((manifest) => manifest.context.id === 'identity_access');
  second.allowed_dependencies.push({ context: first.context.id, surface: `${first.context.id}.public` });
  assert.throws(() => validateContexts(invalid), /target allowed-dependency graph must be acyclic/);
});
