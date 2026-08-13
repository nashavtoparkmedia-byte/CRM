#!/usr/bin/env node

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { gitChangedPaths } from './git-change-set.mjs'

const DIAGNOSTIC = /^(.+?)\(\d+,\d+\): error TS\d+:/u
export const TYPESCRIPT_BASELINE_MAXIMUM = 30

export function authoritativeTypeScriptMaximum(environment = process.env) {
  assert.equal(
    environment.YOKO_TYPESCRIPT_BASELINE_MAX,
    undefined,
    'YOKO_TYPESCRIPT_BASELINE_MAX cannot override the authoritative threshold',
  )
  return TYPESCRIPT_BASELINE_MAXIMUM
}

export function evaluateTypeScriptBaseline(output, changedPaths, maximum = TYPESCRIPT_BASELINE_MAXIMUM, execution = { status: 1, signal: null, error: null }) {
  assert.equal(execution?.error ?? null, null, 'TypeScript compiler failed to start')
  assert.equal(execution?.signal ?? null, null, 'TypeScript compiler was terminated by a signal')
  assert.equal(
    execution?.status === 0 || execution?.status === 1,
    true,
    `TypeScript compiler returned an unexpected exit status: ${String(execution?.status)}`,
  )
  const nonblankLines = output.split(/\r?\n/u).filter((line) => line.trim().length > 0)
  const diagnostics = nonblankLines.map((line) => {
    const match = DIAGNOSTIC.exec(line)
    return match ? { file: match[1].replaceAll('\\', '/'), line } : null
  }).filter(Boolean)
  const unparsedCompilerErrors = nonblankLines.filter((line) => (
    /(?:^|:\s)error TS\d+:/u.test(line) && !DIAGNOSTIC.test(line)
  ))
  assert.deepEqual(unparsedCompilerErrors, [], 'TypeScript compiler emitted an unparsed global diagnostic')
  if (execution.status === 1) {
    assert.equal(diagnostics.length > 0, true, 'TypeScript compiler failed without a recognized diagnostic')
  }
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
  const compiler = path.join(root, 'gravity-mvp/node_modules/typescript/bin/tsc')
  const result = spawnSync(process.execPath, [compiler, '--noEmit', '--pretty', 'false'], {
    cwd: path.join(root, 'gravity-mvp'),
    encoding: 'utf8',
    env: process.env,
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`
  const maximum = authoritativeTypeScriptMaximum()
  process.stdout.write(`${JSON.stringify(evaluateTypeScriptBaseline(output, gitChangedPaths(root), maximum, {
    status: result.status,
    signal: result.signal,
    error: result.error ?? null,
  }), null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main() } catch (error) {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  }
}
