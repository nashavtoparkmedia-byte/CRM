import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const contextsRoot = path.join(repositoryRoot, 'architecture/contexts/v1');
const manifestsRoot = path.join(contextsRoot, 'manifests');

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function uniqueSorted(values) {
  return [...new Set(values)].sort();
}

async function loadJson(relative) {
  const bytes = await readFile(path.join(repositoryRoot, relative));
  return { bytes, document: JSON.parse(bytes) };
}

async function writeJson(absolute, value) {
  const bytes = `${JSON.stringify(stable(value), null, 2)}\n`;
  await writeFile(absolute, bytes);
  return Buffer.from(bytes);
}

function siteId(site) {
  return `write_${sha256(JSON.stringify(stable(site))).slice(0, 20)}`;
}

function planStrategy(classifications, ownerContexts, callerContext) {
  if (ownerContexts.length === 1 && ownerContexts[0] === callerContext) {
    return {
      adapter: 'context-internal owner service behind the existing call shape',
      enforcement: 'block direct cross-module Prisma writes after internal callers switch',
      migration: 'introduce internal owner operation; preserve response semantics; switch bounded sites; remove direct Prisma access',
      target_surface: `${callerContext}.internal`,
    };
  }
  if (classifications.includes('SHARED_AMBIGUOUS')) {
    return {
      adapter: 'typed compatibility operation around the current raw SQL call',
      enforcement: 'block reintroduction only after exact table scopes are split and owner commands are live',
      migration: 'identify/split table scope; introduce one owner command per context; dual-verify; switch caller; retire raw path',
      target_surface: ownerContexts.includes('unresolved_raw_scope') ? 'owner scope must be made explicit first' : ownerContexts.map((context) => `${context}.public`).join(', '),
    };
  }
  if (classifications.includes('LEGACY')) {
    return {
      adapter: 'freeze existing legacy behavior behind a compatibility adapter',
      enforcement: 'deny new legacy writes immediately; remove adapter after parity verification',
      migration: 'characterize fixtures; introduce owner command; dual-verify; switch; retire legacy path',
      target_surface: ownerContexts.map((context) => `${context}.public`).join(', '),
    };
  }
  return {
    adapter: 'owner-context command invoked through a compatibility facade',
    enforcement: 'add boundary rule after all listed sites switch',
    migration: 'add command; preserve response semantics; dual-write or shadow-compare where safe; switch bounded sites; remove direct Prisma access',
    target_surface: ownerContexts.map((context) => `${context}.public`).join(', '),
  };
}

