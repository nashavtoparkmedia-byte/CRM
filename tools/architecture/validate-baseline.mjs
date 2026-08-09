import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REQUIRED_COMPONENTS = new Set([
  'gravity',
  'whatsapp_gravity',
  'telegram_gravity',
  'messages',
  'telegram_bot',
  'telegram_frontend',
  'personal_max',
  'max_scraper',
  'yfs_api',
  'yfs_worker',
  'audio_bridge',
  'freeswitch',
  'nginx',
  'ai_calls_dev',
  'streaming_stt_dev',
]);

const AUTHORITY = new Set([
  'AUTHORITATIVE_MODULE_SPECIFIC',
  'AUTHORITATIVE_PROVEN',
  'AUTHORITATIVE_DEV_CHECKPOINT',
  'DEPLOYED_ARTIFACT_AUTHORITY',
  'PROVEN_CONTENT_EQUIVALENT',
  'PROVEN_GIT_REVISION',
  'EXPERIMENTAL_CONFIRMED',
]);

const LIFECYCLE = new Set(['PRODUCTION', 'ACTIVE_DEVELOPMENT', 'EXPERIMENTAL']);
const SHA256 = /^[0-9a-f]{64}$/;
const PROHIBITED_KEY = /(password|passwd|access.?token|api.?key|private.?key|secret.?value)/i;
const TOP_LEVEL_KEYS = new Set([
  'schema',
  'milestone',
  'generated_at',
  'architecture_worktree',
  'evidence_inputs',
  'repositories',
  'dirty_states',
  'lifecycle_separation',
  'components',
  'invariants',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertNoSecretKeys(value, trail = '$') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretKeys(item, `${trail}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    assert(!PROHIBITED_KEY.test(key), `prohibited secret-like key at ${trail}.${key}`);
    assertNoSecretKeys(item, `${trail}.${key}`);
  }
}

export function validateBaseline(document) {
  assert(document?.schema === 'yoko.crm.authoritative-baseline.v1', 'schema mismatch');
  assert(document?.milestone === 'CRM-ARCH-001', 'milestone mismatch');
  assert(
    typeof document.generated_at === 'string' && !Number.isNaN(Date.parse(document.generated_at)),
    'generated_at must be an ISO date-time',
  );
  for (const key of Object.keys(document)) {
    assert(TOP_LEVEL_KEYS.has(key), `unexpected top-level property: ${key}`);
  }
  assert(Array.isArray(document.evidence_inputs) && document.evidence_inputs.length > 0, 'evidence inputs required');
  assert(Array.isArray(document.repositories) && document.repositories.length > 0, 'repositories required');
  assert(Array.isArray(document.dirty_states), 'dirty states required');
  assert(document.lifecycle_separation && typeof document.lifecycle_separation === 'object', 'lifecycle separation required');
  assert(Array.isArray(document.components), 'components required');
  assertNoSecretKeys(document);

  const evidenceIds = new Set();
  for (const evidence of document.evidence_inputs) {
    assert(typeof evidence.id === 'string' && evidence.id, 'evidence id required');
    assert(!evidenceIds.has(evidence.id), `duplicate evidence id: ${evidence.id}`);
    evidenceIds.add(evidence.id);
    assert(path.isAbsolute(evidence.path), `evidence path must be absolute: ${evidence.id}`);
    assert(SHA256.test(evidence.sha256), `invalid evidence sha256: ${evidence.id}`);
  }

  const repositoryIds = new Set();
  for (const repository of document.repositories) {
    assert(typeof repository.id === 'string' && repository.id, 'repository id required');
    assert(!repositoryIds.has(repository.id), `duplicate repository id: ${repository.id}`);
    repositoryIds.add(repository.id);
    assert(path.isAbsolute(repository.path), `repository path must be absolute: ${repository.id}`);
  }

  const dirtyStateIds = new Set();
  for (const state of document.dirty_states) {
    assert(typeof state.id === 'string' && state.id, 'dirty-state id required');
    assert(!dirtyStateIds.has(state.id), `duplicate dirty-state id: ${state.id}`);
    dirtyStateIds.add(state.id);
    assert(repositoryIds.has(state.repository), `unknown dirty-state repository: ${state.id}`);
    for (const key of ['evidence', 'file_hash_evidence', 'git_blob_evidence']) {
      if (state[key] !== undefined) {
        assert(evidenceIds.has(state[key]), `unknown ${key}: ${state.id}`);
      }
    }
  }

  const ids = new Set();
  for (const component of document.components) {
    assert(typeof component.id === 'string' && component.id, 'component id required');
    assert(!ids.has(component.id), `duplicate component id: ${component.id}`);
    ids.add(component.id);
    assert(Array.isArray(component.module_roots) && component.module_roots.length > 0, `module roots required: ${component.id}`);
    assert(Array.isArray(component.source_authority) && component.source_authority.length > 0, `source authority required: ${component.id}`);
    assert(component.runtime && typeof component.runtime.state === 'string', `runtime state required: ${component.id}`);
    assert(AUTHORITY.has(component.authority_status), `invalid authority status: ${component.id}`);
    assert(LIFECYCLE.has(component.lifecycle), `invalid lifecycle: ${component.id}`);
    assert(typeof component.protected === 'boolean', `protected flag required: ${component.id}`);
    assert(Array.isArray(component.evidence) && component.evidence.length > 0, `component evidence required: ${component.id}`);
    for (const evidenceId of component.evidence) {
      assert(evidenceIds.has(evidenceId), `unknown component evidence: ${component.id}/${evidenceId}`);
    }
    if (component.lifecycle === 'PRODUCTION') {
      assert(component.protected === true, `production component must be protected: ${component.id}`);
    }
  }

  for (const required of REQUIRED_COMPONENTS) {
    assert(ids.has(required), `missing required component: ${required}`);
  }
  for (const category of [
    'observed_production',
    'accepted_source_authority',
    'experimental_development',
    'rejected_branches',
    'historical_only',
    'uncommitted_preserved_deltas',
    'unresolved_lifecycle_classifications',
  ]) {
    assert(Array.isArray(document.lifecycle_separation[category]), `lifecycle category required: ${category}`);
  }
  assert(
    typeof document.lifecycle_separation.rejected_branch_note === 'string'
      && document.lifecycle_separation.rejected_branch_note.length > 0,
    'rejected branch classification note required',
  );
  assert(document.invariants?.single_repository_authority_forced === false, 'must not force one repository authority');
  assert(document.invariants?.production_only_source_preserved === true, 'production-only source must be preserved');
  assert(document.invariants?.production_mutated === false, 'baseline must not mutate production');
  return { components: document.components.length, evidenceInputs: document.evidence_inputs.length };
}

export async function verifyEvidence(document) {
  for (const evidence of document.evidence_inputs) {
    const bytes = await readFile(evidence.path);
    const actual = createHash('sha256').update(bytes).digest('hex');
    assert(actual === evidence.sha256, `evidence hash mismatch: ${evidence.id}`);
  }
  return { verifiedEvidenceInputs: document.evidence_inputs.length };
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const baselinePath = path.join(repoRoot, 'architecture/baseline/v1/authoritative-baseline.json');
  const document = JSON.parse(await readFile(baselinePath, 'utf8'));
  const shape = validateBaseline(document);
  const evidence = await verifyEvidence(document);
  process.stdout.write(`${JSON.stringify({ ok: true, ...shape, ...evidence })}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
