#!/usr/bin/env node
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const root = process.cwd()
const source = path.join(root, 'architecture/recovery/whole-project-dod/v2/protected-messages-reconciliation-v1/registry.json')
const temp = mkdtempSync(path.join(tmpdir(), 'yoko-protected-messages-negative-'))
try {
  const registry = JSON.parse(readFileSync(source, 'utf8'))
  registry.records[0].classifications = ['UNKNOWN']
  const probe = path.join(temp, 'registry.json')
  writeFileSync(probe, `${JSON.stringify(registry, null, 2)}\n`)
  const result = spawnSync(process.execPath, ['tools/architecture/check-protected-messages-reconciliation.mjs'], {
    cwd: root,
    env: { ...process.env, PROTECTED_MESSAGES_REGISTRY: probe },
    encoding: 'utf8',
  })
  if (result.status === 0 || !result.stdout.includes('UNKNOWN may not pass reconciliation')) {
    process.stderr.write(result.stdout || result.stderr)
    process.exitCode = 1
  } else {
    process.stdout.write(`${JSON.stringify({ status: 'PASS', negative_unknown_probe: 'REJECTED' }, null, 2)}\n`)
  }
} finally {
  rmSync(temp, { recursive: true, force: true })
}
