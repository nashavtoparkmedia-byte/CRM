#!/usr/bin/env node

import assert from 'node:assert/strict'

import { evaluateTypeScriptBaseline } from './check-typescript-baseline.mjs'

const inherited = [
  'src/legacy.ts(1,1): error TS1000: inherited',
  'src/other.ts(2,2): error TS1001: inherited',
].join('\n')
assert.equal(evaluateTypeScriptBaseline(inherited, ['gravity-mvp/src/changed.ts'], 2).status, 'PASS')
assert.throws(() => evaluateTypeScriptBaseline(`${inherited}\nsrc/new.ts(3,3): error TS1002: new`, [], 2), /baseline grew/)
assert.throws(() => evaluateTypeScriptBaseline(inherited, ['gravity-mvp/src/legacy.ts'], 2), /changed path/)
process.stdout.write('TypeScript inherited-baseline gate: PASS (2 negative properties)\n')
