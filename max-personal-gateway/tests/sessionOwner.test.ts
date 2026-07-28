import assert from 'node:assert/strict'
import test from 'node:test'
import { DurableAccountSessionOwner } from '../src/session/AccountSessionOwner.ts'
import {
  SESSION_OWNER_ACQUISITION_ACCOUNTS,
  SESSION_OWNER_HEARTBEAT_ACCOUNTS,
  SESSION_OWNER_PERSISTENCE_ACCOUNTS,
  SESSION_OWNER_PHYSICAL_SENDER_ACCOUNTS,
  SESSION_OWNER_SENDER_FENCING_ACCOUNTS,
} from '../src/session/constants.ts'
import { SessionOwnerError } from '../src/session/errors.ts'
import { sessionOwnerFeatureFlags } from '../src/session/featureFlag.ts'
import { FakeSessionOwnerRepository } from './support/FakeSessionOwnerRepository.ts'

function harness() {
  const repository = new FakeSessionOwnerRepository()
  return { repository, owner: new DurableAccountSessionOwner(repository) }
}

async function rejectsCode(operation: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(operation, error => error instanceof SessionOwnerError && error.code === code)
}

test('1-2: two simultaneous owners elect exactly one winner', async () => {
  const { owner } = harness()
  const outcomes = await Promise.allSettled([
    owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-a', leaseMilliseconds: 1000 }),
    owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-b', leaseMilliseconds: 1000 }),
  ])
  assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(outcomes.filter(result => result.status === 'rejected' && result.reason instanceof SessionOwnerError && result.reason.code === 'LEASE_HELD').length, 1)
})

test('3-4: takeover fencing tokens differ and remain strictly monotonic', async () => {
  const { repository, owner } = harness()
  const first = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-a', leaseMilliseconds: 100 })
  repository.advanceDatabaseTime(101)
  const second = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-b', leaseMilliseconds: 100 })
  repository.advanceDatabaseTime(101)
  const third = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-c', leaseMilliseconds: 100 })
  assert.deepEqual([first.lease.fencingToken, second.lease.fencingToken, third.lease.fencingToken], [1n, 2n, 3n])
})

test('5: current owner renews using database time and the same fence', async () => {
  const { repository, owner } = harness()
  const acquired = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-a', leaseMilliseconds: 1000 })
  repository.advanceDatabaseTime(25)
  const renewed = await owner.renew({ accountId: 'account-a', ownerInstanceId: 'owner-a', fencingToken: acquired.lease.fencingToken, leaseMilliseconds: 2000 })
  assert.equal(renewed.fencingToken, acquired.lease.fencingToken)
  assert.equal(renewed.observedDatabaseTime.valueOf(), acquired.lease.observedDatabaseTime.valueOf() + 25)
})

test('6: stale owner renewal is denied', async () => {
  const { repository, owner } = harness()
  const old = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'old', leaseMilliseconds: 100 })
  repository.advanceDatabaseTime(101)
  await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'new', leaseMilliseconds: 1000 })
  await rejectsCode(owner.renew({ accountId: 'account-a', ownerInstanceId: 'old', fencingToken: old.lease.fencingToken }), 'STALE_FENCE')
})

test('7: takeover before database lease expiry is denied', async () => {
  const { repository, owner } = harness()
  await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-a', leaseMilliseconds: 1000 })
  repository.advanceDatabaseTime(999)
  await rejectsCode(owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-b' }), 'LEASE_HELD')
})

test('8: takeover after database lease expiry is allowed', async () => {
  const { repository, owner } = harness()
  await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-a', leaseMilliseconds: 100 })
  repository.advanceDatabaseTime(100)
  const takeover = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-b' })
  assert.equal(takeover.disposition, 'taken_over')
  assert.equal(takeover.lease.fencingToken, 2n)
})

test('9: stale sender is denied immediately before its physical boundary', async () => {
  const { repository, owner } = harness()
  const stale = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'stale', leaseMilliseconds: 100 })
  repository.advanceDatabaseTime(101)
  await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'current' })
  await rejectsCode(owner.verifyImmediatelyBeforeSender({ accountId: 'account-a', ownerInstanceId: 'stale', fencingToken: stale.lease.fencingToken }), 'STALE_FENCE')
})