async function main() {
  const decisionsRelative = 'architecture/contexts/v1/context-decisions.json';
  const evidenceRelatives = {
    inventory: 'architecture/evidence/v1/module-inventory.json',
    dependencies: 'architecture/evidence/v1/dependency-graph.json',
    writes: 'architecture/evidence/v1/write-sites.json',
    ownership: 'architecture/evidence/v1/data-ownership-candidates.json',
    credentials: 'architecture/evidence/v1/credential-access.json',
  };
  const overridesRelative = 'architecture/contexts/v1/raw-write-owner-overrides.json';
  const [decisionsInput, inventoryInput, dependencyInput, writesInput, ownershipInput, credentialInput, overridesInput, generatorBytes, finalDependencyBytes, finalDependencySourceBytes, existingIndexInput, executableCoverageBytes, executableOwnershipDependencyBytes, executableOwnershipValidatorBytes, finalDependencyDeriverBytes] = await Promise.all([
    loadJson(decisionsRelative),
    loadJson(evidenceRelatives.inventory),
    loadJson(evidenceRelatives.dependencies),
    loadJson(evidenceRelatives.writes),
    loadJson(evidenceRelatives.ownership),
    loadJson(evidenceRelatives.credentials),
    loadJson(overridesRelative),
    readFile(fileURLToPath(import.meta.url)),
    readFile(path.join(repositoryRoot, 'architecture/contexts/v1/final-dependency-current.json')),
    readFile(path.join(repositoryRoot, 'architecture/contexts/v1/final-dependency-source.json')),
    loadJson('architecture/contexts/v1/context-index.json'),
    readFile(path.join(repositoryRoot, 'architecture/contexts/v1/executable-path-ownership-coverage.json')),
    readFile(path.join(repositoryRoot, 'architecture/contexts/v1/executable-path-ownership-current-dependencies.json')),
    readFile(path.join(repositoryRoot, 'tools/architecture/validate-executable-path-ownership.mjs')),
    readFile(path.join(repositoryRoot, 'tools/architecture/derive-final-dependency-source.mjs')),
  ]);
  const decisions = decisionsInput.document;
  const inventory = inventoryInput.document;
  const dependencies = dependencyInput.document;
  const writes = writesInput.document;
  const ownership = ownershipInput.document;
  const credentials = credentialInput.document;
  const overrides = overridesInput.document;

  const contextById = new Map(decisions.contexts.map((context) => [context.id, context]));
  const contextByModule = new Map();
  for (const context of decisions.contexts) for (const module of context.technical_modules) contextByModule.set(module, context.id);

  const ownershipContext = (ownerModule) => contextByModule.get(ownerModule) ?? 'unresolved_raw_scope';
  const rawOverrideBySite = new Map();
  for (const rule of overrides.rules) for (const line of rule.lines) rawOverrideBySite.set(`${rule.file}:${line}`, rule);
  const ownershipBySchemaModel = new Map();
  for (const model of ownership.models) ownershipBySchemaModel.set(`${model.schema}:${model.model}`, model);

  const migrationSites = writes.write_sites.filter((site) => site.classification !== 'OWNER');
  const planGroups = new Map();
  for (const site of migrationSites) {
    const rawOverride = rawOverrideBySite.get(`${site.file}:${site.line}`);
    const models = rawOverride?.models ?? (site.model ? [site.model] : (site.models?.length ? site.models : ['dynamic_raw_scope']));
    const ownerModules = site.owner_candidate
      ? [site.owner_candidate]
      : (site.owner_candidates?.length ? site.owner_candidates : ['UNRESOLVED']);
    const ownerContexts = rawOverride?.owner_contexts ?? uniqueSorted(ownerModules.map(ownershipContext));
    const callerContext = contextByModule.get(site.module) ?? 'unresolved_caller';
    const key = JSON.stringify([callerContext, ownerContexts, models, site.classification]);
    const current = planGroups.get(key) ?? {
      caller_context: callerContext,
      caller_modules: new Set(),
      classifications: new Set(),
      models: new Set(),
      owner_contexts: new Set(),
      sites: [],
    };
    current.caller_modules.add(site.module);
    current.classifications.add(site.classification);
    models.forEach((model) => current.models.add(model));
    ownerContexts.forEach((context) => current.owner_contexts.add(context));
    current.sites.push({
      classification: site.classification,
      file: site.file,
      id: siteId(site),
      line: site.line,
      method: site.method,
      module: site.module,
      role: site.role,
      schema: site.schema,
    });
    planGroups.set(key, current);
  }
  const plans = [...planGroups.values()].map((group) => {
    const callerModules = [...group.caller_modules].sort();
    const classifications = [...group.classifications].sort();
    const models = [...group.models].sort();
    const ownerContexts = [...group.owner_contexts].sort();
    const idSeed = [group.caller_context, ...ownerContexts, ...models, ...classifications].join('|');
    return {
      caller_context: group.caller_context,
      caller_modules: callerModules,
      classifications,
      id: `migration_${sha256(idSeed).slice(0, 16)}`,
      models,
      owner_contexts: ownerContexts,
      recovery: 'compatibility facade remains available until site-level parity and owner-side persistence are verified',
      site_count: group.sites.length,
      sites: group.sites.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.method.localeCompare(b.method)),
      strategy: planStrategy(classifications, ownerContexts, group.caller_context),
      verification: ['existing behavior contract tests', 'owner command integration tests', 'site-level parity evidence', 'no direct foreign Prisma write after switch'],
    };
  }).sort((a, b) => a.id.localeCompare(b.id));

  const dependencyRelationships = [];
  for (const edge of dependencies.module_edges) {
    const sourceContext = contextByModule.get(edge.source);
    const targetContext = contextByModule.get(edge.target);
    if (!sourceContext || !targetContext || sourceContext === targetContext) continue;
    const allowed = contextById.get(sourceContext).allowed_dependencies.includes(targetContext);
    dependencyRelationships.push({
      allowed_target: allowed,
      current_import_count: edge.count,
      source_context: sourceContext,
      source_module: edge.source,
      target_context: targetContext,
      target_module: edge.target,
      transition: allowed
        ? 'route through target public surface; current direct imports are compatibility debt until migrated'
        : 'replace with owner command/query or move orchestration; then prohibit direct import',
    });
  }
  dependencyRelationships.sort((a, b) => a.source_context.localeCompare(b.source_context) || a.target_context.localeCompare(b.target_context) || a.source_module.localeCompare(b.source_module));

  await rm(manifestsRoot, { recursive: true, force: true });
  await mkdir(manifestsRoot, { recursive: true });
  const manifestIndex = [];
  for (const context of decisions.contexts) {
    const ownedData = ownership.models.filter((model) => context.technical_modules.includes(model.owner_candidate)).map((model) => ({
      current_writer_modules: model.writer_modules,
      id: model.id,
      mapped_table: model.mapped_table,
      model: model.model,
      schema: model.schema,
    })).sort((a, b) => a.id.localeCompare(b.id));
    const contextCredentials = credentials.environment_access.filter((entry) => context.technical_modules.includes(entry.module));
    const dbCredentialAccess = credentials.database_credential_model_access.filter((entry) => context.technical_modules.includes(entry.module));
    const manifest = {
      allowed_dependencies: context.allowed_dependencies.map((id) => ({ context: id, surface: `${id}.public` })),
      commands: context.commands,
      compatibility_strategy: context.compatibility_strategy,
      context: { id: context.id, name: context.name },
      credential_relationships: {
        database_models: uniqueSorted(dbCredentialAccess.flatMap((entry) => entry.model ? [entry.model] : (entry.models ?? []))),
        environment_names: uniqueSorted(contextCredentials.map((entry) => entry.name)),
        policy: 'Names and access locations only. Values stay inside the owning adapter and never cross a public contract.',
      },
      events: context.events,
      evidence: {
        dependency_edges: dependencyRelationships.filter((edge) => edge.source_context === context.id).length,
        source_snapshot_sha256: inventory.source_snapshot_sha256,
        write_sites_requiring_migration: plans.filter((plan) => plan.caller_context === context.id).reduce((sum, plan) => sum + plan.site_count, 0),
      },
      forbidden_dependencies: uniqueSorted([...decisions.global_forbidden_dependencies, ...context.forbidden_dependencies]),
      foreign_write_migration_plans: plans.filter((plan) => plan.caller_context === context.id || plan.owner_contexts.includes(context.id)).map((plan) => plan.id),
      internal_surface: context.internal_surface,
      owned_data: ownedData,
      protected: context.protected,
      provider_relationships: context.providers,
      public_surface: context.public_surface,
      responsibility: context.responsibility,
      schema: 'yoko.crm.module-manifest.v1',
      technical_modules: context.technical_modules,
      version: 1,
    };
    const relative = `architecture/contexts/v1/manifests/${context.id}.json`;
    const bytes = await writeJson(path.join(repositoryRoot, relative), manifest);
    manifestIndex.push({ context: context.id, path: relative, sha256: sha256(bytes) });
  }

  const foreignPlanBytes = await writeJson(path.join(contextsRoot, 'foreign-write-migration-plan.json'), {
    coverage: {
      classifications: Object.fromEntries(['FOREIGN', 'LEGACY', 'SHARED_AMBIGUOUS'].map((classification) => [classification, migrationSites.filter((site) => site.classification === classification).length])),
      covered_site_ids: uniqueSorted(plans.flatMap((plan) => plan.sites.map((site) => site.id))),
      plans: plans.length,
      sites_requiring_migration: migrationSites.length,
    },
    plans,
    schema: 'yoko.crm.foreign-write-migration-plan.v1',
    version: 1,
  });
  const dependencyPlanBytes = await writeJson(path.join(contextsRoot, 'dependency-transition-plan.json'), {
    current_relationships: dependencyRelationships,
    schema: 'yoko.crm.dependency-transition-plan.v1',
    summary: {
      allowed_but_requires_public_surface: dependencyRelationships.filter((edge) => edge.allowed_target).length,
      currently_forbidden: dependencyRelationships.filter((edge) => !edge.allowed_target).length,
      relationships: dependencyRelationships.length,
    },
    version: 1,
  });

  const controls = {
    ...existingIndexInput.document.controls,
    context_decisions: { path: decisionsRelative, sha256: sha256(decisionsInput.bytes) },
    credential_access: { path: evidenceRelatives.credentials, sha256: sha256(credentialInput.bytes) },
    dependency_graph: { path: evidenceRelatives.dependencies, sha256: sha256(dependencyInput.bytes) },
    generator: { path: 'tools/architecture/generate-context-manifests.mjs', sha256: sha256(generatorBytes) },
    executable_path_ownership_validator: { path: 'tools/architecture/validate-executable-path-ownership.mjs', sha256: sha256(executableOwnershipValidatorBytes) },
    final_dependency_source_deriver: { path: 'tools/architecture/derive-final-dependency-source.mjs', sha256: sha256(finalDependencyDeriverBytes) },
    module_inventory: { path: evidenceRelatives.inventory, sha256: sha256(inventoryInput.bytes) },
    ownership_candidates: { path: evidenceRelatives.ownership, sha256: sha256(ownershipInput.bytes) },
    raw_write_owner_overrides: { path: overridesRelative, sha256: sha256(overridesInput.bytes) },
    write_sites: { path: evidenceRelatives.writes, sha256: sha256(writesInput.bytes) },
  };
  await writeJson(path.join(contextsRoot, 'context-index.json'), {
    contexts: manifestIndex.sort((a, b) => a.context.localeCompare(b.context)),
    controls,
    generated_from: 'CRM-ARCH-002 PASS_CONTINUE',
    outputs: {
      ...existingIndexInput.document.outputs,
      dependency_transition_plan: { path: 'architecture/contexts/v1/dependency-transition-plan.json', sha256: sha256(dependencyPlanBytes) },
      final_dependency_current: { path: 'architecture/contexts/v1/final-dependency-current.json', sha256: sha256(finalDependencyBytes) },
      final_dependency_source: { path: 'architecture/contexts/v1/final-dependency-source.json', sha256: sha256(finalDependencySourceBytes) },
      executable_path_ownership_current_dependencies: { path: 'architecture/contexts/v1/executable-path-ownership-current-dependencies.json', sha256: sha256(executableOwnershipDependencyBytes) },
      executable_path_ownership_coverage: { path: 'architecture/contexts/v1/executable-path-ownership-coverage.json', sha256: sha256(executableCoverageBytes) },
      foreign_write_migration_plan: { path: 'architecture/contexts/v1/foreign-write-migration-plan.json', sha256: sha256(foreignPlanBytes) },
    },
    schema: 'yoko.crm.context-index.v1',
    version: 1,
  });
  process.stdout.write(`${JSON.stringify({
    ok: true,
    contexts: decisions.contexts.length,
    dependencyRelationships: dependencyRelationships.length,
    manifests: manifestIndex.length,
    migrationPlans: plans.length,
    migrationSites: migrationSites.length,
    ownedData: ownership.models.length,
    technicalModules: inventory.modules.length,
  })}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
