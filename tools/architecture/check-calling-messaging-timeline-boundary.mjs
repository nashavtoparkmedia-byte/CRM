#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { evaluateFindings, scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const esl = read('gravity-mvp/src/lib/freeswitch/EslClient.ts')
const callingPort = read('gravity-mvp/src/modules/calling/public/v1/completed-call-timeline-projection.ts')
const messagingProjector = read('gravity-mvp/src/modules/messaging/public/v1/completed-call-timeline-projector.ts')
const messagingIndex = read('gravity-mvp/src/modules/messaging/public/v1/index.ts')
const instrumentation = read('gravity-mvp/src/instrumentation.ts')
const callingManifest = JSON.parse(read('architecture/contexts/v1/manifests/calling.json'))
const messagingManifest = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const policy = JSON.parse(read('architecture/enforcement/v1/policy.json'))
const checks = []
const failures = []
const check = (name, condition, detail) => (condition ? checks.push(name) : failures.push({ name, detail }))

check(
  'ESL depends only on the Calling-owned projection port',
  esl.includes("from '@/modules/calling/public/v1/completed-call-timeline-projection'") &&
    esl.includes('await projectCompletedCallTimelineV1({') &&
    !esl.includes('@/modules/messaging/') && !esl.includes('@/contracts/messaging/') &&
    !esl.includes('@/lib/messageStreamBus'),
  'Calling still reaches Messaging directly',
)
check(
  'Calling projection port is narrow, validated and fail-closed',
  callingPort.includes('CompletedCallTimelineProjectionV1') &&
    callingPort.includes('completed call timeline projector is not registered') &&
    callingPort.includes('durationSec must be a finite non-negative number or null') &&
    !/(prisma|messageStreamBus|syncCallTimeline|@\/modules\/messaging)/.test(callingPort),
  'Calling port widened or acquired a Messaging implementation dependency',
)
check(
  'Messaging owns sync and broadcast composition',
  messagingProjector.includes('SYNC_CALL_TIMELINE_COMMAND_V1') &&
    messagingProjector.includes("from '../../../calling/public/v1/completed-call-timeline-projection'") &&
    messagingProjector.includes("if (result.action !== 'unchanged') dependencies.broadcast(result.chatId, result.message)") &&
    messagingIndex.includes('messagingCompletedCallTimelineProjectorV1=createCompletedCallTimelineMessagingProjectorV1({') &&
    messagingIndex.includes('sync: syncCallTimelineV1') && messagingIndex.includes('broadcast: broadcastChatMessage'),
  'Messaging projector no longer preserves the exact sync/broadcast behavior',
)
check(
  'Platform Shell wires the sink before ESL starts',
  instrumentation.indexOf('registerCompletedCallTimelineProjectorV1(messagingCompletedCallTimelineProjectorV1)') <
    instrumentation.indexOf("await import('@/modules/calling/public/v1/runtime-startup')"),
  'ESL can start before its Messaging projection sink is registered',
)
const callingDependencies = new Set(callingManifest.allowed_dependencies.map((entry) => entry.context))
const messagingDependencies = new Set(messagingManifest.allowed_dependencies.map((entry) => entry.context))
check(
  'desired dependency direction remains Messaging to Calling',
  !callingDependencies.has('messaging') && messagingDependencies.has('calling') &&
    callingManifest.public_surface.includes('CompletedCallTimelineProjectionPort.v1') &&
    messagingManifest.public_surface.includes('CompletedCallTimelineProjector.v1'),
  'manifests legalized the former Calling to Messaging cycle or omitted the narrow surfaces',
)

const scan = await scanArchitecture(root)
const enforcement = evaluateFindings(scan.findings, registry, policy)
const eslMessagingFindings = scan.findings.filter((finding) =>
  finding.file === 'gravity-mvp/src/lib/freeswitch/EslClient.ts' && finding.target_context === 'messaging')
check(
  'detector finds no equivalent ESL to Messaging bypass',
  eslMessagingFindings.length === 0,
  JSON.stringify(eslMessagingFindings),
)
check(
  'the remediated messageStreamBus exception is retired',
  !registry.exceptions.some((entry) => entry.fingerprint === 'arch_de2f2d2400c2f4d5da3985e0'),
  'stale EslClient messageStreamBus exception remains',
)

process.stdout.write(`${JSON.stringify({
  status: failures.length === 0 ? 'PASS' : 'FAIL',
  checks,
  failures,
  current_findings: scan.findings.length,
  current_registry_entries: registry.exceptions.length,
  strict_enforcement_ok: enforcement.ok,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
