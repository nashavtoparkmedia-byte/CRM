import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_RAW_JOURNAL_FEATURE_FLAG, createRawJournalFeatureFlag } from '../src/journal/featureFlag.ts'

test('MAX_RAW_JOURNAL_ENABLED defaults false and enablement is account scoped', () => {
  assert.equal(MAX_RAW_JOURNAL_FEATURE_FLAG, 'MAX_RAW_JOURNAL_ENABLED')
  assert.equal(createRawJournalFeatureFlag().isEnabled('account-a'), false)
  const flag = createRawJournalFeatureFlag('account-a, account-c')
  assert.equal(flag.isEnabled('account-a'), true)
  assert.equal(flag.isEnabled('account-b'), false)
  assert.equal(flag.isEnabled('account-c'), true)
})

test('feature flag parsing is fail-closed for empty, wildcard, boolean, whitespace, duplicate, and invalid values', () => {
  assert.equal(createRawJournalFeatureFlag('').isEnabled('account-a'), false)
  assert.equal(createRawJournalFeatureFlag('   ').isEnabled('account-a'), false)
  assert.equal(createRawJournalFeatureFlag('*').isEnabled('account-a'), false)
  assert.equal(createRawJournalFeatureFlag('true').isEnabled('account-a'), false)
  assert.equal(createRawJournalFeatureFlag('account-a,account-a').isEnabled('account-a'), true)
  assert.equal(createRawJournalFeatureFlag('account-a,invalid account').isEnabled('account-a'), false)
  assert.equal(createRawJournalFeatureFlag('account-a').isEnabled(' account-a '), false)
})
