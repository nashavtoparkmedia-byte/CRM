import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateEvidence, verifyManifestInputs } from '../validate-architecture-evidence.mjs';

const root = new URL('../../../', import.meta.url);
const evidence = new URL('architecture/evidence/v1/', root);
const names = {
  inventory: 'module-inventory.json', dependencies: 'dependency-graph.json', writes: 'write-sites.json',
  ownership: 'data-ownership-candidates.json', providers: 'provider-dependencies.json', credentials: 'credential-access.json',
  runtime: 'runtime-interactions.json', hotspots: 'shared-hotspots.json', manifest: 'analysis-manifest.json',
};
const bundle = Object.fromEntries(await Promise.all(Object.entries(names).map(async ([key, name]) => [key, JSON.parse(await readFile(new URL(name, evidence), 'utf8'))])));
const repositoryRoot = new URL('.', root).pathname;

test('complete architecture evidence validates and all input hashes verify', async () => {
  const result = validateEvidence(bundle);
  assert.equal(result.modules, 27);
  assert.equal(result.files, 845);
  assert.equal(result.prismaWrites, 433);
  assert.deepEqual(await verifyManifestInputs(bundle.manifest, repositoryRoot), { verifiedInputFiles: 845, verifiedControlInputs: 4 });
});

test('unresolved internal import fails closed', () => {
  const invalid = structuredClone(bundle);
  invalid.dependencies.totals.unresolved_internal_imports = 1;
  assert.throws(() => validateEvidence(invalid), /unresolved internal imports remain/);
});

test('unresolved data owner fails closed', () => {
  const invalid = structuredClone(bundle);
  invalid.ownership.totals.unresolved_owners = 1;
  assert.throws(() => validateEvidence(invalid), /unresolved data owner candidates remain/);
});

test('missing write classification fails closed', () => {
  const invalid = structuredClone(bundle);
  invalid.writes.write_sites = invalid.writes.write_sites.filter((site) => site.classification !== 'LEGACY');
  invalid.writes.totals.prisma_write_sites = invalid.writes.write_sites.length;
  assert.throws(() => validateEvidence(invalid), /missing write classification: LEGACY/);
});

test('credential values fail closed', () => {
  const invalid = structuredClone(bundle);
  invalid.credentials.environment_access[0].value = 'forbidden';
  assert.throws(() => validateEvidence(invalid), /credential value field forbidden/);
});

test('queue without complete topology fails closed', () => {
  const invalid = structuredClone(bundle);
  invalid.runtime.queue_topology[0].consumers = [];
  assert.throws(() => validateEvidence(invalid), /queue producer\/consumer relationship incomplete/);
});
