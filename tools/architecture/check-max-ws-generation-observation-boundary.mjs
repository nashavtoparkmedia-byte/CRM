#!/usr/bin/env node

// M2A2-MAX1B0A boundary: the MAX WebSocket generation observation is observation
// and nothing else. Every frame carries the exact generation that delivered it,
// only the keepalive classifies a generation as the data socket, exactly one
// solicited GET_CHATS per data generation is issued through the low-level frame
// rather than the history workflow, its response is correlated by (generation,
// seq), no principal value is ever logged, no database or MAX1A writer is
// reachable, and no authorization, inbound or public contract consumer is
// switched onto any of it.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const INTERCEPTOR = 'max-web-scraper/transport/TransportInterceptor.js'
const OBSERVATION = 'max-web-scraper/transport/ws-generation-observation.js'
const SCRAPER_INDEX = 'max-web-scraper/index.js'
const PROOF = 'max-web-scraper/test/max-ws-generation-observation.test.js'
const MANIFEST = 'architecture/contexts/v1/manifests/max_channel.json'

// Observation may never reach a database, the MAX1A foundation, or the history
// and webhook workflows whose side effects this phase exists to avoid.
const FORBIDDEN_IN_TRANSPORT = [
  '@prisma/client', 'prisma', 'Prisma', 'MaxAccount', 'MaxTransportBinding',
  'max-account-writer', 'max-account-intake', 'recordMaxTransportAttestation',
  'runIfNeeded', '_fetchAllChats', 'InitialHistorySync', 'import-history',
  'forwardToWebhook', 'MAX_TRANSPORT_REF', 'MAX_SCRAPER_WEBHOOK_SECRET',
  'attest', 'CRM_WEBHOOK_URL',
]

// The only fields telemetry may carry. A principal is not among them.
const TELEMETRY_FIELDS = [
  'generation', 'supersededGeneration', 'role', 'outcome',
  'chats', 'withOwner', 'ownerPresence', 'ownerConsistency', 'durationMs',
]

// The additive /status diagnostic block, frozen to the authorized field set.
const STATUS_OBSERVATION_FIELDS = [
  'currentGeneration', 'dataGeneration', 'dataGenerationOpen',
  'principalProofObserved', 'proofSource', 'ownerPresence',
  'ownerConsistency', 'diagnosticState',
]

const PUBLIC_SURFACE = ['MaxDeliveryPort.v1', 'MaxReachability.v1', 'MaxSessionStatus.v1', 'MaxDriverMessaging.v1']

/** Strips comments so a prose mention can never satisfy or break a check. */
function withoutComments(source) {
  let output = ''
  let index = 0
  let state = 'code'
  let quote = ''
  while (index < source.length) {
    const character = source[index]
    const next = source[index + 1]
    if (state === 'code') {
      if (character === '/' && next === '/') { state = 'line'; index += 2; continue }
      if (character === '/' && next === '*') { state = 'block'; index += 2; continue }
      if (character === '"' || character === "'" || character === '`') { state = 'string'; quote = character }
      output += character
      index += 1
      continue
    }
    if (state === 'string') {
      output += character
      if (character === '\\') { output += next ?? ''; index += 2; continue }
      if (character === quote) state = 'code'
      index += 1
      continue
    }
    if (state === 'line') {
      if (character === '\n') { output += character; state = 'code' }
      index += 1
      continue
    }
    if (character === '*' && next === '/') { state = 'code'; index += 2; continue }
    if (character === '\n') output += character
    index += 1
  }
  return output
}

/** Extracts one method body by brace, so an earlier call site cannot be matched. */
function methodBlock(source, signature) {
  const start = source.indexOf(signature)
  assert(start > -1, `missing method: ${signature}`)
  const end = source.indexOf('\n  }\n', start)
  assert(end > start, `unterminated method: ${signature}`)
  return source.slice(start, end)
}

function wsInitScript(interceptor) {
  const start = interceptor.indexOf('const WS_INIT_SCRIPT = `')
  assert(start > -1, 'the browser WebSocket hook is missing')
  const end = interceptor.indexOf('})();`', start)
  assert(end > start, 'the browser WebSocket hook is not terminated')
  return interceptor.slice(start, end)
}

