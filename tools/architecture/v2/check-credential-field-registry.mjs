#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { CREDENTIAL_ENTITY_POLICIES } from './credential-analyzer.mjs'

const modulePath = fileURLToPath(import.meta.url)
const repositoryRoot = path.resolve(path.dirname(modulePath), '../../..')
const registryPath = path.join(
  repositoryRoot,
  'architecture/recovery/whole-project-dod/v2/CREDENTIAL_SENSITIVE_FIELD_REGISTRY.json',
)
const registry = JSON.parse(await readFile(registryPath, 'utf8'))
assert.equal(registry.schema, 'yoko.crm.credential-sensitive-field-registry.v1')
assert.ok(Array.isArray(registry.records) && registry.records.length > 0)

const policyById = new Map(CREDENTIAL_ENTITY_POLICIES.map((policy) => [policy.id, policy]))
const seen = new Set()
for (const record of registry.records) {
  assert.equal(seen.has(record.policy_id), false, `duplicate registry policy: ${record.policy_id}`)
  seen.add(record.policy_id)
  const policy = policyById.get(record.policy_id)
  assert.ok(policy, `registry policy is not implemented by analyzer: ${record.policy_id}`)
  assert.equal(record.entity, policy.entity)
  assert.equal(record.owner_context, policy.owner_context)
  assert.deepEqual([...record.sensitive_fields].sort(), [...policy.sensitive_fields].sort())
  assert.ok(Array.isArray(record.approved_capabilities) && record.approved_capabilities.length > 0)
  assert.equal(Object.hasOwn(record, 'value'), false)
  assert.equal(Object.hasOwn(record, 'secret'), false)
  assert.equal(Object.hasOwn(record, 'ciphertext'), false)
}
assert.deepEqual([...seen].sort(), [...policyById.keys()].sort(), 'registry/policy set drift')

console.log(`credential-field-registry: PASS (${registry.records.length} policies)`)