test('10: account A fence has zero authority for account B', async () => {
  const { owner } = harness()
  const lease = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-a' })
  await owner.acquire({ accountId: 'account-b', ownerInstanceId: 'owner-b' })
  await rejectsCode(owner.verifyImmediatelyBeforeSender({ accountId: 'account-b', ownerInstanceId: 'owner-a', fencingToken: lease.lease.fencingToken }), 'STALE_FENCE')
})

test('11: duplicate acquire by current owner is idempotent and keeps its token', async () => {
  const { owner } = harness()
  const first = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-a' })
  const duplicate = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-a' })
  assert.equal(duplicate.disposition, 'renewed')
  assert.equal(duplicate.lease.fencingToken, first.lease.fencingToken)
})

test('12: duplicate heartbeat is safe and never allocates a fence', async () => {
  const { owner } = harness()
  const acquired = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-a' })
  const one = await owner.renew({ accountId: 'account-a', ownerInstanceId: 'owner-a', fencingToken: acquired.lease.fencingToken })
  const two = await owner.renew({ accountId: 'account-a', ownerInstanceId: 'owner-a', fencingToken: acquired.lease.fencingToken })
  assert.equal(one.fencingToken, two.fencingToken)
  assert.equal(two.version, one.version + 1)
})

test('13: stale release is denied without changing current ownership', async () => {
  const { repository, owner } = harness()
  const stale = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'stale', leaseMilliseconds: 100 })
  repository.advanceDatabaseTime(101)
  const current = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'current' })
  const released = await owner.release({ accountId: 'account-a', ownerInstanceId: 'stale', fencingToken: stale.lease.fencingToken })
  assert.equal(released.status, 'stale')
  assert.equal((await owner.get('account-a'))?.fencingToken, current.lease.fencingToken)
})

test('14: crash without release recovers only after expiry', async () => {
  const { repository, owner } = harness()
  await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'crashed', leaseMilliseconds: 100 })
  await rejectsCode(owner.acquire({ accountId: 'account-a', ownerInstanceId: 'recovery' }), 'LEASE_HELD')
  repository.advanceDatabaseTime(101)
  assert.equal((await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'recovery' })).lease.fencingToken, 2n)
})

test('15: database reconnect preserves the durable fence', async () => {
  const { repository, owner } = harness()
  const acquired = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-a' })
  repository.disconnect()
  await rejectsCode(owner.get('account-a'), 'DATABASE_UNAVAILABLE')
  repository.reconnect()
  assert.equal((await owner.get('account-a'))?.fencingToken, acquired.lease.fencingToken)
})

test('16: transaction rollback publishes neither owner nor fencing token', async () => {
  const { repository, owner } = harness()
  repository.rollbackNextTransaction()
  await rejectsCode(owner.acquire({ accountId: 'account-a', ownerInstanceId: 'rolled-back' }), 'DATABASE_FAILURE')
  assert.equal(await owner.get('account-a'), null)
  assert.equal((await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'winner' })).lease.fencingToken, 1n)
})

