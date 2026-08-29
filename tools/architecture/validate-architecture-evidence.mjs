import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REQUIRED_MODULES = new Set([
  'ai_calls', 'ai_knowledge', 'analytics', 'audio_bridge', 'avito', 'avito_worker',
  'calls', 'contacts', 'drivers', 'gravity_core', 'gravity_ui', 'leads',
  'max_provider', 'max_scraper', 'messages', 'monitoring', 'nginx', 'settings',
  'tasks', 'telegram_bot', 'telegram_frontend', 'telegram_provider',
  'telephony_config', 'users', 'whatsapp_provider', 'yandex_fleet', 'yfs',
]);
const REQUIRED_PROVIDERS = new Set(['telegram', 'max', 'whatsapp', 'yandex_fleet', 'avito', 'freeswitch', 'openai', 'anthropic', 'aws_s3']);
const WRITE_CLASSIFICATIONS = new Set(['OWNER', 'FOREIGN', 'LEGACY', 'SHARED_AMBIGUOUS']);
const SHA256 = /^[0-9a-f]{64}$/;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function assertNoCredentialValues(value, trail = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoCredentialValues(item, `${trail}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert(!['value', 'secret', 'password', 'token'].includes(key.toLowerCase()), `credential value field forbidden at ${trail}.${key}`);
    assertNoCredentialValues(item, `${trail}.${key}`);
  }
}

export function validateEvidence(bundle) {
  const { inventory, dependencies, writes, ownership, providers, credentials, runtime, hotspots, manifest } = bundle;
  const documents = [inventory, dependencies, writes, ownership, providers, credentials, runtime, hotspots, manifest];
  const snapshots = new Set(documents.map((document) => document.source_snapshot_sha256));
  assert(snapshots.size === 1 && SHA256.test([...snapshots][0]), 'source snapshot mismatch');
  assert(documents.every((document) => document.baseline_milestone === 'CRM-ARCH-001'), 'baseline milestone mismatch');

  const moduleIds = new Set(inventory.modules.map((module) => module.id));
  assert(moduleIds.size === inventory.modules.length, 'duplicate module id');
  for (const required of REQUIRED_MODULES) assert(moduleIds.has(required), `missing module: ${required}`);
  assert(inventory.totals.files === manifest.totals.files, 'inventory/manifest file count mismatch');
  assert(inventory.totals.files === manifest.input_files.length, 'input manifest incomplete');
  assert(inventory.modules.every((module) => module.files > 0 && module.lines > 0), 'empty module inventory entry');

  assert(dependencies.totals.direct_imports === dependencies.direct_imports.length, 'direct import total mismatch');
  assert(dependencies.totals.unresolved_internal_imports === 0, 'unresolved internal imports remain');
  assert(dependencies.direct_imports.every((entry) => moduleIds.has(entry.module) && entry.line > 0), 'invalid direct import record');
  assert(dependencies.module_edges.every((edge) => moduleIds.has(edge.source) && moduleIds.has(edge.target) && edge.count > 0), 'invalid module edge');
  assert(Array.isArray(dependencies.circular_dependencies.file_components), 'file cycles missing');
  assert(Array.isArray(dependencies.circular_dependencies.module_components), 'module cycles missing');

  const classified = new Set(writes.write_sites.map((site) => site.classification));
  for (const classification of WRITE_CLASSIFICATIONS) assert(classified.has(classification), `missing write classification: ${classification}`);
  assert(writes.totals.prisma_write_sites === writes.write_sites.length, 'write-site total mismatch');
  assert(writes.totals.prisma_read_sites === writes.read_sites.length, 'read-site total mismatch');
  assert(writes.write_sites.every((site) => site.file && site.module && site.schema && site.line > 0), 'incomplete write-site record');

  const modelIds = new Set(ownership.models.map((model) => model.id));
  assert(modelIds.size === ownership.models.length, 'schema-scoped model id collision');
  assert(ownership.totals.unresolved_owners === 0, 'unresolved data owner candidates remain');
  assert(ownership.models.every((model) => model.owner_candidate && model.schema), 'incomplete ownership candidate');

  const providerIds = new Set(providers.providers.map((provider) => provider.provider));
  for (const provider of REQUIRED_PROVIDERS) assert(providerIds.has(provider), `missing provider: ${provider}`);
  assert(providers.providers.every((provider) => provider.files.length > 0 && provider.modules.length > 0), 'empty provider dependency');

  assertNoCredentialValues(credentials);
  assert(credentials.safety.includes('values are never read or emitted'), 'credential safety declaration missing');
  assert(credentials.environment_access.every((entry) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(entry.name) && !Object.hasOwn(entry, 'value')), 'invalid environment access record');

  assert(runtime.api_route_relationships.length === runtime.totals.api_routes && runtime.totals.api_routes > 0, 'API route map incomplete');
  assert(runtime.background_interactions.length === runtime.totals.background_interactions && runtime.totals.background_interactions > 0, 'background map incomplete');
  assert(runtime.queue_topology.length === runtime.totals.queues && runtime.queue_topology.length > 0, 'queue topology incomplete');
  assert(runtime.queue_topology.every((queue) => queue.name && queue.declarations.length > 0 && queue.consumers.length > 0 && queue.producers.length > 0), 'queue producer/consumer relationship incomplete');
  assert(runtime.critical_runtime_coupling.length === runtime.totals.critical_runtime_couplings, 'runtime coupling total mismatch');

  assert(hotspots.shared_utility_hotspots.length === hotspots.totals.shared_utility_hotspots, 'utility hotspot total mismatch');
  assert(hotspots.shared_data_hotspots.length === hotspots.totals.shared_data_hotspots, 'data hotspot total mismatch');
  assert(hotspots.shared_utility_hotspots.length > 0 && hotspots.shared_data_hotspots.length > 0, 'hotspot map empty');
  return {
    files: inventory.totals.files,
    modules: inventory.totals.modules,
    prismaWrites: writes.totals.prisma_write_sites,
    queues: runtime.totals.queues,
    sourceSnapshotSha256: [...snapshots][0],
  };
}

export async function verifyManifestInputs(manifest, repositoryRoot) {
  const ledger = [];
  for (const input of manifest.input_files) {
    const bytes = await readFile(path.join(repositoryRoot, input.file));
    assert(bytes.length === input.bytes, `input byte count mismatch: ${input.file}`);
    assert(digest(bytes) === input.sha256, `input hash mismatch: ${input.file}`);
    ledger.push(`${input.sha256}  ${input.file}\n`);
  }
  assert(digest(ledger.join('')) === manifest.source_snapshot_sha256, 'source snapshot digest mismatch');
  for (const input of Object.values(manifest.inputs)) {
    const bytes = await readFile(path.join(repositoryRoot, input.path));
    assert(digest(bytes) === input.sha256, `control input hash mismatch: ${input.path}`);
  }
  return { verifiedInputFiles: manifest.input_files.length, verifiedControlInputs: Object.keys(manifest.inputs).length };
}

async function loadBundle(repositoryRoot) {
  const evidenceRoot = path.join(repositoryRoot, 'architecture/evidence/v1');
  const names = {
    inventory: 'module-inventory.json', dependencies: 'dependency-graph.json', writes: 'write-sites.json',
    ownership: 'data-ownership-candidates.json', providers: 'provider-dependencies.json', credentials: 'credential-access.json',
    runtime: 'runtime-interactions.json', hotspots: 'shared-hotspots.json', manifest: 'analysis-manifest.json',
  };
  return Object.fromEntries(await Promise.all(Object.entries(names).map(async ([key, name]) => [key, JSON.parse(await readFile(path.join(evidenceRoot, name), 'utf8'))])));
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const bundle = await loadBundle(repositoryRoot);
  const shape = validateEvidence(bundle);
  const inputs = await verifyManifestInputs(bundle.manifest, repositoryRoot);
  process.stdout.write(`${JSON.stringify({ ok: true, ...shape, ...inputs })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
