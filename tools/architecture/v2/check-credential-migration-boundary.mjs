#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..')
const artifact = JSON.parse(await readFile(path.join(root, 'architecture/recovery/whole-project-dod/v2/CREDENTIAL_DYNAMIC_MIGRATION_BOUNDARY_20260811.json'), 'utf8'))
assert.equal(artifact.summary.material_credential_unresolved, 0)
assert.equal(artifact.summary.credential_row_dml_found, 0)

const sensitiveTable = '(?:ApiConnection|TelegramConnection|WhatsAppConnection|MaxConnection|AiAgentConfig|AiProviderSetting|Bot|Account|cookies|avito_accounts|avito_app_settings|avito_auth_users|avito_auth_sessions)'
const rowDml = new RegExp(`(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+["']?${sensitiveTable}\\b`, 'iu')
const migrationRoot = path.join(root, 'gravity-mvp/prisma/migrations')
const migrationFiles = []
for (const name of await readdir(migrationRoot)) {
  const file = path.join(migrationRoot, name, 'migration.sql')
  try {
    const source = await readFile(file, 'utf8')
    assert.equal(rowDml.test(source), false, `credential row DML in ${path.relative(root, file)}`)
    migrationFiles.push(file)
  } catch (error) {
    if (!['ENOENT', 'ENOTDIR'].includes(error?.code)) throw error
  }
}
assert.ok(migrationFiles.length > 0)
console.log(`credential-migration-boundary: PASS (${migrationFiles.length} tracked migration files; 0 credential-row DML)`)
