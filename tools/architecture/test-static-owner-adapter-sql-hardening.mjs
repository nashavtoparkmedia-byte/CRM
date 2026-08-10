#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import vm from 'node:vm'

import { extractPrismaWrites } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const require = createRequire(import.meta.url)
const typescript = require(path.join(root, 'gravity-mvp/node_modules/typescript/lib/typescript.js'))
const checks = []
const check = (name, run) => { run(); checks.push(name) }
const checkAsync = async (name, run) => { await run(); checks.push(name) }
const plain = (value) => JSON.parse(JSON.stringify(value))

const adapters = {
  itemReview: {
    path: 'gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-knowledge-item-review-adapter.ts',
    exportName: 'legacyPrismaKnowledgeItemReviewPortV1',
  },
  source: {
    path: 'gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-knowledge-source-adapter.ts',
    exportName: 'legacyPrismaKnowledgeSourcePortV1',
  },
  extraction: {
    path: 'gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-queue-knowledge-extraction-adapter.ts',
    exportName: 'legacyPrismaQueueKnowledgeExtractionPortV1',
  },
  decision: {
    path: 'gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-record-ai-decision-adapter.ts',
    exportName: 'legacyPrismaRecordAiDecisionPortV1',
  },
  usage: {
    path: 'gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-record-knowledge-usage-adapter.ts',
    exportName: 'legacyPrismaRecordKnowledgeUsagePortV1',
  },
  decisionReview: {
    path: 'gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-review-ai-decision-adapter.ts',
    exportName: 'legacyPrismaReviewAiDecisionPortV1',
  },
  retrieval: {
    path: 'gravity-mvp/src/modules/ai-knowledge/public/v1/legacy-prisma-update-retrieval-policy-adapter.ts',
    exportName: 'legacyPrismaUpdateRetrievalPolicyPortV1',
  },
  history: {
    path: 'gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-history-import-job-adapter.ts',
    exportName: 'legacyPrismaHistoryImportJobPortV1',
  },
  event: {
    path: 'gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-message-event-log-adapter.ts',
    exportName: 'legacyPrismaMessageEventLogPortV1',
  },
  retention: {
    path: 'gravity-mvp/src/modules/messaging/public/v1/legacy-prisma-message-retention-adapter.ts',
    exportName: 'legacyPrismaMessageRetentionPortV1',
  },
}

function loadAdapter(spec, execute) {
  const output = typescript.transpileModule(read(spec.path), {
    compilerOptions: {
      module: typescript.ModuleKind.CommonJS,
      target: typescript.ScriptTarget.ES2022,
    },
  }).outputText
  const module = { exports: {} }
  const prisma = new Proxy({ $executeRawUnsafe: execute }, {
    get(target, property, receiver) {
      if (property === '$executeRawUnsafe') return Reflect.get(target, property, receiver)
      throw new Error(`unexpected Prisma capability: ${String(property)}`)
    },
  })
  vm.runInNewContext(output, {
    module,
    exports: module.exports,
    require(specifier) {
      if (specifier === '@/lib/prisma') return { prisma }
      throw new Error(`unexpected import in ${spec.path}: ${specifier}`)
    },
    Array,
    Boolean,
    JSON,
    Number,
    Object,
    Promise,
    String,
  })
  return module.exports[spec.exportName]
}

