#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { analyzeSqlMutation, tokenizeSql } from './sql-mutation-analyzer.mjs'
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
    id: 'messaging.legacy-connection-credentials.v1',
    entity: 'MessagingConnection',
    aliases: ['MessagingConnection', 'messagingConnection'],
    owner_context: 'messaging',
    sensitive_fields: ['credentials'],
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
    // Do not claim a generic plural `accounts`: the Avito context exports a
    // Drizzle symbol with that name for the unrelated avito_accounts table.
    aliases: ['Account', 'account'],
    owner_context: 'fleet_operations',
    sensitive_fields: ['storageStateEncrypted', 'proxyConfig'],
  },
  {
    id: 'fleet.chrome-cookie-store.v1',
    entity: 'cookies',
    aliases: ['cookies', 'ChromeCookie'],
    owner_context: 'fleet_operations',
    sensitive_fields: ['encrypted_value'],
  },
  {
    id: 'avito.account-browser-session.v1',
    entity: 'avito_accounts',
    aliases: ['avito_accounts', 'accounts'],
    owner_context: 'avito_acquisition',
    // The path names the persistent Chromium profile containing provider
    // authentication/session state.  It is capability-bearing metadata.
    sensitive_fields: ['profilePath'],
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

export function parsePrismaRelations(schemaText) {
  const models = new Map()
  for (const match of schemaText.matchAll(/^model\s+([A-Za-z_][\w]*)\s*\{([\s\S]*?)^\}/gmu)) {
    models.set(match[1], match[2])
  }
  const modelNames = new Set(models.keys())
  const relations = new Map()
  for (const [model, body] of models) {
    for (const line of body.split('\n')) {
      const field = /^\s*([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*)(?:\[\]|\?)?/u.exec(line)
      if (!field || !modelNames.has(field[2])) continue
      relations.set(`${normalizeName(model)}.${normalizeName(field[1])}`, field[2])
    }
  }
  return relations
}

export function parsePrismaModelNames(schemaText) {
  return [...schemaText.matchAll(/^model\s+([A-Za-z_][\w]*)\s*\{/gmu)].map((match) => match[1])
}

function credentialLikeField(field) {
  const normalized = normalizeName(field)
  return /(?:accesskey|apikey|apihash|bottoken|credential|encryptedvalue|passwordhash|password|privatekey|proxyconfig|secret|sessiondata|sessionstring|storagestateencrypted|token)/u.test(normalized)
}

function credentialLikeEntity(entity) {
  const normalized = normalizeName(entity)
  return /(?:auth|browsersession|credential|integrationkey|password|providersession|secret|token)/u.test(normalized)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function locationAtOffset(source, offset, baseLine = 1, baseColumn = 1) {
  const prefix = source.slice(0, offset)
  const lineBreaks = [...prefix.matchAll(/\n/gu)].length
  const lastBreak = prefix.lastIndexOf('\n')
  return {
    line: baseLine + lineBreaks,
    column: lineBreaks === 0 ? baseColumn + offset : offset - lastBreak,
  }
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
  if (projection.mode === 'AGGREGATE') {
    return {
      exposed: sensitive.filter((field) => selected.has(normalizeName(field))),
      ambiguous: false,
      reason: null,
    }
  }
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

function rawProjectionForTable(site, table) {
  const sources = site.selected_column_sources ?? []
  const normalizedTable = normalizeName(table)
  const readTables = [...new Set(site.read_tables ?? [])]
  const tableFields = sources
    .filter((entry) => entry.table && normalizeName(entry.table) === normalizedTable)
    .map((entry) => entry.field)
  const unqualifiedFields = sources.filter((entry) => !entry.table).map((entry) => entry.field)
  const multiTableUnqualified = readTables.length > 1 && unqualifiedFields.length > 0
  return {
    ...site,
    selected_columns: [...new Set([
      ...tableFields,
      ...(readTables.length <= 1 ? unqualifiedFields : []),
    ])].sort(),
    select_all: Boolean(site.select_all && readTables.length <= 1),
    read_projection_dynamic: Boolean(site.read_projection_dynamic || multiTableUnqualified || (site.select_all && readTables.length > 1)),
  }
}

function credentialWriteFieldsForTable(site, table) {
  const normalizedTable = normalizeName(table)
  return [...new Set([
    ...(site.written_columns ?? []).filter(credentialLikeField),
    ...(site.selected_column_sources ?? [])
      .filter((entry) => entry.table && normalizeName(entry.table) === normalizedTable)
      .map((entry) => entry.field)
      .filter(credentialLikeField),
  ])].sort()
}

function publicBoundary(fileName, sourceText) {
  const normalized = fileName.split(path.sep).join('/')
  const nextRoute = /(?:^|\/)(?:src\/)?(?:app|pages)\/(?:api\/|.*(?:actions?|route)\.[cm]?[jt]sx?$)/u.test(normalized)
  const nextRenderedSurface = /(?:^|\/)(?:src\/)?app\/.*(?:layout|page)\.[cm]?[jt]sx?$/u.test(normalized)
    || /(?:^|\/)(?:src\/)?pages\/(?!api\/).+\.[cm]?[jt]sx?$/u.test(normalized)
  const routeModule = /(?:^|\/)(?:src\/)?(?:routes?|controllers?)(?:\/|$)/u.test(normalized)
    || /(?:^|\/)(?:src\/)?(?:api|server)\.[cm]?[jt]sx?$/u.test(normalized)
  const routeRegistration = /\.\s*(?:delete|get|head|options|patch|post|put)\s*\(\s*['"`]\//u.test(sourceText)
    || /\.\s*route\s*\(\s*(?:['"`]\/|\{)/u.test(sourceText)
  const route = nextRoute || nextRenderedSurface || routeModule || routeRegistration
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

function unresolvedRecord(site, boundary, reason, options = {}) {
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
    candidate_entities: [...new Set(options.candidateEntities ?? [])].filter(Boolean).sort(),
    intended_access: options.intendedAccess ?? 'UNKNOWN',
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

function deduplicateCredentialAccesses(accesses) {
  const exposureRank = new Map([
    ['METADATA_ONLY', 0],
    ['AMBIGUOUS', 1],
    ['SECRET_READ', 2],
    ['CREDENTIAL_RECORD_WRITE', 3],
  ])
  const unique = new Map()
  for (const access of accesses) {
    const key = `${access.file}\n${access.site_signature}\n${access.policy_id ?? '<null>'}\n${access.access}`
    const prior = unique.get(key)
    if (!prior) {
      unique.set(key, access)
      continue
    }
    const intended = new Set([prior.intended_access, access.intended_access].filter(Boolean))
    const merged = {
      ...prior,
      candidate_entities: [...new Set([
        ...(prior.candidate_entities ?? []),
        ...(access.candidate_entities ?? []),
      ])].sort(),
      intended_access: intended.size > 1 ? 'READ_OR_WRITE' : [...intended][0],
      sensitive_field_names: [...new Set([
        ...(prior.sensitive_field_names ?? []),
        ...(access.sensitive_field_names ?? []),
      ])].sort(),
      exposed_sensitive_field_names: [...new Set([
        ...(prior.exposed_sensitive_field_names ?? []),
        ...(access.exposed_sensitive_field_names ?? []),
      ])].sort(),
      ambiguous: Boolean(prior.ambiguous || access.ambiguous),
      ambiguity_reasons: [...new Set([
        ...(prior.ambiguity_reasons ?? []),
        ...(access.ambiguity_reasons ?? []),
      ])].sort(),
      public_boundary: Boolean(prior.public_boundary || access.public_boundary),
      public_secret_risk: Boolean(prior.public_secret_risk || access.public_secret_risk),
      credential_exposure: (exposureRank.get(access.credential_exposure) ?? -1) > (exposureRank.get(prior.credential_exposure) ?? -1)
        ? access.credential_exposure
        : prior.credential_exposure,
    }
    unique.set(key, merged)
  }
  return [...unique.values()]
}

/**
 * Inventory credential database access without retaining source snippets or
 * runtime values. The returned document contains entity and field names only.
 */
export function analyzeCredentialAccess(sourceText, options = {}) {
  // TypeScript treats angle-bracket pseudo paths as a different script shape;
  // a normal default name keeps symbol/alias resolution identical to scans
  // that supply a repository path.
  const fileName = options.fileName ?? 'architecture-credential-scan.ts'
  const policies = options.policies ?? CREDENTIAL_ENTITY_POLICIES
  const index = policyIndex(policies)
  const boundary = publicBoundary(fileName, sourceText)
  const analyzed = analyzePrismaWriteSites(sourceText, {
    fileName,
    includeReads: true,
    includeRawReads: true,
    knownModels: options.knownModels ?? [],
    relationMap: options.relationMap ?? new Map(),
  })
  const accesses = []

  const relationMap = options.relationMap ?? new Map()
  const fieldDerivedPolicy = (model, fields) => ({
    id: `field-derived.${normalizeName(model) || 'unresolved'}.v1`,
    entity: model ?? '<unresolved>',
    owner_context: null,
    sensitive_fields: [...new Set(fields)].sort(),
  })
  const siteAtRelation = (site, relationPath) => ({
    ...site,
    method: `${site.method}:relation:${relationPath.join('.')}`,
    site_signature: sha256(`${site.site_signature}\nrelation:${relationPath.join('.')}`),
  })
  const nestedCredentialMutationMethods = new Set([
    'connectOrCreate', 'create', 'createMany', 'delete', 'deleteMany',
    'dynamic', 'update', 'updateMany', 'upsert',
  ])
  const appendNestedWriteAccesses = (site, parentModels) => {
    for (const nested of site.nested_operations ?? []) {
      if (!nestedCredentialMutationMethods.has(nested.method)) continue
      const nestedSite = {
        ...siteAtRelation(site, ['nested-write', nested.path]),
        method: `${site.method}:nested-write:${nested.method}`,
        ambiguous: Boolean(nested.payload_dynamic),
        ambiguity_reasons: nested.payload_dynamic ? ['dynamic_nested_write_payload'] : [],
      }
      const targets = new Set()
      for (const model of parentModels.filter(Boolean)) {
        const target = relationMap.get(`${normalizeName(model)}.${normalizeName(nested.relation_field)}`)
        if (target) targets.add(target)
      }
      if (targets.size === 0) {
        for (const policy of uniquePolicies([nested.relation_field], index)) targets.add(policy.entity)
      }
      const matches = uniquePolicies([...targets], index)
      for (const policy of matches) {
        accesses.push(baseRecord(nestedSite, policy, 'WRITE', {
          exposed: policy.sensitive_fields,
          ambiguous: Boolean(nested.payload_dynamic),
          reason: nested.payload_dynamic ? 'dynamic_credential_record_write' : null,
        }, boundary))
      }
      if (matches.length > 0) continue
      const sensitiveFields = (nested.written_fields ?? []).filter(credentialLikeField)
      if (sensitiveFields.length > 0 && targets.size > 0) {
        const target = [...targets][0]
        const policy = fieldDerivedPolicy(target, sensitiveFields)
        accesses.push(baseRecord(nestedSite, policy, 'WRITE', {
          exposed: sensitiveFields,
          ambiguous: Boolean(nested.payload_dynamic || targets.size > 1),
          reason: nested.payload_dynamic || targets.size > 1 ? 'dynamic_credential_record_write' : null,
        }, boundary))
      } else {
        accesses.push(unresolvedRecord(nestedSite, boundary, 'unresolved_nested_relation_write_may_access_credential_entity', {
          candidateEntities: targets.size > 0 ? [...targets] : [nested.relation_field],
          intendedAccess: 'WRITE',
        }))
      }
    }
  }
  const appendProjectionAccess = (site, models, projection, relationPath = []) => {
    const matches = uniquePolicies(models, index)
    const recordSite = relationPath.length > 0 ? siteAtRelation(site, relationPath) : site
    for (const policy of matches) {
      accesses.push(baseRecord(recordSite, policy, 'READ', exposedFieldsForProjection(policy, projection), boundary))
    }
    if (matches.length === 0) {
      const sensitiveFields = (projection?.selected_fields ?? []).filter(credentialLikeField)
      if (sensitiveFields.length > 0) {
        const policy = fieldDerivedPolicy(models[0] ?? null, sensitiveFields)
        accesses.push(baseRecord(recordSite, policy, 'READ', exposedFieldsForProjection(policy, projection), boundary))
      } else if ((models ?? []).some(credentialLikeEntity)) {
        accesses.push(unresolvedRecord(recordSite, boundary, 'credential_like_model_read_without_registered_policy', {
          candidateEntities: models,
          intendedAccess: 'READ',
        }))
      } else if (projection?.dynamic || site.ambiguous) {
        accesses.push(unresolvedRecord(recordSite, boundary, relationPath.length > 0
          ? 'unresolved_relation_read_may_access_credential_entity'
          : 'unresolved_model_read_may_access_credential_entity', {
          candidateEntities: models,
          intendedAccess: 'READ',
        }))
      }
    }

    for (const nested of projection?.nested_relations ?? []) {
      // Prisma's synthetic `_count` projection returns relation cardinalities,
      // never rows or fields from the related credential entity. Treating it
      // as a relation read manufactures secret-exposure debt for count-only
      // projections without improving fail-closed coverage.
      if (nested.relation === '_count') continue
      const nestedPath = [...relationPath, nested.relation]
      if (nested.relation === '<dynamic>') {
        accesses.push(unresolvedRecord(siteAtRelation(site, nestedPath), boundary, 'dynamic_relation_read_may_access_credential_entity', {
          candidateEntities: ['<dynamic>'],
          intendedAccess: 'READ',
        }))
        continue
      }
      const targets = new Set()
      for (const model of models.filter(Boolean)) {
        const target = relationMap.get(`${normalizeName(model)}.${normalizeName(nested.relation)}`)
        if (target) targets.add(target)
      }
      if (targets.size === 0) {
        for (const policy of uniquePolicies([nested.relation], index)) targets.add(policy.entity)
      }
      if (targets.size === 0) {
        const sensitiveFields = (nested.projection?.selected_fields ?? []).filter(credentialLikeField)
        if (sensitiveFields.length > 0 || nested.projection?.dynamic || (nested.projection?.nested_relations ?? []).length > 0) {
          const nestedSite = siteAtRelation(site, nestedPath)
          if (sensitiveFields.length > 0) {
            const policy = fieldDerivedPolicy(nested.relation, sensitiveFields)
            accesses.push(baseRecord(nestedSite, policy, 'READ', exposedFieldsForProjection(policy, nested.projection), boundary))
          } else {
            accesses.push(unresolvedRecord(nestedSite, boundary, 'unresolved_relation_read_may_access_credential_entity', {
              candidateEntities: [nested.relation],
              intendedAccess: 'READ',
            }))
          }
        }
        continue
      }
      appendProjectionAccess(site, [...targets], nested.projection, nestedPath)
    }
  }

  for (const site of analyzed.sites) {
    if (site.kind === 'model_read' || site.kind === 'ambiguous_read') {
      let models = [site.model, ...(site.candidate_models ?? [])].filter(Boolean)
      if (site.relation_parent_model && site.relation_name) {
        const target = relationMap.get(`${normalizeName(site.relation_parent_model)}.${normalizeName(site.relation_name)}`)
        if (target) models = [target]
      }
      appendProjectionAccess(site, models, site.projection)
      continue
    }

    if (site.kind === 'raw') {
      const readPolicies = uniquePolicies(site.read_tables ?? [], index)
      const seenReadPolicies = new Set()
      for (const table of site.read_tables ?? []) {
        for (const policy of uniquePolicies([table], index)) {
          if (seenReadPolicies.has(policy.id)) continue
          seenReadPolicies.add(policy.id)
          const tableSite = rawProjectionForTable(site, table)
          accesses.push(baseRecord(tableSite, policy, 'READ', exposedFieldsForRaw(policy, tableSite), boundary))
        }
      }
      const unmatchedReadTables = (site.read_tables ?? []).filter((table) => uniquePolicies([table], index).length === 0)
      for (const table of unmatchedReadTables) {
        const tableSite = rawProjectionForTable(site, table)
        if (tableSite.read_projection_dynamic) {
          continue
        }
        const derivedReadFields = (tableSite.selected_columns ?? []).filter(credentialLikeField)
        if (derivedReadFields.length > 0) {
          const policy = fieldDerivedPolicy(table, derivedReadFields)
          accesses.push(baseRecord(tableSite, policy, 'READ', exposedFieldsForRaw(policy, tableSite), boundary))
        } else if (credentialLikeEntity(table)) {
          accesses.push(unresolvedRecord(tableSite, boundary, 'credential_like_raw_entity_read_without_registered_policy', {
            candidateEntities: [table],
            intendedAccess: 'READ',
          }))
        }
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
      if ((site.operations ?? []).length > 0) {
        const unmatchedWriteTables = (site.tables ?? []).filter((table) => uniquePolicies([table], index).length === 0)
        for (const table of unmatchedWriteTables) {
          const derivedWriteFields = credentialWriteFieldsForTable(site, table)
          if (derivedWriteFields.length === 0 && !credentialLikeEntity(table)) continue
          const policy = fieldDerivedPolicy(table, derivedWriteFields)
          accesses.push(baseRecord(site, policy, 'WRITE', {
            exposed: derivedWriteFields,
            ambiguous: Boolean(site.ambiguous),
            reason: site.ambiguous ? 'dynamic_credential_record_write' : null,
          }, boundary))
        }
      }
      if (
        options.failClosedUnknownRaw !== false
        && site.ambiguous
        && (site.tables ?? []).length === 0
        && (site.read_tables ?? []).length === 0
      ) {
        accesses.push(unresolvedRecord(site, boundary, 'unresolved_raw_sql_may_access_credential_entity', {
          candidateEntities: [...(site.tables ?? []), ...(site.read_tables ?? [])],
          intendedAccess: 'UNKNOWN',
        }))
      }
      continue
    }

    if (site.kind === 'model' || site.kind === 'ambiguous_model' || site.kind === 'drizzle') {
      const parentModels = [site.model, ...(site.candidate_models ?? [])].filter(Boolean)
      const nestedOnlyAmbiguity = Boolean(site.ambiguous)
        && (site.ambiguity_reasons ?? []).length > 0
        && (site.ambiguity_reasons ?? []).every((reason) => reason === 'nested_relation_write_requires_schema_resolution')
      const recordSite = nestedOnlyAmbiguity
        ? { ...site, ambiguous: false, ambiguity_reasons: [] }
        : site
      const matches = uniquePolicies(parentModels, index)
      for (const policy of matches) {
        accesses.push(baseRecord(recordSite, policy, 'WRITE', {
          exposed: policy.sensitive_fields,
          ambiguous: Boolean(recordSite.ambiguous),
          reason: recordSite.ambiguous ? 'dynamic_credential_record_write' : null,
        }, boundary))
      }
      if (matches.length === 0) {
        const sensitiveFields = (site.written_fields ?? []).filter(credentialLikeField)
        if (sensitiveFields.length > 0) {
          const policy = fieldDerivedPolicy(site.model ?? site.candidate_models?.[0] ?? null, sensitiveFields)
          accesses.push(baseRecord(site, policy, 'WRITE', {
            exposed: sensitiveFields,
            ambiguous: Boolean(site.ambiguous || site.write_projection_dynamic),
            reason: site.ambiguous || site.write_projection_dynamic ? 'dynamic_credential_record_write' : null,
          }, boundary))
        } else if (credentialLikeEntity(site.model) || (site.candidate_models ?? []).some(credentialLikeEntity)) {
          const policy = fieldDerivedPolicy(site.model ?? site.candidate_models?.[0] ?? null, [])
          accesses.push(baseRecord(site, policy, 'WRITE', {
            exposed: [],
            ambiguous: Boolean(site.ambiguous || site.write_projection_dynamic),
            reason: site.ambiguous || site.write_projection_dynamic ? 'dynamic_credential_record_write' : null,
          }, boundary))
        } else if (!nestedOnlyAmbiguity && (site.ambiguous || site.write_projection_dynamic)) {
          accesses.push(unresolvedRecord(site, boundary, 'unresolved_model_write_may_access_credential_entity', {
            candidateEntities: [site.model, ...(site.candidate_models ?? [])],
            intendedAccess: 'WRITE',
          }))
        }
      }
      appendNestedWriteAccesses(recordSite, parentModels)
      if (site.return_projection) {
        appendProjectionAccess(
          recordSite,
          parentModels,
          site.return_projection,
        )
      }
    }
  }

  const uniqueAccesses = deduplicateCredentialAccesses(accesses)
  uniqueAccesses.sort((left, right) => (
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
    accesses: uniqueAccesses,
    diagnostics: analyzed.diagnostics,
  }
}

/** Analyze a standalone or extracted SQL fragment using the same policy. */
export function analyzeCredentialSqlAccess(sql, options = {}) {
  const fileName = options.fileName ?? 'architecture-credential-scan.sql'
  const sqlTokens = typeof sql === 'string' ? tokenizeSql(sql) : []

  // Preserve statement cardinality and source locations.  Aggregating a file
  // before applying credential policy can both collapse multiple accesses and
  // let a reused SQL alias contaminate another statement's attribution.
  if (typeof sql === 'string' && !options.statementScoped) {
    const tokens = sqlTokens
    const spans = []
    let depth = 0
    let first = null
    let last = null
    for (const token of tokens) {
      if (first === null && token.value !== ';') first = token.start
      if (token.value === '(') depth += 1
      if (token.value === ')') depth = Math.max(0, depth - 1)
      if (token.value === ';' && depth === 0) {
        if (first !== null && last !== null) spans.push({ start: first, end: last })
        first = null
        last = null
      } else if (first !== null) last = token.end
    }
    if (first !== null && last !== null) spans.push({ start: first, end: last })

    if (spans.length > 1 || (spans.length === 1 && spans[0].start > 0)) {
      const accesses = spans.flatMap((span, statementIndex) => {
        const { line, column } = locationAtOffset(
          sql,
          span.start,
          options.line ?? 1,
          options.column ?? 1,
        )
        return analyzeCredentialSqlAccess(sql.slice(span.start, span.end), {
          ...options,
          line,
          column,
          ordinal: `${options.ordinal ?? 0}:${statementIndex}:${span.start}`,
          statementScoped: true,
        }).accesses
      }).sort((left, right) => (
        left.line - right.line
        || left.column - right.column
        || left.site_signature.localeCompare(right.site_signature)
        || String(left.policy_id).localeCompare(String(right.policy_id))
        || left.access.localeCompare(right.access)
      ))
      return {
        schema: 'yoko.crm.credential-sql-access.v2',
        file: fileName,
        sql_sha256: sha256(sql),
        safety: 'structural SQL access metadata and field names only; SQL text and credential values are never emitted',
        accesses,
      }
    }
  }

  if (typeof sql === 'string') {
    const words = sqlTokens.filter((token) => token.kind === 'word').map((token) => token.value.toUpperCase())
    const container = words[0] === 'DO'
      ? 'DO'
      : words[0] === 'CREATE' && words.includes('FUNCTION')
        ? 'CREATE_FUNCTION'
        : words[0] === 'CREATE' && words.includes('PROCEDURE')
          ? 'CREATE_PROCEDURE'
          : null
    const bodies = container ? sqlTokens.filter((token) => token.kind === 'dollar_value') : []
    if (container && bodies.length > 0) {
      const accesses = bodies.flatMap((body, bodyIndex) => {
        const { line, column } = locationAtOffset(
          sql,
          body.body_start,
          options.line ?? 1,
          options.column ?? 1,
        )
        return analyzeCredentialSqlAccess(body.body, {
          ...options,
          line,
          column,
          method: `${options.method ?? 'sql-script'}:${container.toLowerCase()}-body`,
          scope: `${options.scope ?? '<sql-script>'}:${container.toLowerCase()}-body`,
          ordinal: `${options.ordinal ?? 0}:body:${bodyIndex}:${body.body_start}`,
          statementScoped: false,
        }).accesses
      }).sort((left, right) => (
        left.line - right.line
        || left.column - right.column
        || left.site_signature.localeCompare(right.site_signature)
      ))
      return {
        schema: 'yoko.crm.credential-sql-access.v2',
        file: fileName,
        sql_sha256: sha256(sql),
        safety: 'structural SQL access metadata and field names only; SQL text and credential values are never emitted',
        accesses,
      }
    }
  }
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
    selected_column_sources: analysis.selected_column_sources ?? [],
    written_columns: analysis.written_columns ?? [],
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
  const seenReadPolicies = new Set()
  for (const table of position.read_tables) {
    for (const policy of uniquePolicies([table], index)) {
      if (seenReadPolicies.has(policy.id)) continue
      seenReadPolicies.add(policy.id)
      const tablePosition = rawProjectionForTable(position, table)
      accesses.push(baseRecord(tablePosition, policy, 'READ', exposedFieldsForRaw(policy, tablePosition), boundary))
    }
  }
  for (const table of position.read_tables.filter((candidate) => uniquePolicies([candidate], index).length === 0)) {
    const tablePosition = rawProjectionForTable(position, table)
    if (tablePosition.read_projection_dynamic) {
      continue
    }
    const derivedReadFields = tablePosition.selected_columns.filter(credentialLikeField)
    if (derivedReadFields.length === 0) {
      if (credentialLikeEntity(table)) {
        accesses.push(unresolvedRecord(tablePosition, boundary, 'credential_like_raw_entity_read_without_registered_policy', {
          candidateEntities: [table],
          intendedAccess: 'READ',
        }))
      }
      continue
    }
    const policy = {
      id: `field-derived.${normalizeName(table) || 'unresolved'}.v1`,
      entity: table,
      owner_context: null,
      sensitive_fields: [...new Set(derivedReadFields)].sort(),
    }
    accesses.push(baseRecord(tablePosition, policy, 'READ', exposedFieldsForRaw(policy, tablePosition), boundary))
  }
  for (const policy of uniquePolicies(position.tables, index)) {
    if (analysis.operations.length === 0) continue
    accesses.push(baseRecord(position, policy, 'WRITE', {
      exposed: policy.sensitive_fields,
      ambiguous: analysis.ambiguous,
      reason: analysis.ambiguous ? 'dynamic_credential_record_write' : null,
    }, boundary))
  }
  if (analysis.operations.length > 0) {
    for (const table of position.tables.filter((candidate) => uniquePolicies([candidate], index).length === 0)) {
      const derivedWriteFields = credentialWriteFieldsForTable(position, table)
      if (derivedWriteFields.length === 0 && !credentialLikeEntity(table)) continue
      const policy = {
        id: `field-derived.${normalizeName(table) || 'unresolved'}.v1`,
        entity: table,
        owner_context: null,
        sensitive_fields: [...new Set(derivedWriteFields)].sort(),
      }
      accesses.push(baseRecord(position, policy, 'WRITE', {
        exposed: derivedWriteFields,
        ambiguous: analysis.ambiguous,
        reason: analysis.ambiguous ? 'dynamic_credential_record_write' : null,
      }, boundary))
    }
  }
  if (
    options.failClosedUnknownRaw !== false
    && analysis.ambiguous
    && (
      (position.tables.length === 0 && position.read_tables.length === 0)
      || (analysis.reasons ?? []).some((reason) => reason.startsWith('dialect_dependent_'))
    )
  ) {
    accesses.push(unresolvedRecord(position, boundary, 'unresolved_raw_sql_may_access_credential_entity', {
      candidateEntities: [],
      intendedAccess: 'UNKNOWN',
    }))
  }
  const uniqueAccesses = deduplicateCredentialAccesses(accesses)
  uniqueAccesses.sort((left, right) => (
    left.line - right.line
    || left.column - right.column
    || String(left.policy_id).localeCompare(String(right.policy_id))
    || left.access.localeCompare(right.access)
  ))
  return {
    schema: 'yoko.crm.credential-sql-access.v2',
    file: fileName,
    sql_sha256: analysis.sql_sha256,
    safety: 'structural SQL access metadata and field names only; SQL text and credential values are never emitted',
    accesses: uniqueAccesses,
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
