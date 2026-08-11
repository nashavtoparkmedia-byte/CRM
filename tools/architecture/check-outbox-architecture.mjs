#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []
const checks = []
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const assertCheck = (name, condition, detail) => {
    if (condition) checks.push(name)
    else failures.push({ check: name, detail })
}

const migrationPath = 'gravity-mvp/prisma/migrations/20260809140000_add_domain_outbox/migration.sql'
const migration = read(migrationPath)
const schema = read('gravity-mvp/prisma/schema.prisma')
const eventContract = read('gravity-mvp/src/contracts/calling/v1/recording-ready-event.ts')
const atomicAdapter = read('gravity-mvp/src/modules/calling/internal/recording-ready-prisma-adapter.ts')
const recordingProcessor = read('gravity-mvp/src/lib/freeswitch/recordingProcessor.ts')
const publisher = read('gravity-mvp/src/infrastructure/outbox/v1/outbox-publisher.ts')
const store = read('gravity-mvp/src/infrastructure/outbox/prisma-outbox-store.ts')
const consumer = read('gravity-mvp/src/modules/calling/public/v1/outbox-consumers.ts')
const queues = read('gravity-mvp/src/lib/queue/queues.ts')
const instrumentation = read('gravity-mvp/src/instrumentation.ts')
const composition = read('gravity-mvp/src/modules/platform-shell/public/v1/outbox-runtime.ts')
const manifestAmendments = JSON.parse(read('architecture/events/v1/module-manifest-amendments.json'))

assertCheck(
    'migration is expand-only',
    !/\b(?:DROP|TRUNCATE|DELETE|RENAME)\b/i.test(migration)
        && !/\bALTER\s+(?:TABLE|TYPE)\b/i.test(migration),
    'destructive or contract-phase SQL found',
)
assertCheck(
    'migration creates typed outbox and unique event identity',
    migration.includes('CREATE TYPE "DomainOutboxStatus"')
        && migration.includes('CREATE TABLE "domain_outbox_events"')
        && migration.includes('CREATE UNIQUE INDEX "domain_outbox_events_eventId_key"'),
    'required type, table, or unique event index missing',
)
assertCheck(
    'schema exposes bounded retry and poison state',
    schema.includes('model DomainOutboxEvent')
        && schema.includes('maxAttempts')
        && schema.includes('dead_letter')
        && schema.includes('lastError      String?            @db.VarChar(1000)'),
    'retry/dead-letter/last-error schema is incomplete',
)
assertCheck(
    'event contract is versioned and provider neutral',
    eventContract.includes("calling.RecordingReady.v1")
        && !/@\/lib\/|@prisma|bullmq|redis|freeswitch/i.test(eventContract),
    'event contract is unversioned or provider-bound',
)
assertCheck(
    'domain state and outbox append share one transaction',
    atomicAdapter.includes('$transaction')
        && atomicAdapter.includes('transaction.call.update')
        && atomicAdapter.includes('transaction.domainOutboxEvent.createMany')
        && atomicAdapter.includes('skipDuplicates: true'),
    'atomic transaction or idempotent append is missing',
)
assertCheck(
    'recording flow no longer performs a lossy direct enqueue',
    recordingProcessor.includes('persistRecordingReadyV1')
        && !recordingProcessor.includes('enqueueTranscribe'),
    'direct enqueue remains in recording persistence flow',
)
assertCheck(
    'publisher has bounded batch, retry and dead-letter behavior',
    publisher.includes('OUTBOX_BATCH_LIMIT_V1 = 25')
        && publisher.includes('OUTBOX_PUBLISH_TIMEOUT_MS_V1 = 5_000')
        && publisher.includes("status: terminal ? 'dead_letter' : 'retry_wait'")
        && publisher.includes('normalizeOutboxErrorV1'),
    'publisher reliability bounds are incomplete',
)
assertCheck(
    'store uses compare-and-set claim and stale recovery',
    store.includes("status: 'processing'")
        && store.includes('attempts: candidate.attempts')
        && store.includes('STALE_CLAIM_RECOVERED'),
    'claim ownership or stale recovery is absent',
)
assertCheck(
    'exhausted stale claims become visible dead letters',
    store.includes('STALE_CLAIM_RETRY_BUDGET_EXHAUSTED')
        && store.includes('RETRY_BUDGET_EXHAUSTED'),
    'exhausted claims can remain stuck outside the publisher',
)
assertCheck(
    'consumer validates the event before delivery',
    consumer.includes('parseRecordingReadyEventV1(payload)')
        && consumer.includes('enqueueTranscribe(event.data.callId)'),
    'consumer skips contract validation or delivery adapter',
)
assertCheck(
    'consumer redelivery is idempotent',
    queues.includes('{ jobId: `transcribe-${callId}` }'),
    'stable BullMQ job id missing',
)
assertCheck(
    'publisher is registered at the application composition root',
    instrumentation.includes('startDomainOutboxPublisherV1')
        && instrumentation.includes('registerOperationalIntervalV1(outboxInterval)')
        && composition.includes('callingOutboxPublishersV1')
        && composition.includes('prismaOutboxStoreV1'),
    'runtime publisher registration missing',
)
assertCheck(
    'event envelope includes correlation and causation',
    eventContract.includes('correlationId') && eventContract.includes('causationId'),
    'correlation or causation field missing',
)
assertCheck(
    'new event and infrastructure state are declared in module manifests',
    manifestAmendments.amendments.some((item) =>
        item.context === 'calling' && item.add_events.includes('calling.RecordingReady.v1'))
        && manifestAmendments.amendments.some((item) =>
            item.context === 'platform_shell'
            && item.add_owned_infrastructure_state.includes('gravity-mvp/prisma/schema.prisma:DomainOutboxEvent')),
    'Calling event or Platform Shell infrastructure ownership is undeclared',
)

const result = {
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    checks,
    failures,
    migration: migrationPath,
}
process.stdout.write(JSON.stringify(result, null, 2) + '\n')
if (failures.length > 0) process.exit(1)