const sql = {
  itemVerify: 'UPDATE "AiKnowledgeItem" SET "isVerified"=true,"verifiedBy"=$1,"verifiedAt"=NOW(),status=\'active\'::"AiKnowledgeStatus","isActive"=true,"updatedAt"=NOW() WHERE id=$2',
  itemCoach: 'UPDATE "AiKnowledgeItem" SET "canonicalStatement"=$1,"updatedAt"=NOW(),"isVerified"=true,"verifiedBy"=$2,"verifiedAt"=NOW(),status=\'active\'::"AiKnowledgeStatus","isActive"=true WHERE id=$3',
  sourceAttach: 'INSERT INTO "AiKnowledgeSource" (id,"itemId","originType","messageId","chatId",channel,"managerUserId",excerpt,"excerptHash",confidence,"occurredAt","createdAt") VALUES ($1,$2,\'manual_entry\',NULL,NULL,NULL,$3,\'[создано вручную администратором]\',$4,1.0,NOW(),NOW())',
  sourceDisable: 'UPDATE "AiKnowledgeSource" SET "isActive"=false WHERE channel::text=$1 AND "connectionId"=$2 AND "isActive"=true',
  extraction: 'INSERT INTO "AiExtractionJob" (id,status,"sourceType",scope,"extractionQualityTier","createdAt") VALUES ($1,\'queued\'::"AiExtractionStatus",\'chat_message\'::"AiKnowledgeSourceOrigin",$2::jsonb,$3,NOW())',
  decision: 'INSERT INTO "AiDecisionLog" (id, "messageId", "chatId", channel, "detectedIntent", confidence, decision, "selectedModel", "usedKnowledgeEntries", "generatedReply", "replySent", escalated, error, "retrievalMode", "retrievalDecision", "escalationReason", "knowledgeRuntimeVersion", "shadowRetrievalSummary", "createdAt") VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, $12, $13, $14, $15, $16, $17, $18::jsonb, NOW())',
  usage: 'INSERT INTO "AiKnowledgeUsageLog" (id, "itemId", "runtimeContext", "decisionLogId", "messageId", "retrievalScore", "rerankScore", "usedInReply", "policyDecision", "shadowMode", "escalationReason", "usedAt") VALUES ($1, $2, \'chat_reply\'::"AiKnowledgeRuntime", $3, $4, $5, $6, $7, $8, $9, $10, NOW())',
  decisionReview: 'UPDATE "AiDecisionLog" SET "reviewedByOperator" = true, "operatorVerdict" = $1 WHERE id = $2',
  retrieval: 'UPDATE "AiRetrievalPolicy" SET "minConfidenceForReply" = CASE WHEN $1::boolean THEN $2::double precision ELSE "minConfidenceForReply" END, "sensitiveConfidenceMargin" = CASE WHEN $3::boolean THEN $4::double precision ELSE "sensitiveConfidenceMargin" END, "minSourceCountForReply" = CASE WHEN $5::boolean THEN $6::integer ELSE "minSourceCountForReply" END, "verifiedScoreBoost" = CASE WHEN $7::boolean THEN $8::double precision ELSE "verifiedScoreBoost" END, "excludeArchived" = CASE WHEN $9::boolean THEN $10::boolean ELSE "excludeArchived" END, "excludeSuperseded" = CASE WHEN $11::boolean THEN $12::boolean ELSE "excludeSuperseded" END, "excludeDraft" = CASE WHEN $13::boolean THEN $14::boolean ELSE "excludeDraft" END, "conflictEscalates" = CASE WHEN $15::boolean THEN $16::boolean ELSE "conflictEscalates" END, "rerankEnabled" = CASE WHEN $17::boolean THEN $18::boolean ELSE "rerankEnabled" END, "rerankTopN" = CASE WHEN $19::boolean THEN $20::integer ELSE "rerankTopN" END, "prefilterTopN" = CASE WHEN $21::boolean THEN $22::integer ELSE "prefilterTopN" END, "updatedAt" = NOW(), "updatedBy" = $23 WHERE id = \'singleton\'',
  historyDelete: 'DELETE FROM "HistoryImportJob" WHERE id=$1',
  historyUpdate: 'UPDATE "HistoryImportJob" SET status=$1::"AiImportStatus","resultType"=$2,"messagesImported"=$3,"chatsScanned"=$4,"contactsFound"=$5,"startedAt"=$6,"finishedAt"=$7,"coveredPeriodFrom"=$8,"coveredPeriodTo"=$9 WHERE id=$10',
  historyDeleteConnection: 'DELETE FROM "HistoryImportJob" WHERE $1=ANY(channels) AND "connectionId"=$2',
  historyDeleteChannel: 'DELETE FROM "HistoryImportJob" WHERE $1=ANY(channels)',
  historyPatch: 'UPDATE "HistoryImportJob" SET status = CASE WHEN $1::boolean THEN $2::"AiImportStatus" ELSE status END, "resultType" = CASE WHEN $3::boolean THEN $4::text ELSE "resultType" END, "messagesImported" = CASE WHEN $5::boolean THEN $6::integer ELSE "messagesImported" END, "chatsScanned" = CASE WHEN $7::boolean THEN $8::integer ELSE "chatsScanned" END, "contactsFound" = CASE WHEN $9::boolean THEN $10::integer ELSE "contactsFound" END, "startedAt" = CASE WHEN $11::boolean THEN $12::timestamp(3) ELSE "startedAt" END, "finishedAt" = CASE WHEN $13::boolean THEN $14::timestamp(3) ELSE "finishedAt" END, "coveredPeriodFrom" = CASE WHEN $15::boolean THEN $16::timestamp(3) ELSE "coveredPeriodFrom" END, "coveredPeriodTo" = CASE WHEN $17::boolean THEN $18::timestamp(3) ELSE "coveredPeriodTo" END, "detailsJson" = CASE WHEN $19::boolean THEN $20::jsonb ELSE "detailsJson" END WHERE id = $21',
  historyQueue: 'INSERT INTO "HistoryImportJob" (id, channels, mode, "daysBack", "connectionId", status, "chatsScanned", "contactsFound", "messagesImported", "createdAt") VALUES ($1,$2::text[],$3::"AiImportMode",$4,$5,\'queued\'::"AiImportStatus",0,0,0,NOW())',
  historyCancel: 'UPDATE "HistoryImportJob" SET status=\'failed\'::"AiImportStatus","resultType"=\'failed\',"finishedAt"=NOW() WHERE id=$1 AND status IN (\'queued\'::"AiImportStatus",\'running\'::"AiImportStatus")',
  eventClaim: 'UPDATE "MessageEventLog" SET status = \'processing\', "updatedAt" = NOW() WHERE "messageId" = $1 AND "eventType" = \'MessageReceived\' AND status = \'pending\'',
  eventComplete: 'UPDATE "MessageEventLog" SET status = \'processed\', "updatedAt" = NOW() WHERE "messageId" = $1 AND "eventType" = \'MessageReceived\' AND status = \'processing\'',
  eventFail: 'UPDATE "MessageEventLog" SET status = \'failed\', "updatedAt" = NOW() WHERE "messageId" = $1 AND "eventType" = \'MessageReceived\' AND status = \'processing\'',
  retentionDelete: 'DELETE FROM "Message" WHERE id = ANY($1::text[])',
  retentionPurge: 'UPDATE "Message" SET metadata = jsonb_build_object(\'error\', metadata->>\'error\', \'cleaned\', true) WHERE id = ANY($1::text[])',
}