/** 1. Every frame is attributed to the exact generation that delivered it. */
function assertFrameGenerationIsExplicit(sources) {
  const hook = wsInitScript(sources[INTERCEPTOR])
  assert(hook.includes('window.__maxWsGenerationSeq = window.__maxWsGenerationSeq || 0;'), 'the hook does not mint generations')
  assert(hook.includes('var generation = ++window.__maxWsGenerationSeq;'), 'the hook does not mint one generation per socket')
  assert(hook.includes('ws.__maxWsGeneration = generation;'), 'the generation is not stamped on the socket')
  // Only the WebSocket patch carries socket identity. The Worker diagnostic next
  // to it belongs to no socket, so it is deliberately outside this window.
  const socketPatch = hook.slice(hook.indexOf('function PatchedWS(url, protocols) {'), hook.indexOf('PatchedWS.prototype'))
  assert(socketPatch.length > 0, 'the WebSocket patch is missing')
  const receives = socketPatch.match(/__maxWsReceive\([^)]*\)/gu) ?? []
  assert(receives.length >= 3, `the socket patch forwards frames through ${receives.length} call sites`)
  for (const call of receives) {
    assert(/,\s*generation\)$/u.test(call), `an untagged frame leaves the hook: ${call}`)
  }
  const node = sources[INTERCEPTOR]
  assert(node.includes("await page.exposeFunction('__maxWsReceive', (data, generation) => {"), 'Node does not accept the generation')
  for (const signature of [
    '_handleFrame(raw, generation = null) {',
    '_handleBinaryFrame(buf, generation = null) {',
    '_processDecodedFrame(data, generation = null) {',
  ]) {
    assert(node.includes(signature), `frame plumbing loses the generation: ${signature}`)
  }
  assert(node.includes('this._handleBinaryFrame(Buffer.from(raw.slice(4), \'base64\'), generation)'), 'binary frames lose the generation')
  assert.equal((node.match(/this\._processDecodedFrame\(data, generation\)/gu) ?? []).length, 2, 'a decode path loses the generation')
  assert(node.includes('this._observeGenerationFrame(generation, data.opcode)'), 'frames are not observed against their generation')
  // The generation is an argument, never an inference from process-wide state.
  const observation = withoutComments(sources[OBSERVATION])
  const noteFrame = observation.slice(observation.indexOf('noteFrame(generation, opcode'), observation.indexOf('roleOf(generation)'))
  assert(noteFrame.length > 0, 'noteFrame is missing')
  for (const inference of ['currentGeneration', 'Math.max', 'latest']) {
    assert(!noteFrame.includes(inference), `a frame's generation is inferred from ${inference}`)
  }
}

/** 2. Only the MAX keepalive classifies a generation as the data socket. */
function assertKeepaliveClassification(sources) {
  const observation = withoutComments(sources[OBSERVATION])
  assert(observation.includes('const MAX_WS_KEEPALIVE_OPCODE_V1 = 1'), 'the keepalive opcode is not declared')
  const noteFrame = observation.slice(observation.indexOf('noteFrame(generation, opcode'), observation.indexOf('roleOf(generation)'))
  assert(
    noteFrame.includes('if (opcode !== MAX_WS_KEEPALIVE_OPCODE_V1) {'),
    'classification does not gate on the keepalive',
  )
  const comparisons = noteFrame.match(/opcode\s*[!=]==?\s*[^\s)]+/gu) ?? []
  for (const comparison of comparisons) {
    assert(comparison.includes('MAX_WS_KEEPALIVE_OPCODE_V1'), `classification consults another opcode: ${comparison}`)
  }
  for (const wrong of ['setTimeout', 'setInterval', 'createdAt <', 'createdAt >', 'lifetime']) {
    assert(!observation.includes(wrong), `classification uses ${wrong} rather than the keepalive`)
  }
  assert(observation.includes("record.role = 'data'"), 'the keepalive does not promote the generation')
}

/** 3. The diagnostic is the low-level frame, never the history workflow. */
function assertDiagnosticIsDirect(sources) {
  const node = sources[INTERCEPTOR]
  assert(
    node.includes('const payload = await this.sendFrame(OP.GET_CHATS, { chatIds: [] }, {'),
    'the diagnostic does not use the low-level GET_CHATS frame',
  )
  assert(node.includes('expectedGeneration: generation,'), 'the diagnostic is not bound to its generation')
  const stripped = withoutComments(node)
  for (const forbidden of FORBIDDEN_IN_TRANSPORT) {
    assert(!stripped.includes(forbidden), `the transport reaches ${forbidden}`)
  }
  assert(!withoutComments(sources[OBSERVATION]).includes('require('), 'the decision module took a dependency')
}

