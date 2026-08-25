#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const runtime = path.join(
  root,
  'architecture/recovery/control-plane/v2/owner-bootstrap/crm-external-rereview-source-only-v10',
)
const temporary = mkdtempSync(path.join(tmpdir(), 'yoko-runtime-v10-ci-'))
try {
  const copy = spawnSync('/usr/bin/cp', ['-a', `${runtime}/.`, temporary], {
    encoding: 'utf8', stdio: 'inherit',
  })
  if (copy.status !== 0) process.exit(copy.status ?? 1)
  const result = spawnSync('/usr/bin/python3', [
    '-I', '-B', '-m', 'unittest', 'discover', '-s', path.join(temporary, 'tests'), '-v',
  ], {
    // The copied Runtime source remains outside Git, so the repository-aware
    // sealer fixture must discover this exact checkout via its portable cwd.
    cwd: root,
    encoding: 'utf8',
    stdio: 'inherit',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  })
  if (result.status !== 0) process.exit(result.status ?? 1)
  process.stdout.write('source-only Runtime v10 contract: PASS\n')
} finally {
  await rm(temporary, { recursive: true, force: true })
}