const startedAt = new Date('2026-01-01T00:00:00.000Z')
const finishedAt = new Date('2026-01-02T00:00:00.000Z')
const decisionInput = {
  id: 'decision-1', messageId: 'message-1', chatId: 'chat-1', channel: 'whatsapp',
  detectedIntent: 'price', confidence: 0.8, decision: 'auto_reply', selectedModel: 'model-1',
  usedKnowledgeEntriesJson: '["item-1"]', generatedReply: 'reply', replySent: true,
  escalated: false, error: null, retrievalMode: 'runtime', retrievalDecision: 'answer',
  escalationReason: null, knowledgeRuntimeVersion: 'v1', shadowRetrievalSummaryJson: null,
}
const usageInput = {
  id: 'usage-1', itemId: 'item-1', decisionLogId: 'decision-1', messageId: 'message-1',
  retrievalScore: 0.7, rerankScore: null, usedInReply: false,
  policyDecision: 'filtered_low_confidence', shadowMode: true, escalationReason: 'low',
}
const historyUpdateInput = {
  jobId: 'job-1', status: 'completed', resultType: 'full', messagesImported: 7,
  chatsScanned: 3, contactsFound: 2, startedAt, finishedAt,
  coveredPeriodFrom: startedAt, coveredPeriodTo: finishedAt,
}

const simpleCases = [
  [adapters.itemReview, 'verify', [{ itemId: 'item-1', verifiedBy: null }], [sql.itemVerify, null, 'item-1']],
  [adapters.itemReview, 'applyCoachEdit', [{ itemId: 'item-2', canonicalStatement: 'statement', verifiedBy: 'actor-1' }], [sql.itemCoach, 'statement', 'actor-1', 'item-2']],
  [adapters.source, 'attachManual', [{ sourceId: 'source-1', itemId: 'item-3', actorId: 'actor-1' }], [sql.sourceAttach, 'source-1', 'item-3', 'actor-1', 'manual:item-3']],
  [adapters.source, 'disable', [{ channel: 'whatsapp', connectionId: 'connection-1' }], [sql.sourceDisable, 'whatsapp', 'connection-1'], { disabledCount: 0 }],
  [adapters.extraction, 'enqueue', [{ jobId: 'extract-1', scopeJson: '{"mode":"all"}', qualityTier: 'balanced' }], [sql.extraction, 'extract-1', '{"mode":"all"}', 'balanced']],
  [adapters.decision, 'append', [decisionInput], [sql.decision, ...Object.values(decisionInput)]],
  [adapters.usage, 'append', [usageInput], [sql.usage, ...Object.values(usageInput)]],
  [adapters.decisionReview, 'review', [{ logId: 'decision-1', verdict: 'good' }], [sql.decisionReview, 'good', 'decision-1']],
  [adapters.history, 'delete', ['job-1'], [sql.historyDelete, 'job-1']],
  [adapters.history, 'update', [historyUpdateInput], [sql.historyUpdate, 'completed', 'full', 7, 3, 2, startedAt, finishedAt, startedAt, finishedAt, 'job-1']],
  [adapters.history, 'deleteForConnection', [{ channel: 'telegram', connectionId: 'connection-2' }], [sql.historyDeleteConnection, 'telegram', 'connection-2']],
  [adapters.history, 'deleteForChannel', ['max'], [sql.historyDeleteChannel, 'max']],
  [adapters.history, 'queue', [{ jobId: 'job-2', channels: ['max'], mode: 'last_n_days', daysBack: 7, connectionId: null }], [sql.historyQueue, 'job-2', ['max'], 'last_n_days', 7, null]],
  [adapters.history, 'cancel', ['job-3'], [sql.historyCancel, 'job-3']],
  [adapters.event, 'claim', ['message-2'], [sql.eventClaim, 'message-2'], { claimed: false }],
  [adapters.event, 'complete', ['message-2'], [sql.eventComplete, 'message-2']],
  [adapters.event, 'fail', ['message-2'], [sql.eventFail, 'message-2']],
  [adapters.retention, 'deleteMessages', [['message-3', 'message-4']], [sql.retentionDelete, ['message-3', 'message-4']]],
  [adapters.retention, 'purgeRetryMetadata', [['message-5']], [sql.retentionPurge, ['message-5']]],
]