test('17: row lock timeout is bounded and classified', async () => {
  const { repository, owner } = harness()
  repository.timeoutNextLock()
  await rejectsCode(owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner-a' }), 'LOCK_TIMEOUT')
  assert.equal(await owner.get('account-a'), null)
})

test('18: one hundred competing owners produce one authority winner', async () => {
  const { owner } = harness()
  const outcomes = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => owner.acquire({
    accountId: 'account-a', ownerInstanceId: `owner-${index}`, leaseMilliseconds: 1000,
  })))
  const winners = outcomes.filter((result): result is PromiseFulfilledResult<Awaited<ReturnType<typeof owner.acquire>>> => result.status === 'fulfilled')
  assert.equal(winners.length, 1)
  const proofs = await Promise.allSettled(Array.from({ length: 100 }, (_, index) => owner.verifyImmediatelyBeforeSender({
    accountId: 'account-a', ownerInstanceId: `owner-${index}`, fencingToken: 1n,
  })))
  assert.equal(proofs.filter(result => result.status === 'fulfilled').length, 1)
})

test('19: delayed request after takeover has zero sender wins', async () => {
  const { repository, owner } = harness()
  const delayed = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'delayed', leaseMilliseconds: 100 })
  repository.advanceDatabaseTime(101)
  const current = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'current' })
  const attempts = await Promise.allSettled([
    owner.verifyImmediatelyBeforeSender({ accountId: 'account-a', ownerInstanceId: 'delayed', fencingToken: delayed.lease.fencingToken }),
    owner.verifyImmediatelyBeforeSender({ accountId: 'account-a', ownerInstanceId: 'current', fencingToken: current.lease.fencingToken }),
  ])
  assert.deepEqual(attempts.map(result => result.status), ['rejected', 'fulfilled'])
})

test('20: split-brain simulation permits one physical winner, zero stale sends, and zero wrong-account sends', async () => {
  const { repository, owner } = harness()
  const old = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'node-old', leaseMilliseconds: 100 })
  await owner.acquire({ accountId: 'account-b', ownerInstanceId: 'node-b' })
  repository.advanceDatabaseTime(101)
  const current = await owner.acquire({ accountId: 'account-a', ownerInstanceId: 'node-current' })
  const results = await Promise.allSettled([
    owner.verifyImmediatelyBeforeSender({ accountId: 'account-a', ownerInstanceId: 'node-old', fencingToken: old.lease.fencingToken }),
    owner.verifyImmediatelyBeforeSender({ accountId: 'account-a', ownerInstanceId: 'node-current', fencingToken: current.lease.fencingToken }),
    owner.verifyImmediatelyBeforeSender({ accountId: 'account-b', ownerInstanceId: 'node-current', fencingToken: current.lease.fencingToken }),
  ])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal(results[0]!.status, 'rejected')
  assert.equal(results[2]!.status, 'rejected')
})

test('feature flags are independently default-off, exact-account only, and reject wildcard', () => {
  assert.deepEqual(sessionOwnerFeatureFlags('account-a', {}), { persistence: false, acquisition: false, heartbeat: false, senderFencing: false, physicalSender: false })
  const env = {
    [SESSION_OWNER_PERSISTENCE_ACCOUNTS]: 'account-a', [SESSION_OWNER_ACQUISITION_ACCOUNTS]: 'account-a',
    [SESSION_OWNER_HEARTBEAT_ACCOUNTS]: 'account-a', [SESSION_OWNER_SENDER_FENCING_ACCOUNTS]: 'account-a',
    [SESSION_OWNER_PHYSICAL_SENDER_ACCOUNTS]: '*',
  }
  assert.deepEqual(sessionOwnerFeatureFlags('account-a', env), { persistence: true, acquisition: true, heartbeat: true, senderFencing: true, physicalSender: false })
})

test('invalid identities, zero fences, and unbounded leases fail before persistence', async () => {
  const { owner } = harness()
  await rejectsCode(owner.acquire({ accountId: '*', ownerInstanceId: 'owner' }), 'INVALID_INPUT')
  await rejectsCode(owner.acquire({ accountId: 'account-a', ownerInstanceId: 'owner', leaseMilliseconds: 99 }), 'INVALID_INPUT')
  await rejectsCode(owner.release({ accountId: 'account-a', ownerInstanceId: 'owner', fencingToken: 0n }), 'INVALID_INPUT')
})