/** 4. One diagnostic per data generation, and never for a probe candidate. */
function assertOneDiagnosticPerDataGeneration(sources) {
  const node = sources[INTERCEPTOR]
  const runner = methodBlock(node, 'async _runGenerationPrincipalDiagnosticV1(generation) {')
  assert(runner.includes('if (!observation.shouldRunDiagnostic(generation)) return'), 'the diagnostic is not budgeted')
  assert(runner.includes('if (!observation.markDiagnosticStarted(generation)) return'), 'the diagnostic budget is not consumed')
  assert.equal((runner.match(/this\.sendFrame\(/gu) ?? []).length, 1, 'the diagnostic sends more than once')
  assert(!runner.includes('retry') && !runner.includes('for (') && !runner.includes('while ('), 'the diagnostic retries')
  const observation = withoutComments(sources[OBSERVATION])
  const should = observation.slice(observation.indexOf('shouldRunDiagnostic(generation)'), observation.indexOf('markDiagnosticStarted('))
  assert(should.includes("if (record.role !== 'data') return false"), 'a probe candidate could be probed')
  assert(should.includes("return record.diagnostic.state === 'idle'"), 'a generation could be probed twice')
}

/** 5. The diagnostic response is correlated by (generation, seq). */
function assertGenerationScopedCorrelation(sources) {
  const node = sources[INTERCEPTOR]
  assert(node.includes('const key = `${generation}:${data.seq}`'), 'a response is correlated without its generation')
  assert(node.includes('const key     = generationBound ? `${expectedGeneration}:${seq}` : seq'), 'a request is registered without its generation')
  assert(node.includes('const pending = generationBound ? this._generationPendingReqs : this._pendingReqs'), 'legacy pending semantics changed')
  assert(node.includes('if (this._resolveGenerationPendingReq(generation, data)) return'), 'generation-bound responses are not resolved')
  assert(node.includes('if (!isExactGenerationV1(generation) || data == null) return false'), 'an untagged frame could resolve a diagnostic')
}

/** 6. Telemetry and the census carry shapes and counts, never a principal. */
function assertNoPrincipalIsLogged(sources) {
  const node = sources[INTERCEPTOR]
  const emitter = methodBlock(node, '_emitGenerationTelemetry(event, fields = {}) {')
  assert(emitter.includes('if (!MAX_WS_TELEMETRY_EVENTS_V1.includes(event)) return'), 'telemetry events are unbounded')
  for (const field of TELEMETRY_FIELDS) assert(emitter.includes(`'${field}'`), `telemetry drops ${field}`)
  const declared = [...emitter.matchAll(/'([a-zA-Z]+)',?\n/gu)].map((match) => match[1])
  for (const field of declared) assert(TELEMETRY_FIELDS.includes(field), `telemetry declares an unexpected field: ${field}`)
  assert(emitter.includes('JSON.stringify(bounded)'), 'telemetry logs something other than its bounded field set')
  for (const leak of ['_myUserId', 'owner)', 'census.owner', 'providerUserId']) {
    assert(!emitter.includes(leak), `telemetry could carry ${leak}`)
  }
  const observation = withoutComments(sources[OBSERVATION])
  assert(!observation.includes('console.'), 'the decision module logs')
  const census = observation.slice(observation.indexOf('function censusOwnerEvidenceV1('), observation.indexOf('function diagnosticOutcomeForCensusV1('))
  const returned = [...census.matchAll(/return \{([^}]*)\}/gu)].flatMap((match) => match[1].split(',').map((entry) => entry.split(':')[0].trim()))
  for (const key of returned.filter(Boolean)) {
    assert(['hasChats', 'chats', 'withOwner', 'ownerPresence', 'ownerConsistency'].includes(key), `the census returns ${key}`)
  }
  assert(census.includes('const distinct = new Set()'), 'owners are not compared in memory only')
}

/** 7. Conflicting provider-owned answers fail closed. */
function assertConflictFailsClosed(sources) {
  const observation = withoutComments(sources[OBSERVATION])
  const outcome = observation.slice(observation.indexOf('function diagnosticOutcomeForCensusV1('), observation.indexOf('function emptyDiagnostic('))
  assert(outcome.includes("if (!census || census.ownerConsistency === 'conflicting') return 'conflicting_owner'"), 'a conflict does not fail closed')
  assert(outcome.includes("census.withOwner > 0 && census.ownerConsistency === 'single'"), 'proof is claimed without a single owner')
}

