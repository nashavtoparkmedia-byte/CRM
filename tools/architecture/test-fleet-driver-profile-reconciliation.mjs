import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const out = mkdtempSync(path.join(tmpdir(), 'yoko-driver-profile-'))
const sources = [
  'gravity-mvp/src/contracts/fleet-operations/v1/reconcile-driver-profile-command.ts',
  'gravity-mvp/src/modules/fleet-operations/public/v1/reconcile-driver-profile-handler.ts',
].map(file => path.join(root, file))
const compile = spawnSync(process.execPath, [path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc'), '--target', 'ES2022', '--module', 'commonjs', '--moduleResolution', 'node', '--strict', '--skipLibCheck', '--rootDir', path.join(root, 'gravity-mvp/src'), '--outDir', out, ...sources], { encoding: 'utf8' })
if (compile.status !== 0) { process.stderr.write(compile.stdout + compile.stderr); process.exit(1) }

try {
  const require = createRequire(import.meta.url)
  const contract = require(path.join(out, 'contracts/fleet-operations/v1/reconcile-driver-profile-command.js'))
  const { createReconcileDriverProfileHandlerV1 } = require(path.join(out, 'modules/fleet-operations/public/v1/reconcile-driver-profile-handler.js'))
  const calls = []
  const handler = createReconcileDriverProfileHandlerV1({ async reconcile(input) { calls.push(input) } })
  const lastOrderAt = new Date('2026-08-01T00:00:00Z')
  const result = await handler({ contract: contract.RECONCILE_DRIVER_PROFILE_COMMAND_V1, yandexDriverId: 'driver-1', fullName: 'Иван Иванов', lastOrderAt })
  assert.deepEqual(calls, [{ yandexDriverId: 'driver-1', fullName: 'Иван Иванов', lastOrderAt }])
  assert.deepEqual(result, { contract: contract.RECONCILE_DRIVER_PROFILE_RESULT_V1, reconciled: true })
  await assert.rejects(handler({ contract: contract.RECONCILE_DRIVER_PROFILE_COMMAND_V1, yandexDriverId: 'driver-1', fullName: 'Иван', lastOrderAt, segment: 'vip' }), /unsupported field/)
  const script = readFileSync(path.join(root, 'gravity-mvp/scripts/sync-drivers-activity.ts'), 'utf8')
  assert.doesNotMatch(script, /prisma\.driver\.(?:create|update|upsert|delete)/)
  assert.match(script, /reconcileDriverProfileV1/)
  const adapter = readFileSync(path.join(root, 'gravity-mvp/src/modules/fleet-operations/public/v1/legacy-prisma-reconcile-driver-profile-adapter.ts'), 'utf8')
  assert.match(adapter, /prisma\.driver\.upsert/)
  assert.doesNotMatch(adapter, /prisma\.(?!driver\b)[A-Za-z_][A-Za-z0-9_]*\.(?:create|update|upsert|delete)/)
  process.stdout.write('fleet driver profile reconciliation: PASS\n')
} finally {
  rmSync(out, { recursive: true, force: true })
}
