#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { gitChangedPaths } from './git-change-set.mjs'

const DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error TS\d+:/u

export function evaluateTypeScriptBaseline(output, changedPaths, maximum = 30) {
  const diagnostics = output.split(/\r?\n/u).map((line) => {
    const match = DIAGNOSTIC.exec(line)
    return match ? { file: match[1].replaceAll('\\', '/'), line } : null
  }).filter(Boolean)
  assert(diagnostics.length <= maximum, `TypeScript diagnostic baseline grew: ${diagnostics.length} > ${maximum}`)
  const normalizedChanged = new Set(changedPaths.map((entry) => (
    entry.replace(/^gravity-mvp\//u, '').replaceAll('\\', '/')
  )))
  const changedDiagnostics = diagnostics.filter((diagnostic) => normalizedChanged.has(diagnostic.file))
  assert.deepEqual(changedDiagnostics, [], 'changed path retains or introduces a TypeScript diagnostic')
  return { status: 'PASS', diagnostics: diagnostics.length, maximum, changed_path_diagnostics: 0 }
}

function main() {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
  const result = spawnSync('npx', ['tsc', '--noEmit', '--pretty', 'false'], {
    cwd: path.join(root, 'gravity-mvp'),
    encoding: 'utf8',
    env: process.env,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const maximum = Number(process.env.YOKO_TYPESCRIPT_BASELINE_MAX ?? 30)
  process.stdout.write(`${JSON.stringify(evaluateTypeScriptBaseline(output, gitChangedPaths(root), maximum), null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  }
}
