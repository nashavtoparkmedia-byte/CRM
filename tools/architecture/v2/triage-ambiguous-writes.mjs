#!/usr/bin/env node

import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'

const [input, output] = process.argv.slice(2)
if (!input || !output) {
  throw new Error('usage: triage-ambiguous-writes.mjs BASELINE.json TRIAGE.json')
}

const focusedOwnershipDecisions = new Map([
  ...['45645e0b760a5827a47289517fa298c1a3bcd215068e418d7c93e887b8ad17ac','81f28083be28056e5c9be0ca8018f6ec9121a53bee49136fe9fd7e710afdb913','64934aa9a77c0de5bafd842a668fa1b1f10654ce0a3ffa06cfe7a7fd3b995046','8779aa7c9ab18d702c45db346d6e34b2262c14d2744796efbc77bd6bcf6927a2','68e7b2590b446a521037a09ba257bd2dc3e9dc5160ae46e2838bc955f203ab4d','48452c703f3878500e43002f7311f83f1a84a5d7a7c7fc02ac262672a49917b9','f2385246a9722e1692eaa96a81289d48e1bc42701ab7bbaf653642fac72b7e40'].map(signature => [signature, 'OWNER_VALID']),
  ['86fcbe86cb9f15f5d9c844fbecfb12a912ca3a5d9a1fce95e39d4a1f3b663048', 'OWNERSHIP_MANIFEST_GAP_REVIEW'],
  ['caa58a0bf05960a1b641812d8efa055fd89b6ae683268dfce77b9ccdc93ea32b', 'OWNERSHIP_MANIFEST_GAP_REVIEW'],
  ['9889a11d1518f34196c9816f3f1269910329f7a85ecc744f6776bce4a0a46d63', 'FOREIGN'],
  ['ecda9ca05cf1f46ae206a4f23e9354efba9740023f838d202b5a9ea22b27d323', 'FOREIGN'],
])

function classify(site) {
  const reasons = new Set(site.ambiguity_reasons ?? [])
  if (
    (site.file === 'max-web-scraper/contacts/ContactStore.js' && /^sql-driver:get$/u.test(site.method))
    || (site.file === 'tools/architecture/v2/analyze.mjs' && site.method.startsWith('mixed-script-command:'))
  ) {
    return { disposition: 'CONFIRMED_NON_WRITE', rationale: 'Source inspection proves an in-memory Map lookup or analyzer detector literal, not a database operation.' }
  }
  if (/^mixed-script-command:(?:prisma (?:db push|migrate (?:deploy|resolve))|pg_restore)$/u.test(site.method)) {
    return { disposition: 'CONFIRMED_WRITE_OWNER_UNRESOLVED', rationale: 'The executable command is intrinsically database-mutating; it requires a narrow migration or restore capability owner.' }
  }
  if (site.kind === 'model' && reasons.size === 0) {
    return { disposition: 'CONFIRMED_DB_WRITE_OWNERSHIP_UNRESOLVED', rationale: 'A concrete Prisma delegate and mutating method were resolved; only source ownership is absent.' }
  }
  if (site.kind === 'raw' && reasons.size === 0) {
    return { disposition: 'CONFIRMED_DB_WRITE_OWNERSHIP_UNRESOLVED', rationale: 'The SQL analyzer proved a mutating statement, but no owner context was resolved.' }
  }
  if (reasons.has('dynamic_sql_fragment') || reasons.has('dynamic_sql_marker')) {
    return { disposition: 'GENUINELY_DYNAMIC_SQL_UNRESOLVED', rationale: 'The SQL text or marker is dynamic; no write/non-write claim is safe without a narrower source or analyzer proof.' }
  }
  if (reasons.has('sql_not_statically_available')) {
    return { disposition: 'GENUINELY_DYNAMIC_SQL_UNRESOLVED', rationale: 'The SQL argument is not statically available; retain it as dynamic SQL rather than a source-family ambiguity.' }
  }
  if (reasons.has('query_raw_intent_unresolved') || reasons.has('select_function_side_effect_unresolved')) {
    return { disposition: 'QUERY_RAW_INTENT_UNRESOLVED', rationale: 'A queryRaw call may invoke a side-effecting routine; it remains unresolved rather than being counted as a non-write.' }
  }
  if (site.kind === 'ambiguous_model' || reasons.has('ambiguous_prisma_delegate') || reasons.has('unproven_prisma_client')) {
    return { disposition: 'GENUINELY_DYNAMIC_OR_UNPROVEN_DELEGATE', rationale: 'The receiver or delegate is not statically proven; this is not a false-positive classification.' }
  }
  return { disposition: 'SOURCE_FAMILY_REVIEW_REQUIRED', rationale: 'No safe batch proof exists yet; retain ambiguity.' }
}

function ownershipClassification(site, disposition) {
  if (!['CONFIRMED_DB_WRITE_OWNERSHIP_UNRESOLVED', 'CONFIRMED_WRITE_OWNER_UNRESOLVED'].includes(disposition)) return null
  if (site.source_context && site.owner_contexts.length === 1 && site.source_context === site.owner_contexts[0]) return 'OWNER_VALID'
  if (site.source_context && site.owner_contexts.length > 0) return 'FOREIGN'
  if (site.surface?.lifecycle === 'OPERATIONAL_SCRIPT' || site.surface?.lifecycle === 'MIGRATION') return 'MAINTENANCE_MIGRATION_CAPABILITY_CANDIDATE'
  return 'OWNERSHIP_MANIFEST_GAP_REVIEW'
}

