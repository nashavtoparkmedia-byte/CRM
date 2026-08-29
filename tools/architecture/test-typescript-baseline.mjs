#!/usr/bin/env node

import assert from 'node:assert/strict'

import {
  TYPESCRIPT_BASELINE_MAXIMUM,
  authoritativeTypeScriptMaximum,
  evaluateTypeScriptBaseline,
} from './check-typescript-baseline.mjs'

const inherited = [
  'src/legacy.ts(1,1): error TS1000: inherited',
  'src/other.ts(2,2): error TS1001: inherited',
].join('\n')
assert.equal(TYPESCRIPT_BASELINE_MAXIMUM, 30)
assert.equal(authoritativeTypeScriptMaximum({}), 30)
assert.throws(
  () => authoritativeTypeScriptMaximum({ YOKO_TYPESCRIPT_BASELINE_MAX: '999999' }),
  /cannot override/,
)
assert.equal(evaluateTypeScriptBaseline(inherited, ['gravity-mvp/src/changed.ts'], 2).status, 'PASS')
assert.throws(() => evaluateTypeScriptBaseline(`${inherited}\nsrc/new.ts(3,3): error TS1002: new`, [], 2), /baseline grew/)
assert.throws(() => evaluateTypeScriptBaseline(inherited, ['gravity-mvp/src/legacy.ts'], 2), /changed path/)
assert.throws(
  () => evaluateTypeScriptBaseline('npx: command not found', [], 30, { status: null, signal: null, error: new Error('ENOENT') }),
  /failed to start/,
)
assert.throws(
  () => evaluateTypeScriptBaseline('', [], 30, { status: null, signal: 'SIGKILL', error: null }),
  /terminated by a signal/,
)
assert.throws(
  () => evaluateTypeScriptBaseline('internal compiler failure', [], 30, { status: 2, signal: null, error: null }),
  /failed without a recognized diagnostic/,
)
assert.equal(
  evaluateTypeScriptBaseline(inherited, ['gravity-mvp/src/changed.ts'], 2, { status: 2, signal: null, error: null }).status,
  'PASS',
)
assert.throws(
  () => evaluateTypeScriptBaseline(inherited, [], 30, { status: 3, signal: null, error: null }),
  /unexpected exit status/,
)
assert.throws(
  () => evaluateTypeScriptBaseline('error TS18003: No inputs were found in config file', [], 30),
  /unparsed global diagnostic/,
)
assert.throws(
  () => evaluateTypeScriptBaseline("error TS5058: The specified path does not exist: 'tsconfig.json'", [], 30),
  /unparsed global diagnostic/,
)
assert.throws(
  () => evaluateTypeScriptBaseline('compiler exited without diagnostics', [], 30),
  /failed without a recognized diagnostic/,
)
assert.equal(
  evaluateTypeScriptBaseline('', [], 30, { status: 0, signal: null, error: null }).status,
  'PASS',
)
assert.throws(
  () => evaluateTypeScriptBaseline(inherited, [], 30, { status: 0, signal: null, error: null }),
  /reported diagnostics with a successful exit status/,
)
process.stdout.write('TypeScript inherited-baseline gate: PASS (11 negative properties)\n')
