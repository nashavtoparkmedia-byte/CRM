import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
  finalDependency: await load('architecture/contexts/v1/final-dependency-current.json'),
  finalDependencySource: await load('architecture/contexts/v1/final-dependency-source.json'),
};

test('bounded contexts cover modules, owned data, dependencies and foreign writes', async () => {
  assert.deepEqual(validateContexts(bundle), {
    contexts: 16,
    dependencyRelationships: 106,
    foreignWriteSites: 195,
    manifests: 16,
    migrationPlans: 79,
    ownedData: 97,
    technicalModules: 27,
    ownedPaths: 87,
  });
  assert.deepEqual(await verifyContextIndex(index, repositoryRoot.pathname), { verifiedControls: 17, verifiedEntrypoints: 45, verifiedManifests: 16, verifiedOutputs: 5 });
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

test('overlapping owned paths fail closed', () => {
  const invalid = structuredClone(bundle);
  const calling = invalid.manifests.find((manifest) => manifest.context.id === 'calling');
  calling.owned_paths.push('gravity-mvp/src/modules/calling/internal');
  assert.throws(() => validateContexts(invalid), /overlapping owned paths/);
});

test('owned path overlap between contexts fails closed', () => {
  const invalid = structuredClone(bundle);
  const contacts = invalid.manifests.find((manifest) => manifest.context.id === 'contacts');
  contacts.owned_paths.push('gravity-mvp/src/modules/calling');
  assert.throws(() => validateContexts(invalid), /owned path overlap/);
});

test('owned paths must cover every declared internal surface', () => {
  const invalid = structuredClone(bundle);
  const calling = invalid.manifests.find((manifest) => manifest.context.id === 'calling');
  calling.owned_paths = calling.owned_paths.filter((ownedPath) => ownedPath !== 'gravity-mvp/src/lib/calls');
  assert.throws(() => validateContexts(invalid), /internal surface absent from owned paths/);
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
  invalid.dependencyPlan.historical_relationships.pop();
  assert.throws(() => validateContexts(invalid), /dependency transition coverage mismatch/);
});

test('final dependency artifact cannot retain debt', () => {
  const invalid = structuredClone(bundle);
  invalid.finalDependency.summary.forbidden_dependencies = 1;
  assert.throws(() => validateContexts(invalid), /current dependency artifact retains enforcement debt/);
});

test('current dependency artifact fails closed on coordinated debt', () => {
  const invalid = structuredClone(bundle);
  invalid.finalDependencySource.observed.architecture_findings = 1;
  invalid.finalDependency.summary.forbidden_dependencies = 1;
  assert.throws(() => validateContexts(invalid), /current dependency artifact retains enforcement debt/);
});

test('accepted dependency source cannot hide observed dependency truth', () => {
  const invalid = structuredClone(bundle);
  invalid.finalDependencySource.observed.cross_context_imports = 0;
  assert.throws(() => validateContexts(invalid), /accepted dependency source hides observed cross-context imports/);
});

test('cyclic target dependency policy fails closed', () => {
  const invalid = structuredClone(bundle);
  const first = invalid.manifests.find((manifest) => manifest.context.id === 'contacts');
  const second = invalid.manifests.find((manifest) => manifest.context.id === 'identity_access');
  second.allowed_dependencies.push({ context: first.context.id, surface: `${first.context.id}.public` });
  assert.throws(() => validateContexts(invalid), /target allowed-dependency graph must be acyclic/);
});

test('missing module verification profile fails closed', () => {
  const invalid = structuredClone(bundle);
  delete invalid.manifests[0].verification;
  assert.throws(() => validateContexts(invalid), /verification profile missing/);
});

test('blast-radius consumer drift fails closed', () => {
  const invalid = structuredClone(bundle);
  invalid.manifests.find((manifest) => manifest.context.id === 'contacts').verification.blast_radius.consumer_contexts = [];
  assert.throws(() => validateContexts(invalid), /blast-radius consumer drift/);
});

test('provider-specific verification cannot widen to sibling providers', () => {
  const invalid = structuredClone(bundle);
  const max = invalid.manifests.find((manifest) => manifest.context.id === 'max_channel');
  max.verification.blast_radius.provider_siblings = ['telegram_channel'];
  assert.throws(() => validateContexts(invalid), /provider-specific blast radius widened/);
});

test('ordinary context-index validation rejects hash drift and only the explicit materializer refreshes every reference', async () => {
  const temporary = await mkdtemp(path.join(tmpdir(), 'yoko-context-index-hashes-'));
  const digest = (value) => createHash('sha256').update(value).digest('hex');
  try {
    const manifestRelative = 'manifests/fixture.json';
    const controlRelative = 'controls/fixture.mjs';
    const outputRelative = 'outputs/fixture.json';
    const indexRelative = 'context-index.json';
    await Promise.all([
      mkdir(path.join(temporary, 'manifests'), { recursive: true }),
      mkdir(path.join(temporary, 'controls'), { recursive: true }),
      mkdir(path.join(temporary, 'outputs'), { recursive: true }),
    ]);
    const manifestBefore = `${JSON.stringify({ verification: { module_tests: [], contract_tests: [], architecture_checks: [], build_checks: [] } })}\n`;
    const controlBefore = 'export const fixture = 1\n';
    const outputBefore = '{"status":"before"}\n';
    await Promise.all([
      writeFile(path.join(temporary, manifestRelative), manifestBefore),
      writeFile(path.join(temporary, controlRelative), controlBefore),
      writeFile(path.join(temporary, outputRelative), outputBefore),
    ]);
    const fixtureIndex = {
      schema: 'yoko.crm.context-index.v1',
      contexts: [{ context: 'fixture', path: manifestRelative, sha256: digest(manifestBefore) }],
      controls: { fixture_control: { path: controlRelative, sha256: digest(controlBefore) } },
      outputs: { fixture_output: { path: outputRelative, sha256: digest(outputBefore) } },
    };
    const indexFile = path.join(temporary, indexRelative);
    await writeFile(indexFile, `${JSON.stringify(fixtureIndex, null, 2)}\n`);
    assert.deepEqual(await verifyContextIndex(fixtureIndex, temporary), {
      verifiedControls: 1,
      verifiedEntrypoints: 0,
      verifiedManifests: 1,
      verifiedOutputs: 1,
    });

    const manifestAfter = `${JSON.stringify({ verification: { module_tests: [], contract_tests: [], architecture_checks: [], build_checks: [] }, changed: true })}\n`;
    const controlAfter = 'export const fixture = 2\n';
    const outputAfter = '{"status":"after"}\n';
    await Promise.all([
      writeFile(path.join(temporary, manifestRelative), manifestAfter),
      writeFile(path.join(temporary, controlRelative), controlAfter),
      writeFile(path.join(temporary, outputRelative), outputAfter),
    ]);
    await assert.rejects(verifyContextIndex(fixtureIndex, temporary), /control hash mismatch/);
    const enricher = fileURLToPath(new URL('../enrich-context-manifests.mjs', import.meta.url));
    const ordinary = spawnSync(process.execPath, [enricher, '--root', temporary, '--index', indexRelative], { encoding: 'utf8' });
    assert.notEqual(ordinary.status, 0, 'ordinary hash verification must fail closed on drift');
    assert.match(`${ordinary.stdout}\n${ordinary.stderr}`, /(?:context|control|output) hash mismatch/);
    assert.deepEqual(JSON.parse(await readFile(indexFile, 'utf8')), fixtureIndex, 'ordinary validation must not refresh accepted hashes');

    const explicit = spawnSync(process.execPath, [
      enricher,
      '--root', temporary,
      '--index', indexRelative,
      '--materialize-index-hashes',
    ], { encoding: 'utf8' });
    assert.equal(explicit.status, 0, `${explicit.stdout}\n${explicit.stderr}`);
    assert.match(explicit.stdout, /context index exact hashes: MATERIALIZED \(1 contexts; 1 controls; 1 outputs\)/);
    const refreshed = JSON.parse(await readFile(indexFile, 'utf8'));
    assert.equal(refreshed.contexts[0].sha256, digest(manifestAfter));
    assert.equal(refreshed.controls.fixture_control.sha256, digest(controlAfter));
    assert.equal(refreshed.outputs.fixture_output.sha256, digest(outputAfter));
    assert.deepEqual(await verifyContextIndex(refreshed, temporary), {
      verifiedControls: 1,
      verifiedEntrypoints: 0,
      verifiedManifests: 1,
      verifiedOutputs: 1,
    });
    const once = await readFile(indexFile, 'utf8');
    const repeated = spawnSync(process.execPath, [
      enricher,
      '--root', temporary,
      '--index', indexRelative,
      '--materialize-index-hashes',
    ], { encoding: 'utf8' });
    assert.equal(repeated.status, 0, `${repeated.stdout}\n${repeated.stderr}`);
    assert.equal(await readFile(indexFile, 'utf8'), once, 'explicit hash materialization must be byte-deterministic');
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
