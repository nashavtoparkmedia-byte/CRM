#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeSqlMutation } from './sql-mutation-analyzer.mjs'
import { analyzePrismaWriteSites } from './write-analyzer.mjs'

/**
 * This policy contains names only.  It must never contain a credential value,
 * ciphertext, session payload, password hash, or token from an analyzed file.
 */
export const CREDENTIAL_ENTITY_POLICIES = Object.freeze([
  {
    id: 'fleet.api-connection.v1',
    entity: 'ApiConnection',
    aliases: ['ApiConnection', 'apiConnection'],
    owner_context: 'fleet_operations',
    sensitive_fields: ['apiKey'],
  },
  {
    id: 'telegram.connection.v1',
    entity: 'TelegramConnection',
    aliases: ['TelegramConnection', 'telegramConnection'],
    owner_context: 'telegram_channel',
    sensitive_fields: ['apiHash', 'sessionString'],
  },
  {
    id: 'whatsapp.connection.v1',
    entity: 'WhatsAppConnection',
    aliases: ['WhatsAppConnection', 'whatsAppConnection', 'whatsappConnection'],
    owner_context: 'whatsapp_channel',
    sensitive_fields: ['sessionData'],
  },
  {
    id: 'max.connection.v1',
    entity: 'MaxConnection',
    aliases: ['MaxConnection', 'maxConnection'],
    owner_context: 'max_channel',
    sensitive_fields: ['botToken'],
  },
  {
    id: 'calling.ai-agent-config.v1',
    entity: 'AiAgentConfig',
    aliases: ['AiAgentConfig', 'aiAgentConfig'],
    owner_context: 'calling',
    sensitive_fields: ['apiKeyEncrypted'],
  },
  {
    id: 'calling.ai-provider-setting.v1',
    entity: 'AiProviderSetting',
    aliases: ['AiProviderSetting', 'aiProviderSetting'],
    owner_context: 'calling',
    sensitive_fields: ['encryptedValue'],
  },
  {
    id: 'telegram.bot-token.v1',
    entity: 'Bot',
    aliases: ['Bot', 'bot', 'bots'],
    owner_context: 'telegram_channel',
    sensitive_fields: ['token'],
  },
  {
    id: 'fleet.yfs-account.v1',
    entity: 'Account',
    aliases: ['Account', 'account', 'accounts'],
    owner_context: 'fleet_operations',
    sensitive_fields: ['storageStateEncrypted', 'proxyConfig'],
  },
  {
    id: 'avito.application-settings.v1',
    entity: 'avito_app_settings',
    aliases: ['avito_app_settings', 'appSettings'],
    owner_context: 'avito_acquisition',
    // `value` is conditionally secret according to `key`; a static reader of
    // the value cannot prove that it selected a non-secret setting.
    sensitive_fields: ['value'],
    discriminator_fields: ['key'],
  },
  {
    id: 'avito.password-hash.v1',
    entity: 'avito_auth_users',
    aliases: ['avito_auth_users', 'authUsers'],
    owner_context: 'avito_acquisition',
    sensitive_fields: ['password_hash', 'passwordHash'],
  },
  {
    id: 'avito.session-token.v1',
    entity: 'avito_auth_sessions',
    aliases: ['avito_auth_sessions', 'authSessions'],
    owner_context: 'avito_acquisition',
    // The primary key is the bearer session token in the legacy worker ABI.
    sensitive_fields: ['id'],
  },
])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeName(value) {
  if (typeof value !== 'string') return ''
  const finalComponent = value.split('.').at(-1) ?? value
  return finalComponent.replace(/["'`\[\]]/gu, '').replace(/_/gu, '').toLowerCase()
}

function policyIndex(policies) {
  const index = new Map()
  for (const policy of policies) {
    for (const alias of [policy.entity, ...(policy.aliases ?? [])]) {
      const key = normalizeName(alias)
      const existing = index.get(key)
      if (existing && existing.id !== policy.id) {
        throw new Error(`credential entity alias collision: ${alias}`)
      }
      index.set(key, policy)
    }
  }
  return index
}

function uniquePolicies(names, index) {
  const result = new Map()
  for (const name of names.filter(Boolean)) {
    const policy = index.get(normalizeName(name))
    if (policy) result.set(policy.id, policy)
  }
  return [...result.values()].sort((left, right) => left.id.localeCompare(right.id))
}

function fieldSet(fields) {
  return new Set((fields ?? []).map(normalizeName).filter(Boolean))
}

function exposedFieldsForProjection(policy, projection) {
  const sensitive = policy.sensitive_fields ?? []
  if (!projection) return { exposed: sensitive, ambiguous: true, reason: 'missing_read_projection' }
  const selected = fieldSet(projection.selected_fields)
  const omitted = fieldSet(projection.omitted_fields)
  if (projection.dynamic) {
    return { exposed: sensitive, ambiguous: true, reason: 'dynamic_read_projection' }
  }
  if (projection.mode === 'AGGREGATE') return { exposed: [], ambiguous: false, reason: null }
  if (projection.mode === 'SELECT') {
    return {
      exposed: sensitive.filter((field) => selected.has(normalizeName(field))),
      ambiguous: false,
      reason: null,
    }
  }
  if (projection.mode === 'OMIT') {
    return {
      exposed: sensitive.filter((field) => !omitted.has(normalizeName(field))),
      ambiguous: false,
      reason: null,
    }
  }
  return { exposed: sensitive, ambiguous: false, reason: null }
}

function exposedFieldsForRaw(policy, site) {
  if (site.dynamic || site.ambiguous || site.read_projection_dynamic) {
    return { exposed: policy.sensitive_fields, ambiguous: true, reason: 'dynamic_raw_sql_projection' }
  }
  if (site.select_all) return { exposed: policy.sensitive_fields, ambiguous: false, reason: null }
  const selected = fieldSet(site.selected_columns)
  return {
    exposed: policy.sensitive_fields.filter((field) => selected.has(normalizeName(field))),
    ambiguous: false,
    reason: null,
  }
}

function publicBoundary(fileName, sourceText) {
  const normalized = fileName.split(path.sep).join('/')
  const route = /(?:^|\/)src\/(?:app|pages)\/(?:api\/|.*(?:actions?|route)\.[cm]?[jt]sx?$)/u.test(normalized)
  const serverAction = /^\s*['"]use server['"];?/mu.test(sourceText)
  return { route, server_action: serverAction, possible_browser_boundary: route || serverAction }
}

function baseRecord(site, policy, access, exposure, boundary) {
  const exposed = [...new Set(exposure.exposed ?? [])].sort()
  const ambiguous = Boolean(site.ambiguous || exposure.ambiguous)
  return {
    file: site.file,
    line: site.line,
    column: site.column,
    scope: site.scope,
    site_signature: site.site_signature,
    access,
    method: site.method,
    entity: policy.entity,
    policy_id: policy.id,
    owner_context: policy.owner_context,
    sensitive_field_names: [...policy.sensitive_fields].sort(),
    exposed_sensitive_field_names: exposed,
    credential_exposure: access === 'WRITE'
      ? 'CREDENTIAL_RECORD_WRITE'
      : exposed.length > 0 ? 'SECRET_READ' : ambiguous ? 'AMBIGUOUS' : 'METADATA_ONLY',
    ambiguous,
    ambiguity_reasons: [...new Set([
      ...(site.ambiguity_reasons ?? []),
      ...(exposure.reason ? [exposure.reason] : []),
    ])].sort(),
    public_boundary: boundary.possible_browser_boundary,
    public_secret_risk: boundary.possible_browser_boundary && (exposed.length > 0 || ambiguous),
  }
}

function unresolvedRecord(site, boundary, reason) {
  return {
    file: site.file,
    line: site.line,
    column: site.column,
    scope: site.scope,
    site_signature: site.site_signature,
    access: 'UNKNOWN',
    method: site.method,
    entity: null,
    policy_id: null,
    owner_context: null,
    sensitive_field_names: [],
    exposed_sensitive_field_names: [],
    credential_exposure: 'AMBIGUOUS',
    ambiguous: true,
    ambiguity_reasons: [...new Set([
      ...(site.ambiguity_reasons ?? []),
      reason,
    ])].sort(),
    public_boundary: boundary.possible_browser_boundary,
    public_secret_risk: boundary.possible_browser_boundary,
  }
}

/**
 * Inventory credential database access without retaining source snippets or
 * runtime values. The returned document contains entity and field names only.
 */
export function analyzeCredentialAccess(sourceText, options = {}) {
  const fileName = options.fileName ?? '<source.ts>'
  const policies = options.policies ?? CREDENTIAL_ENTITY_POLICIES
  const index = policyIndex(policies)
  const boundary = publicBoundary(fileName, sourceText)
  const analyzed = analyzePrismaWriteSites(sourceText, {
    fileName,
    includeReads: true,
    includeRawReads: true,
  })
  const accesses = []

  for (const site of analyzed.sites) {
    if (site.kind === 'model_read' || site.kind === 'ambiguous_read') {
      const matches = uniquePolicies([site.model, ...(site.candidate_models ?? [])], index)
      for (const policy of matches) {
        accesses.push(baseRecord(site, policy, 'READ', exposedFieldsForProjection(policy, site.projection), boundary))
      }
      if (matches.length === 0 && site.ambiguous) {
        accesses.push(unresolvedRecord(site, boundary, 'unresolved_model_read_may_access_credential_entity'))
      }
      continue
    }

    if (site.kind === 'raw') {
      const readPolicies = uniquePolicies(site.read_tables ?? [], index)
      for (const policy of readPolicies) {
        accesses.push(baseRecord(site, policy, 'READ', exposedFieldsForRaw(policy, site), boundary))
      }
      const writePolicies = uniquePolicies(site.tables ?? [], index)
        .filter((policy) => !readPolicies.some((readPolicy) => readPolicy.id === policy.id) || (site.operations ?? []).length > 0)
      for (const policy of writePolicies) {
        if ((site.operations ?? []).length === 0) continue
        accesses.push(baseRecord(site, policy, 'WRITE', {
          exposed: policy.sensitive_fields,
          ambiguous: Boolean(site.ambiguous),
          reason: site.ambiguous ? 'dynamic_credential_record_write' : null,
        }, boundary))
      }
      if (
        options.failClosedUnknownRaw !== false
        && site.ambiguous
        && (site.tables ?? []).length === 0
        && (site.read_tables ?? []).length === 0
      ) {
        accesses.push(unresolvedRecord(site, boundary, 'unresolved_raw_sql_may_access_credential_entity'))
      }
      continue
    }

    if (site.kind === 'model' || site.kind === 'ambiguous_model' || site.kind === 'drizzle') {
      const matches = uniquePolicies([site.model, ...(site.candidate_models ?? [])], index)
      for (const policy of matches) {
        accesses.push(baseRecord(site, policy, 'WRITE', {
          exposed: policy.sensitive_fields,
          ambiguous: Boolean(site.ambiguous),
          reason: site.ambiguous ? 'dynamic_credential_record_write' : null,
        }, boundary))
      }
      if (matches.length === 0 && site.ambiguous) {
        accesses.push(unresolvedRecord(site, boundary, 'unresolved_model_write_may_access_credential_entity'))
      }
    }
  }

  accesses.sort((left, right) => (
    left.line - right.line
    || left.column - right.column
    || String(left.policy_id).localeCompare(String(right.policy_id))
    || left.access.localeCompare(right.access)
  ))
  return {
    schema: 'yoko.crm.credential-database-access.v2',
    file: fileName,
    source_sha256: sha256(sourceText),
    safety: 'names and structural access metadata only; credential values and source excerpts are never emitted',
    boundary,
    accesses,
    diagnostics: analyzed.diagnostics,
  }
}

/** Analyze a standalone or extracted SQL fragment using the same policy. */
export function analyzeCredentialSqlAccess(sql, options = {}) {
  const fileName = options.fileName ?? '<source.sql>'
  const policies = options.policies ?? CREDENTIAL_ENTITY_POLICIES
  const index = policyIndex(policies)
  const analysis = analyzeSqlMutation(sql, { forceDynamic: Boolean(options.forceDynamic) })
  const position = {
    file: fileName,
    line: options.line ?? 1,
    column: options.column ?? 1,
    scope: options.scope ?? '<sql-script>',
    site_signature: sha256(`${fileName}\n${analysis.sql_sha256 ?? '<dynamic-sql>'}\n${options.ordinal ?? 0}`),
    method: options.method ?? 'sql-script',
    operations: analysis.operations,
    tables: analysis.tables,
    read_tables: analysis.read_tables ?? [],
    selected_columns: analysis.selected_columns ?? [],
    select_all: Boolean(analysis.select_all),
    read_projection_dynamic: Boolean(analysis.read_projection_dynamic),
    dynamic: analysis.dynamic,
    ambiguous: analysis.ambiguous,
    ambiguity_reasons: analysis.reasons ?? [],
  }
  const boundary = {
    route: false,
    server_action: false,
    possible_browser_boundary: Boolean(options.publicBoundary),
  }
  const accesses = []
  const readPolicies = uniquePolicies(position.read_tables, index)
  for (const policy of readPolicies) {
    accesses.push(baseRecord(position, policy, 'READ', exposedFieldsForRaw(policy, position), boundary))
  }
  for (const policy of uniquePolicies(position.tables, index)) {
    if (analysis.operations.length === 0) continue
    accesses.push(baseRecord(position, policy, 'WRITE', {
      exposed: policy.sensitive_fields,
      ambiguous: analysis.ambiguous,
      reason: analysis.ambiguous ? 'dynamic_credential_record_write' : null,
    }, boundary))
  }
  if (
    options.failClosedUnknownRaw !== false
    && analysis.ambiguous
    && position.tables.length === 0
    && position.read_tables.length === 0
  ) {
    accesses.push({
      file: fileName,
      line: position.line,
      column: position.column,
      scope: position.scope,
      site_signature: position.site_signature,
      access: 'UNKNOWN',
      method: position.method,
      entity: null,
      policy_id: null,
      owner_context: null,
      sensitive_field_names: [],
      exposed_sensitive_field_names: [],
      credential_exposure: 'AMBIGUOUS',
      ambiguous: true,
      ambiguity_reasons: [...new Set([
        ...position.ambiguity_reasons,
        'unresolved_raw_sql_may_access_credential_entity',
      ])].sort(),
      public_boundary: boundary.possible_browser_boundary,
      public_secret_risk: boundary.possible_browser_boundary,
    })
  }
  return {
    schema: 'yoko.crm.credential-sql-access.v2',
    file: fileName,
    sql_sha256: analysis.sql_sha256,
    safety: 'structural SQL access metadata and field names only; SQL text and credential values are never emitted',
    accesses,
  }
}

async function main() {
  const files = process.argv.slice(2)
  if (files.length === 0) throw new Error('usage: credential-analyzer.mjs <source-file> [...]')
  const documents = []
  for (const file of files) {
    const sourceText = await readFile(file, 'utf8')
    documents.push(analyzeCredentialAccess(sourceText, { fileName: file.split(path.sep).join('/') }))
  }
  process.stdout.write(`${JSON.stringify({
    schema: 'yoko.crm.credential-database-access-set.v2',
    policies: CREDENTIAL_ENTITY_POLICIES.map((policy) => ({
      id: policy.id,
      entity: policy.entity,
      owner_context: policy.owner_context,
      sensitive_field_names: [...policy.sensitive_fields].sort(),
    })),
    documents,
  }, null, 2)}\n`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`)
    process.exitCode = 1
  })
}
