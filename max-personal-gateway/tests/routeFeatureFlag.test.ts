import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_ROUTE_REGISTRY_FEATURE_FLAG,
  createRouteRegistryFeatureFlag,
} from '../src/route/featureFlag.ts'

test('MAX_ROUTE_REGISTRY_ENABLED defaults false and enablement is strictly account scoped', () => {
  assert.equal(MAX_ROUTE_REGISTRY_FEATURE_FLAG, 'MAX_ROUTE_REGISTRY_ENABLED')
  assert.equal(createRouteRegistryFeatureFlag().isEnabled('account-a'), false)
  const flag = createRouteRegistryFeatureFlag('account-a,account-a,account-c')
  assert.equal(flag.isEnabled('account-a'), true)
  assert.equal(flag.isEnabled('account-b'), false)
  assert.equal(flag.isEnabled('account-c'), true)
})

test('route feature flag fails closed for empty, whitespace, invalid, wildcard, and boolean values', () => {
  for (const value of ['', '   ', '*', 'true', 'false', 'account-a,invalid account']) {
    assert.equal(createRouteRegistryFeatureFlag(value).isEnabled('account-a'), false)
  }
  assert.equal(createRouteRegistryFeatureFlag('account-a').isEnabled(' account-a '), false)
})