/** 8. No authorization, readiness or inbound consumer moved onto observation. */
function assertProductAuthorityUnchanged(sources) {
  const node = sources[INTERCEPTOR]
  assert(node.includes('  isAuthenticated() {\n    return !!this._myUserId\n  }'), 'isAuthenticated() changed')
  const index = sources[SCRAPER_INDEX]
  assert(
    index.includes('function liveAuthenticatedMaxProviderAccountId() {\n  if (!transport?.isAuthenticated?.()) return null\n  return normalizeExactMaxProviderAccountId(transport._myUserId)\n}'),
    'the authority reader changed',
  )
  assert(index.includes("code: 'MAX_PROVIDER_ACCOUNT_UNPROVEN',"), 'the unavailable result changed')
  assert(index.includes("code: 'MAX_PROVIDER_ACCOUNT_MISMATCH',"), 'the mismatch result changed')
  const authority = index.slice(index.indexOf('function liveAuthenticatedMaxProviderAccountId'), index.indexOf('function maxScraperWebhookHeaders'))
  const inbound = index.slice(index.indexOf('async function forwardToWebhook'), index.indexOf('trackImportedMessage(normalizedPayload.chatId'))
  for (const region of [authority, inbound]) {
    for (const observationName of ['maxWsGenerationObservationV1', 'transportObservation', 'dataGeneration', 'principalProofObserved', 'generationBound']) {
      assert(!region.includes(observationName), `a product path consults ${observationName}`)
    }
  }
  // Normal product sends still pass no generation to the browser bridge.
  assert(node.includes('() => this._page.evaluate(d => window.__maxWsSend(d), data)'), 'product sends changed shape')
  assert.equal((node.match(/window\.__maxWsSendBinary\(b\), /gu) ?? []).length, 3, 'a binary product send changed shape')
}

/** 9. The status surface stays additive and carries no principal. */
function assertStatusIsAdditive(sources) {
  const index = sources[SCRAPER_INDEX]
  const status = index.slice(index.indexOf("app.get('/status'"), index.indexOf("app.get('/qr'"))
  for (const field of ['isReady', 'isLoggedIn', 'qrGenerated', 'historyImportMode', 'qrUpdatedAt', 'readySinceAt', 'wsConnected', 'authenticated', 'myUserId']) {
    assert(status.includes(field), `/status lost ${field}`)
  }
  assert(status.includes('transportObservation: transport?.maxWsGenerationObservationV1?.() ?? null,'), '/status does not expose the observation')
  const observation = withoutComments(sources[OBSERVATION])
  const snapshot = observation.slice(observation.indexOf('snapshot() {'))
  // Shorthand and explicit properties both count as exposed status fields.
  const keys = [...snapshot.matchAll(/^\s{16}([a-zA-Z]+)[,:]/gmu)].map((match) => match[1])
  assert.deepEqual(keys.sort(), [...STATUS_OBSERVATION_FIELDS].sort(), `the status block exposes ${keys.join(', ')}`)
  for (const leak of ['owner:', 'providerUserId', 'myUserId', 'transportRef']) {
    assert(!snapshot.includes(leak), `the status block carries ${leak}`)
  }
}

/** 10. No public or cross-context contract moved. */
function assertNoPublicContractChange(sources) {
  const manifest = JSON.parse(sources[MANIFEST])
  assert.deepEqual(manifest.public_surface, PUBLIC_SURFACE, 'the MAX public surface changed')
  assert(
    manifest.verification.module_tests.includes('node tools/architecture/check-max-ws-generation-observation-boundary.mjs'),
    'the observation control is not a declared module test',
  )
  const consumers = spawnSync('git', ['-c', 'safe.directory=*', 'grep', '-l', '-E', 'ws-generation-observation|maxWsGenerationObservationV1', '--', 'gravity-mvp', 'tg-bot', 'android'], {
    cwd: root, encoding: 'utf8',
  })
  assert.equal(consumers.stdout.trim(), '', `a product tree consumes the observation: ${consumers.stdout.trim()}`)
}

const CHECKS = [
  ['frame_generation_explicit', assertFrameGenerationIsExplicit],
  ['keepalive_classification', assertKeepaliveClassification],
  ['diagnostic_direct', assertDiagnosticIsDirect],
  ['one_diagnostic_per_data_generation', assertOneDiagnosticPerDataGeneration],
  ['generation_scoped_correlation', assertGenerationScopedCorrelation],
  ['no_principal_logged', assertNoPrincipalIsLogged],
  ['conflict_fails_closed', assertConflictFailsClosed],
  ['product_authority_unchanged', assertProductAuthorityUnchanged],
  ['status_additive', assertStatusIsAdditive],
  ['no_public_contract_change', assertNoPublicContractChange],
]

