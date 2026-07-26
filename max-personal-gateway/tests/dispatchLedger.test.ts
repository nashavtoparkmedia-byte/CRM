import assert from 'node:assert/strict'
import test from 'node:test'
import { PrismaDispatchLedger } from '../src/dispatch/PrismaDispatchLedger.ts'
import { DispatchLedgerError } from '../src/dispatch/errors.ts'
import { isDispatchLedgerEnabled } from '../src/dispatch/featureFlag.ts'
import { FailClosedSenderAuthorityVerifier, validateSenderAuthorityProof } from '../src/dispatch/SenderAuthority.ts'
import { honestOutboundStatus } from '../src/dispatch/statusMapping.ts'
import type { DispatchState } from '../src/dispatch/types.ts'
import type { RouteRegistry } from '../src/route/RouteRegistry.ts'

const now = new Date('2026-07-26T23:00:00.000Z')

test('MAX_DISPATCH_LEDGER_ENABLED is a fail-closed account allowlist', () => {
  for (const raw of [undefined, '', ' ', '*', 'true', ' account-a', 'account-a ', 'account-a,,account-b']) {
    assert.equal(isDispatchLedgerEnabled('account-a', raw), false)
  }
  assert.equal(isDispatchLedgerEnabled('account-a', 'account-a,account-a'), true)
  assert.equal(isDispatchLedgerEnabled('account-b', 'account-a,account-a'), false)
})

test('honest status mapping never claims recipient delivery or read', () => {
  const states: DispatchState[] = [
    'queued', 'dispatching', 'sent_to_provider_client', 'awaiting_confirmation',
    'reconciliation_required', 'provider_confirmed', 'retryable_failed', 'hard_failed', 'dead_letter',
  ]
  assert.deepEqual(states.map(honestOutboundStatus), [
    'queued', 'sending', 'sent_to_client', 'awaiting_provider_confirmation',
    'checking', 'accepted_by_max', 'retrying', 'failed', 'needs_review',
  ])
  assert.equal(states.includes('delivered' as DispatchState), false)
})

test('default sender authority verifier always fails closed', async () => {
  const verifier = new FailClosedSenderAuthorityVerifier()
  await assert.rejects(verifier.verify({
    accountId: 'account-a', ownerId: 'owner-a', fencingEpoch: 1, proofTimestamp: now, now,
  }), error => error instanceof DispatchLedgerError && error.code === 'SENDER_AUTHORITY_REQUIRED')
})

test('sender authority proof is exact, account-scoped, epoch-scoped and unexpired', () => {
  const input = { accountId: 'account-a', ownerId: 'owner-a', fencingEpoch: 7, proofTimestamp: now, now }
  const proof = { accountId: input.accountId, ownerId: input.ownerId, fencingEpoch: input.fencingEpoch,
    verifiedAt: now, leaseUntil: new Date(now.valueOf() + 10_000) }
  assert.equal(validateSenderAuthorityProof(input, proof).fencingEpoch, 7)
  for (const changed of [
    { ...proof, accountId: 'account-b' },
    { ...proof, ownerId: 'owner-b' },
    { ...proof, fencingEpoch: 8 },
    { ...proof, leaseUntil: now },
  ]) {
    assert.throws(() => validateSenderAuthorityProof(input, changed), error =>
      error instanceof DispatchLedgerError && error.code === 'STALE_SENDER_AUTHORITY')
  }
})

test('beginAttempt remains fail-closed before any transaction with default authority', async () => {
  const client = { maxOutboundDispatchTransition: { async findFirst() { return null } } }
  const route = {
    async getSendableRouteSnapshot() {
      return {
        accountId: 'account-a', conversationKey: 'conversation-a', routeVersion: 1, state: 'active',
        identities: [], activeProtocolChatId: 'protocol-a', evidenceReferences: ['evidence-a'],
        hasOpenConflict: false, createdAt: now.toISOString(), updatedAt: now.toISOString(),
      }
    },
  }
  const ledger = new PrismaDispatchLedger(client as any, route as unknown as RouteRegistry)
  await assert.rejects(ledger.beginAttempt({
    attemptId: 'attempt-a', accountId: 'account-a', conversationKey: 'conversation-a',
    dispatchId: 'dispatch-a', expectedStateVersion: 1, senderOwnerId: 'sender-a',
    senderFencingEpoch: 1, senderProofTimestamp: now, attemptCorrelationId: 'correlation-a',
    transitionIdempotencyKey: 'begin-a', now,
  }), error => error instanceof DispatchLedgerError && error.code === 'SENDER_AUTHORITY_REQUIRED')
})
