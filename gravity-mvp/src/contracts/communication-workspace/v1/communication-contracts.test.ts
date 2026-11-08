import { describe, expect, it } from 'vitest'
import {
  HOST_AUDIENCE_SUBMISSION_V1,
  START_COMMUNICATION_RUN_COMMAND_V1,
  parseHostAudienceSubmissionV1,
  parseStartCommunicationRunCommandV1,
} from '.'

const submission = {
  contract: HOST_AUDIENCE_SUBMISSION_V1,
  hostModule: 'churn',
  triggerKey: 'fleet.churn.no_orders_days',
  triggerVersion: 1,
  snapshotRef: 'churn-ui:abc',
  evaluatedAt: '2026-11-08T12:00:00.000Z',
  criteria: { minInactiveDays: 5 },
  members: [{ contactId: 'c1', reason: 'Нет заказов 7 дн.', sourceRef: 'driver:d1', businessContext: { displayName: 'Иван', inactiveDays: 7 } }],
}

describe('communication-workspace contracts v1', () => {
  it('the host says WHO and WHY only: no chat, provider, route or phone crosses the contract', () => {
    expect(parseHostAudienceSubmissionV1(submission).members).toHaveLength(1)
    for (const leak of ['chatId', 'phone', 'providerAccountId', 'route']) {
      expect(() => parseHostAudienceSubmissionV1({ ...submission, members: [{ ...submission.members[0], [leak]: 'x' }] })).toThrow('not part of the contract')
    }
    expect(() => parseHostAudienceSubmissionV1({ ...submission, [`channel`]: 'telegram' })).toThrow('not part of the contract')
    expect(() => parseHostAudienceSubmissionV1({ ...submission, members: [{ ...submission.members[0], businessContext: { nested: { a: 1 } } }] })).toThrow()
  })

  it('a sandbox Run needs an allowlist; a live Run takes no sandbox configuration', () => {
    const base = { contract: START_COMMUNICATION_RUN_COMMAND_V1, projectKey: 'churn-return-v1', audience: submission, requestedBy: 'x' }
    expect(() => parseStartCommunicationRunCommandV1({ ...base, mode: 'sandbox', sandbox: null })).toThrow('test configuration')
    expect(() => parseStartCommunicationRunCommandV1({ ...base, mode: 'sandbox', sandbox: { allowlistContactIds: [], waitSecondsOverride: 1, cooldownSecondsOverride: 1, simulatedOutcomes: {} } })).toThrow('1 to 20')
    expect(() => parseStartCommunicationRunCommandV1({ ...base, mode: 'live', sandbox: { allowlistContactIds: ['c1'] } })).toThrow('no sandbox configuration')
    const parsed = parseStartCommunicationRunCommandV1({ ...base, mode: 'sandbox', sandbox: { allowlistContactIds: ['c1', 'c1'], waitSecondsOverride: 5, cooldownSecondsOverride: null, simulatedOutcomes: { c1: { call: 'no_answer' } } } })
    expect(parsed.sandbox).toEqual({ allowlistContactIds: ['c1'], waitSecondsOverride: 5, cooldownSecondsOverride: null, simulatedOutcomes: { c1: { call: 'no_answer' } } })
    expect(() => parseStartCommunicationRunCommandV1({ ...base, mode: 'sandbox', sandbox: { allowlistContactIds: ['c1'], waitSecondsOverride: 5, cooldownSecondsOverride: null, simulatedOutcomes: { c1: { call: 'dial_again' } } } })).toThrow('unknown simulated call outcome')
  })
})