/** Each probe must be caught by the named check, or the check proves nothing. */
const PROBES = [
  ['untagged_hook_frame', 'frame_generation_explicit', (s) => ({ ...s, [INTERCEPTOR]: s[INTERCEPTOR].replace('window.__maxWsReceive(d, generation);', 'window.__maxWsReceive(d);') })],
  ['unminted_generation', 'frame_generation_explicit', (s) => ({ ...s, [INTERCEPTOR]: s[INTERCEPTOR].replace('var generation = ++window.__maxWsGenerationSeq;', 'var generation = window.__maxWsGeneration;') })],
  ['unstamped_socket', 'frame_generation_explicit', (s) => ({ ...s, [INTERCEPTOR]: s[INTERCEPTOR].replace('ws.__maxWsGeneration = generation;', 'ws.__maxWsGenerationX = generation;') })],
  ['binary_path_loses_generation', 'frame_generation_explicit', (s) => ({ ...s, [INTERCEPTOR]: s[INTERCEPTOR].replace("this._handleBinaryFrame(Buffer.from(raw.slice(4), 'base64'), generation)", "this._handleBinaryFrame(Buffer.from(raw.slice(4), 'base64'))") })],
  ['inferred_generation', 'frame_generation_explicit', (s) => ({ ...s, [OBSERVATION]: s[OBSERVATION].replace('const record = ensure(generation, at)\n            record.frames += 1', 'const record = ensure(currentGeneration, at)\n            record.frames += 1') })],
  ['classification_by_auth_frame', 'keepalive_classification', (s) => ({ ...s, [OBSERVATION]: s[OBSERVATION].replace('if (opcode !== MAX_WS_KEEPALIVE_OPCODE_V1) {', 'if (opcode !== 19) {') })],
  ['classification_by_timer', 'keepalive_classification', (s) => ({ ...s, [OBSERVATION]: s[OBSERVATION].replace('const generations = new Map()', 'const generations = new Map(); setTimeout(() => {}, 1)') })],
  ['diagnostic_via_history_workflow', 'diagnostic_direct', (s) => ({ ...s, [INTERCEPTOR]: s[INTERCEPTOR].replace('const payload = await this.sendFrame(OP.GET_CHATS, { chatIds: [] }, {', 'const payload = await this.runIfNeeded(OP.GET_CHATS, { chatIds: [] }, {') })],
  ['transport_takes_database', 'diagnostic_direct', (s) => ({ ...s, [INTERCEPTOR]: s[INTERCEPTOR].replace("const fs   = require('fs')", "const fs   = require('fs')\nconst { PrismaClient } = require('@prisma/client')") })],
  ['observation_takes_dependency', 'diagnostic_direct', (s) => ({ ...s, [OBSERVATION]: s[OBSERVATION].replace("'use strict'", "'use strict'\nconst fs = require('fs')") })],
  ['unbudgeted_diagnostic', 'one_diagnostic_per_data_generation', (s) => ({ ...s, [INTERCEPTOR]: s[INTERCEPTOR].replace('if (!observation.shouldRunDiagnostic(generation)) return', 'if (false) return') })],
  ['probe_candidate_probed', 'one_diagnostic_per_data_generation', (s) => ({ ...s, [OBSERVATION]: s[OBSERVATION].replace("if (record.role !== 'data') return false", "if (record.role === 'nonsense') return false") })],
  ['seq_only_correlation', 'generation_scoped_correlation', (s) => ({ ...s, [INTERCEPTOR]: s[INTERCEPTOR].replace('const key = `${generation}:${data.seq}`', 'const key = `${data.seq}`') })],
  ['untagged_frame_resolves', 'generation_scoped_correlation', (s) => ({ ...s, [INTERCEPTOR]: s[INTERCEPTOR].replace('if (!isExactGenerationV1(generation) || data == null) return false', 'if (data == null) return false') })],
  ['unbounded_telemetry', 'no_principal_logged', (s) => ({ ...s, [INTERCEPTOR]: s[INTERCEPTOR].replace('if (!MAX_WS_TELEMETRY_EVENTS_V1.includes(event)) return', 'if (!event) return') })],
  ['telemetry_logs_principal', 'no_principal_logged', (s) => ({ ...s, [INTERCEPTOR]: s[INTERCEPTOR].replace('console.log(`[MAX_WS_GENERATION] ${event} ${JSON.stringify(bounded)}`)', 'console.log(`[MAX_WS_GENERATION] ${event} ${this._myUserId}`)') })],
  ['census_returns_owner', 'no_principal_logged', (s) => ({ ...s, [OBSERVATION]: s[OBSERVATION].replace('return { hasChats: true, chats: chats.length, withOwner, ownerPresence, ownerConsistency }', 'return { hasChats: true, chats: chats.length, withOwner, ownerPresence, ownerConsistency, owner: [...distinct][0] }') })],
  ['conflict_picks_one', 'conflict_fails_closed', (s) => ({ ...s, [OBSERVATION]: s[OBSERVATION].replace("if (!census || census.ownerConsistency === 'conflicting') return 'conflicting_owner'", "if (!census) return 'conflicting_owner'") })],
  ['authority_reads_observation', 'product_authority_unchanged', (s) => ({ ...s, [SCRAPER_INDEX]: s[SCRAPER_INDEX].replace('function liveAuthenticatedMaxProviderAccountId() {\n  if (!transport?.isAuthenticated?.()) return null', 'function liveAuthenticatedMaxProviderAccountId() {\n  if (!transport?.maxWsGenerationObservationV1?.()?.principalProofObserved) return null') })],
  ['is_authenticated_changed', 'product_authority_unchanged', (s) => ({ ...s, [INTERCEPTOR]: s[INTERCEPTOR].replace('  isAuthenticated() {\n    return !!this._myUserId\n  }', '  isAuthenticated() {\n    return this.maxWsGenerationObservationV1().principalProofObserved\n  }') })],
  ['product_send_bound', 'product_authority_unchanged', (s) => ({ ...s, [INTERCEPTOR]: s[INTERCEPTOR].replace('() => this._page.evaluate(d => window.__maxWsSend(d), data)', '() => this._page.evaluate(d => window.__maxWsSend(d, 1), data)') })],
  ['status_loses_field', 'status_additive', (s) => ({ ...s, [SCRAPER_INDEX]: s[SCRAPER_INDEX].replace('      myUserId:      transport?._myUserId || null,\n', '') })],
  ['status_exposes_principal', 'status_additive', (s) => ({ ...s, [OBSERVATION]: s[OBSERVATION].replace('                diagnosticState: record === undefined', '                providerUserId: null,\n                diagnosticState: record === undefined') })],
  ['public_surface_moved', 'no_public_contract_change', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('"MaxDriverMessaging.v1"', '"MaxDriverMessaging.v1",\n      "MaxWsGeneration.v1"') })],
  ['control_not_declared', 'no_public_contract_change', (s) => ({ ...s, [MANIFEST]: s[MANIFEST].replace('      "node tools/architecture/check-max-ws-generation-observation-boundary.mjs"', '      "node tools/architecture/check-nothing.mjs"') })],
]