const source = JSON.parse(await readFile(resolve(input), 'utf8'))
const records = source.write_sites
  .filter(site => site.classification === 'AMBIGUOUS')
  .map(site => {
    const focusedDecision = focusedOwnershipDecisions.get(site.site_signature) ?? null
    const result = focusedDecision === 'OWNER_VALID' || focusedDecision === 'FOREIGN'
      ? { disposition: 'CONFIRMED_WRITE_OWNER_RESOLVED', rationale: 'Focused architecture/source review resolved writer and target ownership against current decisions.' }
      : focusedDecision === 'OWNERSHIP_MANIFEST_GAP_REVIEW'
        ? { disposition: 'CONFIRMED_WRITE_OWNER_UNRESOLVED', rationale: 'Focused review confirmed a real schema-scoped ownership gap; no manifest change is assumed.' }
        : classify(site)
    const inferredOwnership = focusedDecision ?? ownershipClassification(site, result.disposition)
    return {
    site_signature: site.site_signature,
    file: site.file,
    line: site.line,
    column: site.column,
    kind: site.kind,
    method: site.method,
    model: site.model ?? null,
    candidate_models: site.candidate_models ?? [],
    tables: site.tables ?? [],
    operations: site.operations ?? [],
    source_context: site.source_context ?? null,
    source_technical_module: site.source_technical_module ?? null,
    owner_contexts: site.owner_contexts ?? [],
    receiver_origin: site.receiver_origin ?? null,
    surface: site.surface,
    ambiguity_reasons: site.ambiguity_reasons ?? [],
    ...result,
    ownership_classification: inferredOwnership,
    final_ownership_classification: inferredOwnership === 'OWNER_VALID'
      ? 'OWNER_VALID'
      : inferredOwnership === 'FOREIGN'
        ? 'FOREIGN'
        : inferredOwnership === 'MAINTENANCE_MIGRATION_CAPABILITY_CANDIDATE'
          ? 'MAINTENANCE_MIGRATION_CAPABILITY'
          : inferredOwnership === 'OWNERSHIP_MANIFEST_GAP_REVIEW'
            ? 'OWNERSHIP_MANIFEST_GAP_REVIEW'
            : null,
  }
  })
  .sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line || left.column - right.column)

const taxonomy = [
  'CONFIRMED_WRITE_OWNER_RESOLVED',
  'CONFIRMED_WRITE_OWNER_UNRESOLVED',
  'DYNAMIC_DELEGATE_UNRESOLVED',
  'DYNAMIC_SQL_UNRESOLVED',
  'QUERY_RAW_SIDE_EFFECT_UNRESOLVED',
  'SOURCE_FAMILY_REVIEW_REQUIRED',
  'CONFIRMED_NON_WRITE',
  'GENUINELY_DYNAMIC_UNRESOLVED',
]
const summary = {
  CONFIRMED_WRITE_OWNER_RESOLVED: records.filter(record => record.disposition === 'CONFIRMED_WRITE_OWNER_RESOLVED').length,
  CONFIRMED_WRITE_OWNER_UNRESOLVED: records.filter(record => ['CONFIRMED_DB_WRITE_OWNERSHIP_UNRESOLVED', 'CONFIRMED_WRITE_OWNER_UNRESOLVED'].includes(record.disposition) && record.ownership_classification !== 'OWNER_VALID').length,
  DYNAMIC_DELEGATE_UNRESOLVED: records.filter(record => record.disposition === 'GENUINELY_DYNAMIC_OR_UNPROVEN_DELEGATE').length,
  DYNAMIC_SQL_UNRESOLVED: records.filter(record => record.disposition === 'GENUINELY_DYNAMIC_SQL_UNRESOLVED').length,
  QUERY_RAW_SIDE_EFFECT_UNRESOLVED: records.filter(record => record.disposition === 'QUERY_RAW_INTENT_UNRESOLVED').length,
  SOURCE_FAMILY_REVIEW_REQUIRED: records.filter(record => record.disposition === 'SOURCE_FAMILY_REVIEW_REQUIRED').length,
  CONFIRMED_NON_WRITE: records.filter(record => record.disposition === 'CONFIRMED_NON_WRITE').length,
  GENUINELY_DYNAMIC_UNRESOLVED: 0,
}
const document = {
  schema: 'yoko.crm.ambiguous-write-triage.v1',
  baseline: {
    analysis_sha256: source.analysis_sha256,
    baseline_sha256: createHash('sha256').update(await readFile(resolve(input))).digest('hex'),
  },
  policy: 'No unresolved record is converted to PASS or non-write without source or analyzer evidence.',
  taxonomy,
  summary,
  records,
}
const target = resolve(output)
await writeFile(`${target}.tmp`, `${JSON.stringify(document, null, 2)}\n`)
await rename(`${target}.tmp`, target)