await checkAsync('19 fixed operations preserve exact SQL, bind order, and zero-row behavior', async () => {
  for (const [spec, method, args, expectedCall, expectedResult] of simpleCases) {
    const calls = []
    const adapter = loadAdapter(spec, async (...input) => { calls.push(input); return 0 })
    const result = await adapter[method](...args)
    assert.deepEqual(calls, [expectedCall], `${spec.path}:${method}`)
    if (expectedResult !== undefined) assert.deepEqual(plain(result), expectedResult)
  }

  const disabled = loadAdapter(adapters.source, async () => 7)
  assert.deepEqual(plain(await disabled.disable({ channel: 'max', connectionId: 'connection-3' })), {
    disabledCount: 7,
  })
  const claimed = loadAdapter(adapters.event, async () => 1)
  assert.deepEqual(plain(await claimed.claim('message-6')), { claimed: true })
})

const retrievalFields = [
  ['minConfidenceForReply', 0],
  ['sensitiveConfidenceMargin', 0.85],
  ['minSourceCountForReply', 0],
  ['verifiedScoreBoost', 0.2],
  ['excludeArchived', false],
  ['excludeSuperseded', true],
  ['excludeDraft', false],
  ['conflictEscalates', true],
  ['rerankEnabled', false],
  ['rerankTopN', 0],
  ['prefilterTopN', 20],
]

await checkAsync('all 2047 non-empty retrieval masks retain one fixed atomic statement and exact tuple', async () => {
  let actualCall
  const adapter = loadAdapter(adapters.retrieval, async (...input) => { actualCall = input; return 0 })
  for (let mask = 1; mask < (1 << retrievalFields.length); mask += 1) {
    const patch = Object.fromEntries(retrievalFields.filter((_, index) => mask & (1 << index)))
    await adapter.update({ actorId: 'actor-2', patch })
    const expected = [sql.retrieval]
    for (let index = 0; index < retrievalFields.length; index += 1) {
      const present = Boolean(mask & (1 << index))
      expected.push(present, present ? retrievalFields[index][1] : null)
    }
    expected.push('actor-2')
    assert.deepEqual(actualCall, expected, `retrieval mask ${mask}`)
  }

  await adapter.update({ actorId: 'actor-empty', patch: {} })
  assert.deepEqual(actualCall, [
    sql.retrieval,
    ...retrievalFields.flatMap(() => [false, null]),
    'actor-empty',
  ])
})

const historyPatchFields = [
  ['status', 'running'],
  ['resultType', 'partial'],
  ['messagesImported', 0],
  ['chatsScanned', 2],
  ['contactsFound', 3],
  ['startedAt', startedAt],
  ['finishedAt', null],
  ['coveredPeriodFrom', startedAt],
  ['coveredPeriodTo', null],
  ['detailsJson', { ok: true }],
]

