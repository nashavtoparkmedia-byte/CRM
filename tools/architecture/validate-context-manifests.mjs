import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveCurrentDependencySource } from './derive-final-dependency-source.mjs';
import { materializeFinalDependencyArtifact } from './materialize-final-dependency-artifact.mjs';
import {
  CURRENT_DEPENDENCY_PATH,
  validateExecutablePathOwnershipCoverage,
  validateExecutablePathOwnershipDependencies,
  validateExecutablePathOwnershipProvenance,
} from './validate-executable-path-ownership.mjs';
import { inventoryTrackedSurfaces } from './v2/tracked-surface-inventory.mjs';

const SHA256 = /^[0-9a-f]{64}$/;
const WRITE_MIGRATION_CLASSES = new Set(['FOREIGN', 'LEGACY', 'SHARED_AMBIGUOUS']);
const VERIFICATION_COMMAND = /^node tools\/architecture\/[a-z0-9./-]+\.mjs$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function siteId(site) {
  return `write_${digest(JSON.stringify(stable(site))).slice(0, 20)}`;
}

function pathContains(ownerPath, candidatePath) {
  return candidatePath === ownerPath || candidatePath.startsWith(`${ownerPath}/`);
}

function assertNoValues(value, trail = '$') {
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoValues(entry, `${trail}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, entry] of Object.entries(value)) {
    assert(!['value', 'secret', 'password', 'token'].includes(key.toLowerCase()), `credential value field forbidden at ${trail}.${key}`);
    assertNoValues(entry, `${trail}.${key}`);
  }
}

function dependencyCycles(manifests) {
  const adjacency = new Map(manifests.map((manifest) => [manifest.context.id, manifest.allowed_dependencies.map((dependency) => dependency.context)]));
  let index = 0;
  const indices = new Map();
  const low = new Map();
  const stack = [];
  const onStack = new Set();
  const cycles = [];
  function visit(node) {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of adjacency.get(node) ?? []) {
      if (!indices.has(target)) {
        visit(target);
        low.set(node, Math.min(low.get(node), low.get(target)));
      } else if (onStack.has(target)) low.set(node, Math.min(low.get(node), indices.get(target)));
    }
    if (low.get(node) === indices.get(node)) {
      const component = [];
      let current;
      do {
        current = stack.pop();
        onStack.delete(current);
        component.push(current);
      } while (current !== node);
      if (component.length > 1) cycles.push(component.sort());
    }
  }
  for (const node of adjacency.keys()) if (!indices.has(node)) visit(node);
  return cycles;
}

export function validateContexts(bundle) {
  const { decisions, inventory, dependencies, writes, ownership, index, manifests, foreignPlan, dependencyPlan, finalDependency, finalDependencySource, executableOwnershipDependencies } = bundle;
  validateExecutablePathOwnershipDependencies(executableOwnershipDependencies, { contextIndex: index });
  assert(index.outputs?.executable_path_ownership_current_dependencies?.path === CURRENT_DEPENDENCY_PATH, 'context index does not declare executable ownership current dependencies');
  assert(decisions.schema === 'yoko.crm.context-decisions.v1' && decisions.milestone === 'CRM-ARCH-003', 'context decision identity mismatch');
  const contextIds = new Set(decisions.contexts.map((context) => context.id));
  assert(contextIds.size === decisions.contexts.length, 'duplicate context id');
  assert(manifests.length === decisions.contexts.length && index.contexts.length === decisions.contexts.length, 'manifest/context count mismatch');

  const expectedModules = new Set(inventory.modules.map((module) => module.id));
  const assignedModules = new Map();
  for (const manifest of manifests) {
    assert(manifest.schema === 'yoko.crm.module-manifest.v1' && manifest.version === 1, 'module manifest identity mismatch');
    assert(contextIds.has(manifest.context.id), `unknown manifest context: ${manifest.context.id}`);
    assert(manifest.owner?.context === manifest.context.id && typeof manifest.owner?.accountability === 'string' && manifest.owner.accountability.length > 0, `functional owner missing: ${manifest.context.id}`);
    assert(typeof manifest.responsibility === 'string' && manifest.responsibility.length > 0, `responsibility missing: ${manifest.context.id}`);
    assert(manifest.technical_modules.length > 0, `technical modules missing: ${manifest.context.id}`);
    for (const module of manifest.technical_modules) {
      assert(expectedModules.has(module), `unknown technical module: ${module}`);
      assert(!assignedModules.has(module), `technical module assigned twice: ${module}`);
      assignedModules.set(module, manifest.context.id);
    }
    assert(Array.isArray(manifest.public_surface) && Array.isArray(manifest.internal_surface) && manifest.internal_surface.length > 0, `surface missing: ${manifest.context.id}`);
    assert(Array.isArray(manifest.owned_paths) && manifest.owned_paths.length > 0, `owned paths missing: ${manifest.context.id}`);
    assert(new Set(manifest.owned_paths).size === manifest.owned_paths.length, `duplicate owned path: ${manifest.context.id}`);
    assert(manifest.owned_paths.every((ownedPath) => !path.isAbsolute(ownedPath) && !ownedPath.split('/').includes('..')), `unsafe owned path: ${manifest.context.id}`);
    assert(manifest.internal_surface.every((surface) => manifest.owned_paths.some((ownedPath) => pathContains(ownedPath, surface))), `internal surface absent from owned paths: ${manifest.context.id}`);
    for (let left = 0; left < manifest.owned_paths.length; left += 1) {
      for (let right = left + 1; right < manifest.owned_paths.length; right += 1) {
        assert(!pathContains(manifest.owned_paths[left], manifest.owned_paths[right]) && !pathContains(manifest.owned_paths[right], manifest.owned_paths[left]), `overlapping owned paths: ${manifest.context.id}`);
      }
    }
    assert(manifest.public_surface.every((contract) => /\.v[1-9][0-9]*$/.test(contract)), `unversioned public surface: ${manifest.context.id}`);
    assert(manifest.protected === true, `context compatibility protection missing: ${manifest.context.id}`);
    assert(typeof manifest.compatibility_strategy === 'string' && manifest.compatibility_strategy.length > 0, `compatibility strategy missing: ${manifest.context.id}`);
    assert(manifest.forbidden_dependencies.includes('directForeignPrismaWrites'), `foreign-write prohibition missing: ${manifest.context.id}`);
    for (const dependency of manifest.allowed_dependencies) {
      assert(contextIds.has(dependency.context) && dependency.context !== manifest.context.id, `invalid allowed dependency: ${manifest.context.id}/${dependency.context}`);
      assert(dependency.surface === `${dependency.context}.public`, `dependency must target public surface: ${manifest.context.id}/${dependency.context}`);
    }
    assertNoValues(manifest.credential_relationships, `manifest.${manifest.context.id}.credential_relationships`);
    assert(manifest.credential_relationships.policy.includes('Values stay inside'), `credential policy missing: ${manifest.context.id}`);
    const verification = manifest.verification;
    assert(verification && ['module_tests', 'contract_tests', 'architecture_checks', 'build_checks'].every((key) => Array.isArray(verification[key]) && verification[key].length > 0), `verification profile missing: ${manifest.context.id}`);
    assert(['module_tests', 'contract_tests', 'architecture_checks', 'build_checks'].flatMap((key) => verification[key]).every((entry) => VERIFICATION_COMMAND.test(entry)), `invalid verification command: ${manifest.context.id}`);
    assert(verification.architecture_checks.includes('node tools/architecture/validate-context-manifests.mjs') && verification.architecture_checks.includes('node tools/architecture/enforce-architecture.mjs'), `architecture entrypoint missing: ${manifest.context.id}`);
    assert(verification.contract_tests.includes('node tools/architecture/validate-contract-registry.mjs'), `contract entrypoint missing: ${manifest.context.id}`);
    assert(verification.build_checks.includes('node tools/architecture/check-typescript-baseline.mjs'), `build entrypoint missing: ${manifest.context.id}`);
    assert(verification.blast_radius?.owner_context === manifest.context.id, `blast-radius owner mismatch: ${manifest.context.id}`);
  }
  assert(assignedModules.size === expectedModules.size, 'not every technical module is assigned');
  const allOwnedPaths = manifests.flatMap((manifest) => manifest.owned_paths.map((ownedPath) => ({ context: manifest.context.id, ownedPath })));
  for (let left = 0; left < allOwnedPaths.length; left += 1) {
    for (let right = left + 1; right < allOwnedPaths.length; right += 1) {
      const first = allOwnedPaths[left];
      const second = allOwnedPaths[right];
      assert(!pathContains(first.ownedPath, second.ownedPath) && !pathContains(second.ownedPath, first.ownedPath), `owned path overlap: ${first.context}/${second.context}`);
    }
  }
  assert(dependencyCycles(manifests).length === 0, 'target allowed-dependency graph must be acyclic');
  for (const manifest of manifests) {
    const expectedConsumers = manifests.filter((candidate) => candidate.allowed_dependencies.some((dependency) => dependency.context === manifest.context.id)).map((candidate) => candidate.context.id).sort();
    assert(JSON.stringify(manifest.verification.blast_radius.consumer_contexts) === JSON.stringify(expectedConsumers), `blast-radius consumer drift: ${manifest.context.id}`);
    const provider = manifest.verification.blast_radius;
    if (manifest.context.id === 'messaging') {
      assert(provider.provider_scope === 'SHARED_PROVIDER_CONTRACT' && JSON.stringify(provider.provider_siblings) === JSON.stringify(['max_channel', 'telegram_channel', 'whatsapp_channel']), 'shared provider blast radius missing: messaging');
    } else if (['max_channel', 'telegram_channel', 'whatsapp_channel'].includes(manifest.context.id)) {
      assert(provider.provider_scope === 'PROVIDER_SPECIFIC' && provider.provider_siblings.length === 0, `provider-specific blast radius widened: ${manifest.context.id}`);
    } else assert(provider.provider_scope === 'NOT_APPLICABLE' && provider.provider_siblings.length === 0, `unexpected provider blast radius: ${manifest.context.id}`);
  }

  const expectedOwnedData = new Set(ownership.models.map((model) => model.id));
  const assignedOwnedData = new Map();
  for (const manifest of manifests) {
    for (const model of manifest.owned_data) {
      assert(expectedOwnedData.has(model.id), `unknown owned data id: ${model.id}`);
      assert(!assignedOwnedData.has(model.id), `owned data assigned twice: ${model.id}`);
      assignedOwnedData.set(model.id, manifest.context.id);
    }
  }
  assert(assignedOwnedData.size === expectedOwnedData.size, 'not every ownership candidate is assigned exactly once');

  const migrationSites = writes.write_sites.filter((site) => WRITE_MIGRATION_CLASSES.has(site.classification));
  const expectedSiteIds = new Set(migrationSites.map(siteId));
  const coveredSiteIds = new Set(foreignPlan.coverage.covered_site_ids);
  assert(expectedSiteIds.size === migrationSites.length, 'write-site identity collision');
  assert(coveredSiteIds.size === expectedSiteIds.size, 'foreign-write coverage count mismatch');
  for (const id of expectedSiteIds) assert(coveredSiteIds.has(id), `foreign-write site not covered: ${id}`);
  assert(foreignPlan.coverage.sites_requiring_migration === migrationSites.length, 'foreign-write migration total mismatch');
  const planIds = new Set();
  const planSiteIds = [];
  for (const plan of foreignPlan.plans) {
    assert(!planIds.has(plan.id), `duplicate migration plan: ${plan.id}`);
    planIds.add(plan.id);
    assert(plan.site_count === plan.sites.length && plan.sites.length > 0, `empty migration plan: ${plan.id}`);
    assert(plan.strategy?.migration && plan.strategy?.adapter && plan.recovery, `incomplete migration strategy: ${plan.id}`);
    assert(!plan.owner_contexts.includes('unresolved_raw_scope') && !plan.models.includes('dynamic_raw_scope'), `unresolved final ownership: ${plan.id}`);
    planSiteIds.push(...plan.sites.map((site) => site.id));
  }
  assert(new Set(planSiteIds).size === planSiteIds.length && planSiteIds.length === migrationSites.length, 'migration plan site overlap/gap');
  for (const manifest of manifests) for (const planId of manifest.foreign_write_migration_plans) assert(planIds.has(planId), `unknown migration-plan reference: ${manifest.context.id}/${planId}`);

  const expectedCrossEdges = dependencies.module_edges.filter((edge) => assignedModules.get(edge.source) !== assignedModules.get(edge.target));
  assert(dependencyPlan.schema === 'yoko.crm.historical-dependency-transition-plan.v1' && dependencyPlan.historical_status === 'ARCHIVED_BASELINE_EVIDENCE_NOT_CURRENT_DEPENDENCY_TRUTH', 'dependency transition plan must be explicitly historical');
  assert(dependencyPlan.historical_relationships.length === expectedCrossEdges.length, 'dependency transition coverage mismatch');
  const relationshipKeys = new Set(dependencyPlan.historical_relationships.map((edge) => `${edge.source_module}>${edge.target_module}`));
  for (const edge of expectedCrossEdges) assert(relationshipKeys.has(`${edge.source}>${edge.target}`), `cross-context dependency missing: ${edge.source}>${edge.target}`);
  assert(dependencyPlan.historical_relationships.every((edge) => edge.transition && contextIds.has(edge.source_context) && contextIds.has(edge.target_context)), 'incomplete historical dependency transition');
  assert(dependencyPlan.summary.currently_forbidden > 0, 'historical dependency evidence unexpectedly lacks observed forbidden dependencies');
  assert(finalDependency?.schema === 'yoko.crm.final-dependency-current.v1', 'final dependency artifact identity mismatch');
  assert(finalDependencySource?.schema === 'yoko.crm.accepted-dependency-source.v1' && finalDependencySource.derivation?.kind === 'architecture-enforcement-observed-cross-context-imports', 'accepted dependency source identity mismatch');
  assert(Number.isInteger(finalDependencySource.observed?.cross_context_imports) && finalDependencySource.observed.cross_context_imports > 0, 'accepted dependency source hides observed cross-context imports');
  assert(Number.isInteger(finalDependencySource.relationship_projection?.count) && finalDependencySource.relationship_projection.count > 0 && SHA256.test(finalDependencySource.relationship_projection.sha256), 'accepted dependency source relationship projection missing');
  assert(Array.isArray(finalDependencySource.public_surface_migrations) && finalDependencySource.public_surface_migrations.length === 0, 'accepted dependency source retains public-surface migration debt');
  assert(finalDependencySource.observed.architecture_findings === 0 && finalDependency.summary?.forbidden_dependencies === 0, 'current dependency artifact retains enforcement debt');
  assert(finalDependency.source_sha256 === digest(`${JSON.stringify(stable(finalDependencySource), null, 2)}\n`), 'final dependency artifact source digest mismatch');
  assert(finalDependency.summary?.forbidden_dependencies === finalDependencySource.observed.architecture_findings, 'final dependency artifact enforcement finding drift');
  assert(finalDependency.summary?.public_surface_migrations === 0, 'final dependency artifact retains public-surface migration debt');
  assert(finalDependency.summary?.relationships === finalDependencySource.relationship_projection.count, 'final dependency artifact relationship projection drift');
  return {
    contexts: decisions.contexts.length,
    dependencyRelationships: dependencyPlan.historical_relationships.length,
    foreignWriteSites: migrationSites.length,
    manifests: manifests.length,
    migrationPlans: foreignPlan.plans.length,
    ownedData: assignedOwnedData.size,
    technicalModules: assignedModules.size,
    ownedPaths: allOwnedPaths.length,
  };
}

export async function verifyCurrentDependencyTruth(repositoryRoot, finalDependencySource, finalDependency) {
  const derived = await deriveCurrentDependencySource(repositoryRoot);
  assert(JSON.stringify(stable(finalDependencySource)) === JSON.stringify(stable(derived)), 'accepted dependency source is not derived from current architecture enforcement');
  const sourceBytes = await readFile(path.join(repositoryRoot, 'architecture/contexts/v1/final-dependency-source.json'), 'utf8');
  assert(JSON.stringify(finalDependency) === JSON.stringify(materializeFinalDependencyArtifact(sourceBytes)), 'final dependency artifact is not materialized from current derived source');
  return derived.observed;
}

export async function verifyExecutablePathOwnership(repositoryRoot, manifests) {
  const [registry, coverage] = await Promise.all([
    readFile(path.join(repositoryRoot, 'architecture/recovery/whole-project-dod/v2/LIFECYCLE_SURFACE_CLASSIFICATION_REGISTRY.json'), 'utf8').then(JSON.parse),
    readFile(path.join(repositoryRoot, 'architecture/contexts/v1/executable-path-ownership-coverage.json'), 'utf8').then(JSON.parse),
  ]);
  const inventory = await inventoryTrackedSurfaces(repositoryRoot, { registry });
  const derived = validateExecutablePathOwnershipCoverage(inventory, manifests, coverage);
  await validateExecutablePathOwnershipProvenance(repositoryRoot, coverage, inventory, manifests);
  return derived;
}

export async function verifyContextIndex(index, repositoryRoot) {
  let controls = 0;
  for (const control of Object.values(index.controls)) {
    const bytes = await readFile(path.join(repositoryRoot, control.path));
    assert(SHA256.test(control.sha256) && digest(bytes) === control.sha256, `control hash mismatch: ${control.path}`);
    controls += 1;
  }
  let manifests = 0;
  const entrypoints = new Set();
  for (const entry of index.contexts) {
    const bytes = await readFile(path.join(repositoryRoot, entry.path));
    assert(SHA256.test(entry.sha256) && digest(bytes) === entry.sha256, `manifest hash mismatch: ${entry.path}`);
    const manifest = JSON.parse(bytes);
    for (const command of ['module_tests', 'contract_tests', 'architecture_checks', 'build_checks'].flatMap((key) => manifest.verification[key])) {
      const relative = command.replace(/^node /, '');
      await readFile(path.join(repositoryRoot, relative));
      entrypoints.add(relative);
    }
    manifests += 1;
  }
  let outputs = 0;
  for (const output of Object.values(index.outputs)) {
    const bytes = await readFile(path.join(repositoryRoot, output.path));
    assert(SHA256.test(output.sha256) && digest(bytes) === output.sha256, `output hash mismatch: ${output.path}`);
    outputs += 1;
  }
  return { verifiedControls: controls, verifiedEntrypoints: entrypoints.size, verifiedManifests: manifests, verifiedOutputs: outputs };
}

async function loadJson(repositoryRoot, relative) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relative), 'utf8'));
}

async function loadBundle(repositoryRoot) {
  const index = await loadJson(repositoryRoot, 'architecture/contexts/v1/context-index.json');
  return {
    decisions: await loadJson(repositoryRoot, 'architecture/contexts/v1/context-decisions.json'),
    inventory: await loadJson(repositoryRoot, 'architecture/evidence/v1/module-inventory.json'),
    dependencies: await loadJson(repositoryRoot, 'architecture/evidence/v1/dependency-graph.json'),
    writes: await loadJson(repositoryRoot, 'architecture/evidence/v1/write-sites.json'),
    ownership: await loadJson(repositoryRoot, 'architecture/evidence/v1/data-ownership-candidates.json'),
    index,
    manifests: await Promise.all(index.contexts.map((entry) => loadJson(repositoryRoot, entry.path))),
    foreignPlan: await loadJson(repositoryRoot, 'architecture/contexts/v1/foreign-write-migration-plan.json'),
    dependencyPlan: await loadJson(repositoryRoot, 'architecture/contexts/v1/dependency-transition-plan.json'),
    finalDependency: await loadJson(repositoryRoot, 'architecture/contexts/v1/final-dependency-current.json'),
    finalDependencySource: await loadJson(repositoryRoot, 'architecture/contexts/v1/final-dependency-source.json'),
    executableOwnershipDependencies: await loadJson(repositoryRoot, CURRENT_DEPENDENCY_PATH),
  };
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const bundle = await loadBundle(repositoryRoot);
  const shape = validateContexts(bundle);
  const hashes = await verifyContextIndex(bundle.index, repositoryRoot);
  const dependencyTruth = await verifyCurrentDependencyTruth(repositoryRoot, bundle.finalDependencySource, bundle.finalDependency);
  const executableOwnership = await verifyExecutablePathOwnership(repositoryRoot, bundle.manifests);
  process.stdout.write(`${JSON.stringify({ ok: true, ...shape, ...hashes, dependencyTruth, executableOwnership: { ...executableOwnership, records: undefined } })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
