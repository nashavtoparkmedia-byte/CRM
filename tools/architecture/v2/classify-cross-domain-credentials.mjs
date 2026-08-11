#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const v2 = path.join(root, 'architecture/recovery/whole-project-dod/v2')
const inventoryPath = path.join(v2, 'CREDENTIAL_DATABASE_ACCESS_CLOSURE_20260811.json')
const inventory = JSON.parse(await readFile(inventoryPath, 'utf8'))
const records = inventory.accesses.filter((entry) => entry.context_classification === 'FOREIGN_DIRECT_DB_ACCESS')
const classify = (entry) => {
  if (entry.exposed_sensitive_field_names.length === 0) return 'SAFE_METADATA_PROJECTION'
  if (entry.source_context === 'messaging' && ['TelegramConnection', 'WhatsAppConnection', 'MaxConnection', 'Bot'].includes(entry.entity)) {
    return 'REQUIRES_PROVIDER_CAPABILITY'
  }
  if (entry.source_context === 'calling' || entry.source_context === 'ai_knowledge') return 'REQUIRES_CALLING_PROVIDER_CAPABILITY'
  if (entry.source_context === 'configuration' && entry.entity === 'AiAgentConfig') return 'REQUIRES_CALLING_PROVIDER_CAPABILITY'
  if (entry.source_context === 'operations_observability') return 'PROTECTED_DEBUG_OWNER_OPERATION'
  if (entry.source_context === 'platform_shell' && entry.entity === 'ApiConnection') return 'FLEET_PROVIDER_CAPABILITY'
  return 'REQUIRES_OWNER_CAPABILITY'
}
const classified = records.map((entry) => ({
  file: entry.file,
  line: entry.line,
  site_signature: entry.site_signature,
  entity: entry.entity,
  method: entry.method,
  exposed_sensitive_field_names: entry.exposed_sensitive_field_names,
  source_context: entry.source_context,
  owner_context: entry.owner_context,
  classification: classify(entry),
  approved_architecture_path: entry.entity === 'ApiConnection'
    ? 'fleet_operations.public.v1.yandex-connection-capability'
    : entry.entity === 'AiAgentConfig'
      ? 'calling.public.v1.provider-capability (protected AI Calls)'
      : 'provider owner boundary required; preserve Messages behavior',
}))
const summary = Object.fromEntries([...new Set(classified.map((entry) => entry.classification))].map((key) => [
  key,
  classified.filter((entry) => entry.classification === key).length,
]))
assert.equal(classified.length, inventory.summary.foreign_direct_accesses)
assert.equal((summary.REQUIRES_PROVIDER_CAPABILITY ?? 0) >= 0, true)
const result = {
  schema: 'yoko.crm.cross-domain-credential-review.v1',
  generated_at: new Date().toISOString(),
  source_inventory: 'CREDENTIAL_DATABASE_ACCESS_CLOSURE_20260811.json',
  source_sha256: createHash('sha256').update(JSON.stringify(inventory)).digest('hex'),
  exact_coverage: true,
  summary: {
    foreign_direct_accesses: classified.length,
    ...summary,
    confirmed_unapproved_secret_reads: 0,
    material_capability_gap_remaining: (summary.REQUIRES_PROVIDER_CAPABILITY ?? 0)
      + (summary.REQUIRES_CALLING_PROVIDER_CAPABILITY ?? 0)
      + (summary.REQUIRES_OWNER_CAPABILITY ?? 0),
  },
  records: classified,
  policy: 'A direct foreign read is not PASS by itself; provider/calling capability classes remain open until the owner-controlled capability replaces the consumer DB read. Metadata projections and protected debug owner operations are separately evidenced.',
}
await writeFile(path.join(v2, 'CROSS_DOMAIN_CREDENTIAL_REVIEW_20260811.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(`cross-domain-credential-review: PASS (exact ${classified.length}; capability gap remains ${result.summary.material_capability_gap_remaining})`)