function main() {
  const sources = Object.fromEntries([INTERCEPTOR, OBSERVATION, SCRAPER_INDEX, MANIFEST].map((relative) => [relative, read(relative)]))
  const checks = new Map(CHECKS)
  for (const [, check] of CHECKS) check(sources)

  for (const [name, checkName, mutate] of PROBES) {
    const check = checks.get(checkName)
    assert(check !== undefined, `probe ${name} names an unknown check`)
    const mutated = mutate(sources)
    assert.notDeepEqual(mutated, sources, `probe ${name} changed nothing`)
    let caught = false
    try { check(mutated) } catch { caught = true }
    assert(caught, `probe ${name} was not caught by ${checkName}`)
  }

  // The observation proof is what makes these invariants behavioural, so this
  // control runs it rather than trusting that something else will.
  const proof = spawnSync(process.execPath, ['--test', PROOF], { cwd: root, encoding: 'utf8' })
  assert.equal(proof.status, 0, `the MAX1B0A observation proof failed:\n${proof.stdout}\n${proof.stderr}`)
  const passed = /^# pass (\d+)$/mu.exec(proof.stdout)
  assert(passed !== null && Number(passed[1]) > 0, 'the observation proof reported no passing tests')

  process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    control: 'max-ws-generation-observation-boundary',
    checks: CHECKS.length,
    negative_probes: PROBES.length,
    observation_tests: Number(passed[1]),
    enforcement: false,
    database_access: 0,
    status_fields: STATUS_OBSERVATION_FIELDS.length,
  }, null, 2)}\n`)
}

main()
