#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const authorityPath = path.join(root, 'architecture/migrations/v1/production-migration-authority.json')
const runtimeArtifact = '/opt/codex-work/crm-arch-000-evidence/crm-arch-000r/20260808T204949Z-operator/raw/runtime.json'
const unavailableTimestampEvidence = '/opt/codex-work/crm-arch-000-evidence/crm-arch-000r/20260808T204949Z-operator/raw/db-migration.json'
const outboxAcceptanceArtifact = 'architecture/recovery/whole-project-dod/v2/PRODUCTION_ACTIVATION_ACCEPTANCE_20260812.json'
const outboxLedgerDigest = 'a50f1a8988f79c85059354d6b2d45e9e8ed07284fc27c78d98face6680f25dfc'

const authority = JSON.parse(await readFile(authorityPath, 'utf8'))
for (const [index, row] of authority.migrations.entries()) {
  row.canonical_ordinal = index + 1
  const proof = row.name === authority.current_target.name
    ? {
        kind: 'post_outbox_runtime_database_status',
        acceptance_artifact: outboxAcceptanceArtifact,
        runtime_package_version: '2.0.0-9',
        migration_count: 62,
        migration_ledger_sha256: outboxLedgerDigest,
        migration_state: 'APPROVED_OUTBOX_APPLIED',
        outbox_catalog_state: 'EXACT',
      }
    : {
        kind: 'exact_finite_predecessor_runtime_inventory',
        runtime_artifact: runtimeArtifact,
        observed_at: '2026-08-08T20:50:42Z',
        image_migration_rows: 62,
        normalized_pre_outbox_digest: authority.predecessor_runtime.normalized_pre_outbox_digest,
      }
  row.live_ledger = {
    status: 'FINISHED_ACTIVE',
    proof,
    applied_timestamp: {
      value: null,
      availability: 'UNAVAILABLE',
      provenance: `${unavailableTimestampEvidence}: DATABASE_IDENTITY_PROBE_FAILED`,
    },
  }
}
await writeFile(authorityPath, `${JSON.stringify(authority, null, 2)}\n`)
