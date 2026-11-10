#!/usr/bin/env node

// Regression tests for the single-run architecture scan memo (OD-12, OD-12b).
//
// run-boundary-controls.mjs computes one scanArchitecture() result before its
// first control and hands the memo file to every control it spawns, together
// with the sha256 of the bytes the writer wrote, which the runner keeps in its
// own memory. These tests pin the properties the memo's safety rests on:
//
// * the runner's record binds the exact bytes: a process that rewrites the
//   memo with every internal digest recomputed gets a full scan, not its
//   forged result (R1), and so does a missing, malformed or non-canonical
//   record;
// * every other integrity, identity and input check falls through to the full
//   scan, and a change to an input after the memo was written is never hidden;
// * end to end, a control that rewrites the memo cannot change the scan a
//   later control of the same run sees, the runner ignores inherited memo
//   variables, the off switch works, and the memo directory is gone after the
//   run.
//
// Everything runs on a small temporary fixture tree: the real policy,
// evidence, context index, manifests, amendments and legacy write supplement,
// with the policy's source roots narrowed to two tiny files, so each full scan
// takes well under a second. A "sentinel" memo is a well-formed memo whose
// result carries one extra finding (rule od12_memo_sentinel) and a correct
// internal result digest: a scan that returns the sentinel used the memo.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ARCHITECTURE_SCAN_MEMO_ENV,
  ARCHITECTURE_SCAN_MEMO_SHA256_ENV,
  scanArchitecture,
} from './enforce-architecture.mjs'
import { prepareArchitectureScanMemo } from './run-boundary-controls.mjs'

const ARCHITECTURE_SCAN_MEMO_DISABLE_ENV = 'YOKO_ARCHITECTURE_SCAN_MEMO_DISABLE'
const MEMO_NOTE = 'architecture scan memo:'
const SENTINEL_RULE = 'od12_memo_sentinel'
const SOURCE_ROOT = 'gravity-mvp/src/modules/contacts/od12-fixture'
const OUTSIDE_PROBE = 'gravity-mvp/src/modules/contacts/od12-outside/probe.mjs'
const runnerPath = fileURLToPath(new URL('./run-boundary-controls.mjs', import.meta.url))
const scannerUrl = new URL('./enforce-architecture.mjs', import.meta.url).href

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function withoutMemoVariables(environment) {
  const copy = { ...environment }
  delete copy[ARCHITECTURE_SCAN_MEMO_ENV]
  delete copy[ARCHITECTURE_SCAN_MEMO_SHA256_ENV]
  delete copy[ARCHITECTURE_SCAN_MEMO_DISABLE_ENV]
  return copy
}

function copyInput(repositoryRoot, fixtureRoot, relative, transform = (bytes) => bytes) {
  const target = path.join(fixtureRoot, relative)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, transform(readFileSync(path.join(repositoryRoot, relative))))
}

// Copies exactly what scanArchitecture() reads (see its first lines) and
// narrows the policy's source roots to two small files in an owned module
// (the scan resolves imports only for owned files). One import resolves
// inside the source root (an existence probe that is true) and one points
// outside every source root (a probe that is false, so creating that file
// changes nothing but the probe).
function buildFixture(repositoryRoot, fixtureRoot) {
  const policyPath = 'architecture/enforcement/v1/policy.json'
  const policy = JSON.parse(readFileSync(path.join(repositoryRoot, policyPath), 'utf8'))
  const index = JSON.parse(readFileSync(path.join(repositoryRoot, 'architecture/contexts/v1/context-index.json'), 'utf8'))
  copyInput(repositoryRoot, fixtureRoot, policyPath, () => `${JSON.stringify({ ...policy, source_roots: [SOURCE_ROOT] }, null, 2)}\n`)
  for (const relative of [
    'architecture/evidence/v1/module-rules.json',
    'architecture/evidence/v1/provider-dependencies.json',
    'architecture/contexts/v1/context-index.json',
    ...index.contexts.map((entry) => entry.path),
    ...policy.manifest_amendments,
  ]) copyInput(repositoryRoot, fixtureRoot, relative)
  assert.equal(typeof policy.legacy_write_supplement, 'string', 'the scan memo fixture expects a legacy write supplement')
  copyInput(repositoryRoot, fixtureRoot, policy.legacy_write_supplement)
  mkdirSync(path.join(fixtureRoot, SOURCE_ROOT), { recursive: true })
  writeFileSync(path.join(fixtureRoot, SOURCE_ROOT, 'a.mjs'), [
    "import { b } from './b.mjs'",
    "import { outside } from '../od12-outside/probe.mjs'",
    'export const a = b + (outside ?? 0)',
    '',
  ].join('\n'))
  writeFileSync(path.join(fixtureRoot, SOURCE_ROOT, 'b.mjs'), 'export const b = 1\n')
  return { policy }
}