await checkAsync('all 1023 non-empty history patch masks retain one statement, explicit nulls, and true-at-zero', async () => {
  let actualCall
  let callCount = 0
  const adapter = loadAdapter(adapters.history, async (...input) => {
    actualCall = input
    callCount += 1
    return 0
  })
  assert.deepEqual(plain(await adapter.patch('job-empty', {})), { updated: false })
  assert.equal(callCount, 0)
  assert.deepEqual(plain(await adapter.patch('job-undefined', {
    status: undefined,
    detailsJson: undefined,
  })), { updated: false })
  assert.equal(callCount, 0)

  for (let mask = 1; mask < (1 << historyPatchFields.length); mask += 1) {
    const patch = Object.fromEntries(historyPatchFields.filter((_, index) => mask & (1 << index)))
    assert.deepEqual(plain(await adapter.patch(`job-${mask}`, patch)), { updated: true })
    const expected = [sql.historyPatch]
    for (let index = 0; index < historyPatchFields.length; index += 1) {
      const present = Boolean(mask & (1 << index))
      const value = historyPatchFields[index][0] === 'detailsJson'
        ? JSON.stringify(historyPatchFields[index][1])
        : historyPatchFields[index][1]
      expected.push(present, present ? value : null)
    }
    expected.push(`job-${mask}`)
    assert.deepEqual(actualCall, expected, `history patch mask ${mask}`)
  }
  assert.equal(callCount, (1 << historyPatchFields.length) - 1)
})

await checkAsync('database failures propagate from all 21 operations', async () => {
  const failing = (marker) => async () => { throw new Error(`db:${marker}`) }
  for (const [spec, method, args] of simpleCases) {
    const marker = `${path.basename(spec.path)}:${method}`
    await assert.rejects(loadAdapter(spec, failing(marker))[method](...args), new RegExp(`db:${marker}`))
  }
  await assert.rejects(
    loadAdapter(adapters.retrieval, failing('retrieval')).update({
      actorId: 'actor-3', patch: { excludeArchived: false },
    }),
    /db:retrieval/,
  )
  await assert.rejects(
    loadAdapter(adapters.history, failing('history-patch')).patch('job-fail', { finishedAt: null }),
    /db:history-patch/,
  )
})

check('analyzer proves exactly 21 static owner-table writes', () => {
  const expectedCounts = new Map([
    [adapters.itemReview.path, 2],
    [adapters.source.path, 2],
    [adapters.extraction.path, 1],
    [adapters.decision.path, 1],
    [adapters.usage.path, 1],
    [adapters.decisionReview.path, 1],
    [adapters.retrieval.path, 1],
    [adapters.history.path, 7],
    [adapters.event.path, 3],
    [adapters.retention.path, 2],
  ])
  const expectedTables = new Map([
    [adapters.itemReview.path, 'AiKnowledgeItem'],
    [adapters.source.path, 'AiKnowledgeSource'],
    [adapters.extraction.path, 'AiExtractionJob'],
    [adapters.decision.path, 'AiDecisionLog'],
    [adapters.usage.path, 'AiKnowledgeUsageLog'],
    [adapters.decisionReview.path, 'AiDecisionLog'],
    [adapters.retrieval.path, 'AiRetrievalPolicy'],
    [adapters.history.path, 'HistoryImportJob'],
    [adapters.event.path, 'MessageEventLog'],
    [adapters.retention.path, 'Message'],
  ])
  let total = 0
  for (const [relative, count] of expectedCounts) {
    const writes = extractPrismaWrites(read(relative))
    total += writes.length
    assert.equal(writes.length, count, relative)
    for (const write of writes) {
      assert.equal(write.kind, 'raw')
      assert.equal(write.method, '$executeRawUnsafe')
      assert.equal(write.dynamic, false)
      assert.deepEqual(write.tables, [expectedTables.get(relative)])
    }
  }
  assert.equal(total, 21)

  const ownership = JSON.parse(read('architecture/evidence/v1/data-ownership-candidates.json'))
  const owners = new Map(ownership.models.map((model) => [model.model, model.owner_candidate]))
  for (const table of new Set(expectedTables.values())) {
    assert.equal(owners.get(table), table.startsWith('Ai') ? 'ai_knowledge' : 'messages')
  }
})

check('adapters expose no tagged, transactional, query, or model-delegate capability', () => {
  for (const spec of Object.values(adapters)) {
    const source = read(spec.path)
    assert.doesNotMatch(source, /prisma\.\$executeRaw(?:\s*`|\s*\()/)
    assert.doesNotMatch(source, /\$transaction|\$queryRaw|Prisma\.|TransactionClient|PrismaPromise/)
    assert.doesNotMatch(source, /prisma\.[A-Za-z][A-Za-z0-9]*\.(?:create|update|upsert|delete)/)
  }
})

process.stdout.write(`${JSON.stringify({ status: 'PASS', passed: checks.length, checks }, null, 2)}\n`)
