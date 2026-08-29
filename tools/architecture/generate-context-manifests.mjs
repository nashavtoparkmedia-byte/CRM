import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const indexRelative = 'architecture/contexts/v1/context-index.json';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function requireInjectedBytes(authority, field) {
  assert(Buffer.isBuffer(authority?.[field]), `context binding materialization requires injected ${field}`);
  return authority[field];
}

async function verifyPreservedContextManifests(index) {
  assert(Array.isArray(index.contexts) && index.contexts.length > 0, 'context index must declare preserved context manifests');
  for (const entry of index.contexts) {
    assert(typeof entry.context === 'string' && entry.context.length > 0, 'context index entry identity is required');
    assert(typeof entry.path === 'string' && entry.path.startsWith('architecture/contexts/v1/manifests/'), `invalid context manifest path for ${entry.context}`);
    const bytes = await readFile(path.join(repositoryRoot, entry.path));
    const manifest = JSON.parse(bytes);
    assert(manifest.context?.id === entry.context, `context manifest identity drift: ${entry.context}`);
    assert(sha256(bytes) === entry.sha256, `context manifest hash drift: ${entry.context}`);
  }
}

function refreshBinding(container, key, bytes) {
  assert(typeof container?.[key]?.path === 'string', `context index binding missing: ${key}`);
  container[key] = { ...container[key], sha256: sha256(bytes) };
}

// Pure injected-data helper: it never reads authority documents or knows their raw paths.
// Existing context semantics are verified byte-for-byte and are never regenerated here.
export async function generateContextManifestsFromAuthority(authority) {
  const coverageBytes = requireInjectedBytes(authority, 'currentCoverageBytes');
  const dependenciesBytes = requireInjectedBytes(authority, 'currentDependenciesBytes');
  const validatorBytes = requireInjectedBytes(authority, 'validatorBytes');
  const generatorBytes = await readFile(fileURLToPath(import.meta.url));
  const indexPath = path.join(repositoryRoot, indexRelative);
  const index = JSON.parse(await readFile(indexPath, 'utf8'));

  assert(index.schema === 'yoko.crm.context-index.v1' && index.version === 1, 'unsupported context index identity');
  await verifyPreservedContextManifests(index);

  refreshBinding(index.controls, 'generator', generatorBytes);
  refreshBinding(index.controls, 'executable_path_ownership_validator', validatorBytes);
  refreshBinding(index.outputs, 'executable_path_ownership_coverage', coverageBytes);
  refreshBinding(index.outputs, 'executable_path_ownership_current_dependencies', dependenciesBytes);

  await writeFile(indexPath, `${JSON.stringify(stable(index), null, 2)}\n`);
  return {
    ok: true,
    authority_bindings_materialized: 4,
    contexts: index.contexts.length,
    context_manifests_preserved: true,
  };
}

function main() {
  const validator = path.join(repositoryRoot, 'tools/architecture/validate-executable-path-ownership.mjs');
  const result = spawnSync(process.execPath, [validator, '--generate-contexts'], {
    cwd: repositoryRoot,
    encoding: 'utf8',
    stdio: 'inherit',
  });
  if (result.status !== 0) process.exitCode = result.status ?? 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