// One in-process scan with exactly the given memo variables. Memo notes are
// captured (and not printed); any other stderr output passes through.
async function scanWith(root, memoFile = null, recorded = null) {
  const saved = [process.env[ARCHITECTURE_SCAN_MEMO_ENV], process.env[ARCHITECTURE_SCAN_MEMO_SHA256_ENV]]
  const restore = (name, value) => {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  delete process.env[ARCHITECTURE_SCAN_MEMO_ENV]
  delete process.env[ARCHITECTURE_SCAN_MEMO_SHA256_ENV]
  if (memoFile !== null) process.env[ARCHITECTURE_SCAN_MEMO_ENV] = memoFile
  if (recorded !== null) process.env[ARCHITECTURE_SCAN_MEMO_SHA256_ENV] = recorded
  const notes = []
  const write = process.stderr.write
  process.stderr.write = function captureMemoNotes(chunk, ...rest) {
    const text = String(chunk)
    if (text.startsWith(MEMO_NOTE)) {
      notes.push(text.trim())
      return true
    }
    return write.call(process.stderr, chunk, ...rest)
  }
  try {
    const result = await scanArchitecture(root)
    const json = JSON.stringify(result)
    return { json, notes, sentinel: result.findings.some((finding) => finding.rule === SENTINEL_RULE) }
  } finally {
    process.stderr.write = write
    restore(ARCHITECTURE_SCAN_MEMO_ENV, saved[0])
    restore(ARCHITECTURE_SCAN_MEMO_SHA256_ENV, saved[1])
  }
}

function withSentinel(memo, mutate = (value) => value) {
  const copy = structuredClone(memo)
  const result = JSON.parse(copy.result_json)
  result.findings.push({
    rule: SENTINEL_RULE,
    file: 'sentinel',
    line: null,
    source_context: null,
    target_context: null,
    subject: 'sentinel',
    site_signature: null,
    details: {},
    ordinal: 1,
    fingerprint: 'arch_sentinel',
  })
  copy.result_json = JSON.stringify(result)
  copy.result_sha256 = sha256(copy.result_json)
  return mutate(copy)
}

function missNote(reason) {
  return `${MEMO_NOTE} not used (${reason}); running the full scan`
}

function fixtureControl(phase) {
  return `import { scanArchitecture } from ${JSON.stringify(scannerUrl)}
const notes = []
const write = process.stderr.write
process.stderr.write = function captureMemoNotes(chunk, ...rest) {
  const text = String(chunk)
  if (text.startsWith(${JSON.stringify(MEMO_NOTE)})) {
    notes.push(text.trim())
    return true
  }
  return write.call(process.stderr, chunk, ...rest)
}
const scan = await scanArchitecture(process.cwd())
process.stderr.write = write
process.stdout.write(\`OD12_PROBE \${JSON.stringify({
  phase: ${JSON.stringify(phase)},
  memo_file: process.env.${ARCHITECTURE_SCAN_MEMO_ENV} ?? null,
  recorded: process.env.${ARCHITECTURE_SCAN_MEMO_SHA256_ENV} ?? null,
  sentinel: scan.findings.some((finding) => finding.rule === ${JSON.stringify(SENTINEL_RULE)}),
  result_sha256: (await import('node:crypto')).createHash('sha256').update(JSON.stringify(scan)).digest('hex'),
  notes,
})}\\n\`)
`
}

// The forging control rewrites the memo it was handed with a sentinel result
// and every internal digest recomputed, as a PR test that inherits the
// control's environment could.
const forgingControl = `import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
const file = process.env.${ARCHITECTURE_SCAN_MEMO_ENV}
if (!file) {
  process.stdout.write('OD12_FORGE no-pointer\\n')
  process.exit(0)
}
const memo = JSON.parse(readFileSync(file, 'utf8'))
const result = JSON.parse(memo.result_json)
result.findings.push({ rule: ${JSON.stringify(SENTINEL_RULE)}, file: 'sentinel', line: null, source_context: null, target_context: null, subject: 'sentinel', site_signature: null, details: {}, ordinal: 1, fingerprint: 'arch_sentinel' })
memo.result_json = JSON.stringify(result)
memo.result_sha256 = createHash('sha256').update(memo.result_json).digest('hex')
writeFileSync(file, JSON.stringify(memo))
process.stdout.write('OD12_FORGE rewritten\\n')
`

function runRunner(fixtureRoot, environment) {
  const result = spawnSync(process.execPath, [runnerPath], {
    cwd: fixtureRoot,
    env: environment,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
  })
  const probes = Object.fromEntries(`${result.stdout}`.split('\n')
    .filter((line) => line.startsWith('OD12_PROBE '))
    .map((line) => JSON.parse(line.slice('OD12_PROBE '.length)))
    .map((probe) => [probe.phase, probe]))
  return { ...result, probes }
}

export async function runArchitectureScanMemoRegression(repositoryRoot = process.cwd()) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'yoko-architecture-scan-memo-test-'))
  const cases = []
  const check = (name, condition) => {
    assert(condition, `scan memo regression failed: ${name}`)
    cases.push(name)
  }
  try {
    const fixtureRoot = path.join(work, 'fixture')
    const variants = path.join(work, 'variants')
    mkdirSync(variants)
    const { policy } = buildFixture(repositoryRoot, fixtureRoot)
    const fresh = await scanWith(fixtureRoot)
    assert.equal(fresh.notes.length, 0)
    assert.equal(fresh.sentinel, false)

    // W0: the runner's own precompute writes a private memo and reports the
    // sha256 of the exact bytes it wrote.
    const prepared = prepareArchitectureScanMemo(fixtureRoot, withoutMemoVariables(process.env))
    assert(prepared.memoFile, `precompute did not produce a memo: ${prepared.note}`)
    const genuineBytes = readFileSync(prepared.memoFile)
    const genuineSha = sha256(genuineBytes)
    check('W0 the runner record is the sha256 of the bytes the writer wrote', prepared.memoSha256 === genuineSha)
    check('W0 the memo sits in a private temporary directory, mode 0600', (
      path.dirname(prepared.memoFile).startsWith(path.join(os.tmpdir(), 'yoko-architecture-scan-memo-'))
      && (statSync(prepared.memoFile).mode & 0o777) === 0o600
    ))
    const genuine = JSON.parse(genuineBytes.toString('utf8'))
    check('W0 the memo records the import-existence probes of the fixture', (
      JSON.stringify(genuine.existence_probes) === JSON.stringify([[`${SOURCE_ROOT}/b.mjs`, true], [OUTSIDE_PROBE, false]])
    ))
    check('W0 the off switch skips the precompute', (
      prepareArchitectureScanMemo(fixtureRoot, { ...withoutMemoVariables(process.env), [ARCHITECTURE_SCAN_MEMO_DISABLE_ENV]: '1' }).memoFile === null
    ))

    const hit = await scanWith(fixtureRoot, prepared.memoFile, genuineSha)
    check('H0 a genuine memo is used silently and equals the fresh scan byte for byte', hit.notes.length === 0 && hit.json === fresh.json)

    let counter = 0
    const variant = (contents) => {
      counter += 1
      const file = path.join(variants, `variant-${counter}.json`)
      writeFileSync(file, contents)
      return file
    }
    const sentinelBytes = JSON.stringify(withSentinel(genuine))
    const sentinelFile = variant(sentinelBytes)
    const sentinelSha = sha256(sentinelBytes)
    const accepted = await scanWith(fixtureRoot, sentinelFile, sentinelSha)
    check('P0 a sentinel memo that matches the runner record is used (the sentinel is observable)', accepted.sentinel && accepted.notes.length === 0)

    const expectMiss = async (name, memoFile, recorded, reason, reference = fresh) => {
      const result = await scanWith(fixtureRoot, memoFile, recorded)
      const expected = reason === null ? [] : [missNote(reason)]
      check(name, (
        !result.sentinel
        && result.json === reference.json
        && JSON.stringify(result.notes) === JSON.stringify(expected)
      ))
    }
    const recordMismatch = "memo bytes differ from the runner's record"
    const recordInvalid = "the runner's memo digest is missing or malformed"

    // R1: the runner's record binds the bytes, whatever the file says about itself.
    await expectMiss('N18 a memo rewritten with recomputed internal digests is a miss (runner record = genuine memo)', sentinelFile, genuineSha, recordMismatch)
    await expectMiss('N19 the runner record is absent', prepared.memoFile, null, recordInvalid)
    await expectMiss('N20 the runner record is malformed', prepared.memoFile, 'not-a-sha256', recordInvalid)
    await expectMiss('N21 the runner record is upper-case hex of the genuine memo', prepared.memoFile, genuineSha.toUpperCase(), recordInvalid)
    await expectMiss('N21b the runner record is the genuine digest with a trailing newline', prepared.memoFile, `${genuineSha}\n`, recordInvalid)

    // Every inner check still holds when the outer record matches the bytes.
    const signed = async (name, memo, reason) => {
      const bytes = typeof memo === 'string' ? memo : JSON.stringify(memo)
      await expectMiss(name, variant(bytes), sha256(bytes), reason)
    }
    const tampered = withSentinel(genuine)
    await signed('N1 result changed without its internal digest', { ...tampered, result_json: tampered.result_json.replace('"sentinel"', '"sentinal"') }, 'result digest mismatch')
    await signed('N2 truncated memo', sentinelBytes.slice(0, 4096), 'SyntaxError')
    await signed('N3 foreign input digest', withSentinel(genuine, (memo) => ({ ...memo, input_sha256: sha256('foreign') })), 'scan inputs differ')
    await signed('N4 scanner code identity differs', withSentinel(genuine, (memo) => ({ ...memo, code: sha256('other-scanner') })), 'scanner code identity differs')
    await signed('N5 schema differs', withSentinel(genuine, (memo) => ({ ...memo, schema: 'yoko.crm.architecture-scan-memo.v0' })), 'schema')
    await signed('N7 an existence probe disagrees with the tree', withSentinel(genuine, (memo) => ({ ...memo, existence_probes: [...memo.existence_probes, ['architecture/enforcement/v1/policy.json', false]] })), 'existence differs: architecture/enforcement/v1/policy.json')
    await signed('N8 existence probes malformed', withSentinel(genuine, (memo) => ({ ...memo, existence_probes: 'all' })), 'existence probes missing')
    await signed('N11 not JSON at all', '\u0000\u0001garbage', 'SyntaxError')
    // A control that scans its own fixture tree is not the runner's
    // repository: a memo for another root is skipped without a note.
    await signed('N6 a memo for another root is not used', withSentinel(genuine, (memo) => ({ ...memo, root: '/elsewhere' })), null)
    await expectMiss('N9 the memo file is missing', path.join(variants, 'missing.json'), genuineSha, 'ENOENT')
    await expectMiss('N10 the memo pointer is a directory', variants, genuineSha, 'EISDIR')
    writeFileSync(path.join(variants, `killed.json.${process.pid}.tmp`), sentinelBytes)
    await expectMiss('N12 a leftover partial file of a killed writer is never read', path.join(variants, 'killed.json'), sentinelSha, 'ENOENT')

    // Inputs that change after the memo was written are never hidden. Each
    // reference is a fresh scan, without a memo, of the tree as it is now.
    const changed = async (name, mutate, revert, reason) => {
      mutate()
      try {
        const reference = await scanWith(fixtureRoot)
        await expectMiss(name, sentinelFile, sentinelSha, reason, reference)
      } finally {
        revert()
      }
      const again = await scanWith(fixtureRoot, sentinelFile, sentinelSha)
      check(`${name}: reverted, the same memo is used again`, again.sentinel && again.notes.length === 0)
    }
    const sourceFile = path.join(fixtureRoot, SOURCE_ROOT, 'b.mjs')
    const source = readFileSync(sourceFile)
    await changed('N13 one byte appended to a scanned source file', () => writeFileSync(sourceFile, Buffer.concat([source, Buffer.from(' ')])), () => writeFileSync(sourceFile, source), 'scan inputs differ')
    const supplementFile = path.join(fixtureRoot, policy.legacy_write_supplement)
    const supplement = readFileSync(supplementFile)
    await changed('N14 one byte in the legacy write supplement', () => writeFileSync(supplementFile, `${supplement.toString('utf8').trimEnd()} \n`), () => writeFileSync(supplementFile, supplement), 'scan inputs differ')
    const index = JSON.parse(readFileSync(path.join(fixtureRoot, 'architecture/contexts/v1/context-index.json'), 'utf8'))
    const manifestFile = path.join(fixtureRoot, index.contexts[0].path)
    const manifest = readFileSync(manifestFile)
    await changed('N15 one byte in a context manifest', () => writeFileSync(manifestFile, Buffer.concat([manifest, Buffer.from(' ')])), () => writeFileSync(manifestFile, manifest), 'scan inputs differ')
    const newFile = path.join(fixtureRoot, SOURCE_ROOT, 'c.mjs')
    await changed('N17 a new file appears in a scanned root', () => writeFileSync(newFile, 'export const c = 1\n'), () => rmSync(newFile), 'scan inputs differ')
    const outsideFile = path.join(fixtureRoot, OUTSIDE_PROBE)
    await changed('N22 a file appears where only an existence probe looked', () => {
      mkdirSync(path.dirname(outsideFile), { recursive: true })
      writeFileSync(outsideFile, 'export const outside = 1\n')
    }, () => rmSync(path.dirname(outsideFile), { recursive: true, force: true }), `existence differs: ${OUTSIDE_PROBE}`)

    // End to end through the real runner. Three fixture controls run in order:
    // a probe, the forging control, and a probe again.
    const controls = path.join(fixtureRoot, 'tools/architecture')
    mkdirSync(controls, { recursive: true })
    writeFileSync(path.join(fixtureRoot, 'architecture/enforcement/v1/superseded-boundary-controls.json'), `${JSON.stringify({
      schema: 'yoko.crm.superseded-boundary-controls.v1',
      records: [],
    })}\n`)
    writeFileSync(path.join(controls, 'check-a-od12-before-boundary.mjs'), fixtureControl('before'))
    writeFileSync(path.join(controls, 'check-b-od12-forge-boundary.mjs'), forgingControl)
    writeFileSync(path.join(controls, 'check-c-od12-after-boundary.mjs'), fixtureControl('after'))
    const freshSha = sha256(fresh.json)

    const attack = runRunner(fixtureRoot, withoutMemoVariables(process.env))
    const { before, after } = attack.probes
    const attackPassed = attack.status === 0
      && /^ARCHITECTURE_SCAN_MEMO on: ready in /mu.test(attack.stdout)
      && attack.stdout.includes('boundary controls: PASS (3/3 active; 0 evidence-backed superseded)')
    if (!attackPassed) process.stderr.write(`${attack.stdout}${attack.stderr}`)
    check('R1 runner: the run passes with the memo on', attackPassed)
    check('R1 runner: the first control uses the runner memo silently', (
      before?.memo_file && /^[0-9a-f]{64}$/u.test(before.recorded ?? '')
      && !before.sentinel && before.notes.length === 0 && before.result_sha256 === freshSha
    ))
    check('R1 runner: the forging control rewrote the memo', attack.stdout.includes('OD12_FORGE rewritten'))
    check('R1 runner: the next control rejects the rewritten memo and gets the genuine scan', (
      after?.memo_file === before.memo_file && after.recorded === before.recorded
      && !after.sentinel && after.result_sha256 === freshSha
      && JSON.stringify(after.notes) === JSON.stringify([missNote(recordMismatch)])
    ))
    check('R1 runner: the memo directory is removed when the runner exits', !existsSync(path.dirname(before.memo_file)))

    // Inherited memo variables never reach a control, and the off switch
    // leaves every control to scan for itself.
    const inherited = runRunner(fixtureRoot, {
      ...withoutMemoVariables(process.env),
      [ARCHITECTURE_SCAN_MEMO_DISABLE_ENV]: '1',
      [ARCHITECTURE_SCAN_MEMO_ENV]: sentinelFile,
      [ARCHITECTURE_SCAN_MEMO_SHA256_ENV]: sentinelSha,
    })
    const offPassed = inherited.status === 0
      && inherited.stdout.includes(`ARCHITECTURE_SCAN_MEMO off: disabled by ${ARCHITECTURE_SCAN_MEMO_DISABLE_ENV}=1`)
      && inherited.stdout.includes('OD12_FORGE no-pointer')
    if (!offPassed) process.stderr.write(`${inherited.stdout}${inherited.stderr}`)
    check('OFF runner: the off switch is reported and the run passes', offPassed)
    check('OFF runner: an inherited memo pointer and record never reach a control', ['before', 'after'].every((phase) => {
      const probe = inherited.probes[phase]
      return probe && probe.memo_file === null && probe.recorded === null
        && !probe.sentinel && probe.notes.length === 0 && probe.result_sha256 === freshSha
    }))
    return { cases: cases.length }
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const summary = await runArchitectureScanMemoRegression(process.cwd())
  process.stdout.write(`architecture scan memo regression: PASS (${summary.cases} checks; R1 runner forge attack rejected)\n`)
}
