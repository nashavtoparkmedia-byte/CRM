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
  ['86fcbe86cb9f15f5d9c844fbecfb12a912ca3a5d9a1fce95e39d4a1f3b663048', 'OWNER_VALID'],
  ['f19471d76bbf4826e61406ca70875a7f35094165c332b35ea4f2d30858ff8599', 'OWNER_VALID'],
  ['caa58a0bf05960a1b641812d8efa055fd89b6ae683268dfce77b9ccdc93ea32b', 'OWNER_VALID'],
  ['9889a11d1518f34196c9816f3f1269910329f7a85ecc744f6776bce4a0a46d63', 'FOREIGN'],
  ['ecda9ca05cf1f46ae206a4f23e9354efba9740023f838d202b5a9ea22b27d323', 'FOREIGN'],
  ['1dde17910d6ede26e63fea7f13eeb237a27f299dc3c25186fa9686400b466a68', 'CONTROLLED_MIGRATION'],
  ['c13b2ed496ae9c0a869281cd3db6f4ba560cffb50f5a10573e2702527fa49acc', 'CONTROLLED_MIGRATION'],
  ['3496c5c9535bc1d5b0cce4adf17e8516310c3260b20407856d5fd5f2ff54c4ec', 'CONTROLLED_MIGRATION'],
  ['94c8e6d4c7d0f3203debaf993aaa75f5127d6629d76b607f94f380494c170fd5', 'CONTROLLED_MIGRATION'],
  ['32f1fd3e6b047202f79bf923c359b748a06f50010a4113a0ded9df2e26431d20', 'CONTROLLED_MIGRATION'],
])

const confirmedReadOnlyDecisions = new Set([
  '36c9b52b2b9c7b0d7ec8bec4120e6772b5421558fb0f591ed1ef2f9306aadce7', 'bd5f029e6d7e1ae7767d85e524d2a69134bd87aef53352ebeb7caf364aa54825', '3331c0d6e52e665c9f373dfa9a50f8b351bfffe7678db5d300bf2c01c46996bc', '037b459fcefcde89d3f50f66e7cb3d69cf7788f5451ec7ebe9cee41e94291b91', 'd7b60d9168005c4268cd46df849f684067e5994e79744e430f76ccc5b14f08bb', 'dd15e3ca3b8b8470797072b94d9ee74c5a0d4f66aba7c7104f566faa790e6590',
  '8004a8dc8d8d1183024debb2be7bf79572b663ab596b6497a2e8058cb51b46fa', 'b2c3ae6fc6828d9d51e85f6f01d3dff86df72a5ced9f863516a2d0276c1c61e3', 'e8319859102636b4b4915c12f4c1dccaac2f97309e2fe5853109ef441b95bae6', '69ae5095adc3a7847274305f5f6a963d449606b60094335bb37a22a0423b4f9c', '5cff329cbbb30ad80f4a934dadf91c774bdf4c1c77907e08527b8159762e554a', '3ee3e1ff772ceba991f2e501083d76c3fad96f5b0fc9831a0f47c1a827f37df8', '0c81e542c6ee55171cb049c0570617f3fa9ea12402305bfe8014d2c953c51caa',
  'e1c81095a11532a1ba56e2629b9316a15d42ad5062aa52dfa190283adb26f5e1', '040c0d8f2319e57f6b22e2e2dbc3065fe5fbf10ad306e15ff687cf87f3604057', 'ea322bd576b8b6ee4240ed4611e602b63d1cdcb2befa71a84a886a55afb4ac4f', '3f0f0682204964ed2be82d5effe35517b5e8eaa97f73dbc4344cbc63d361907f', '31e7ff73ab8a69a2a5f72de16d08e899a46e9cc48004c42e034335d5e622637c', '6c84c5974dc29a3cd814144d007c6669c061d6217ca8837671847aaf97206891',
  '6fe3c1e8c14600a70e17a2782784bf9dbe45318c0ca596bc87d4ebcd3a1837c4', '490105b516a84ebfd5c94ad7544581e9628ae1f95dffee0c0940ba8b0bfa9dad', 'b00356e49038391b1ecb1efbefd7c929b2e1e15f2cc6580a32df27a68f04c982', 'b340d44a632b98bc4560d64af31050bbc6c2c4d2c086bd2e88ad2afefe3baf42',
  '2390d5d610646077ea1572b4ae278b721ceb44b14461dccf8e24817a7b68f541', '1ac9db07b55047f8f0e8b6708e294bf1e033a1e71f5348567b5fb6ee421a6858',
])

function classify(site) {
  const reasons = new Set(site.ambiguity_reasons ?? [])
  if (
    (site.file === 'max-web-scraper/contacts/ContactStore.js' && /^sql-driver:get$/u.test(site.method))
    || (site.file === 'tools/architecture/v2/analyze.mjs' && site.method.startsWith('mixed-script-command:'))
  ) {
    return { disposition: 'CONFIRMED_NON_WRITE', rationale: 'Source inspection proves an in-memory Map lookup or analyzer detector literal, not a database operation.' }
  }
  // A queryRaw site with a fully resolved, read-only SQL statement is an
  // analyzer false positive when it was retained only because raw reads are
  // inventoried. Keep side-effecting routines and dynamic SQL unresolved;
  // this branch requires both an empty mutation operation set and no
  // ambiguity reasons.
  if (site.kind === 'raw' && reasons.size === 0 && (site.operations ?? []).length === 0) {
    return { disposition: 'CONFIRMED_NON_WRITE', rationale: 'SQL analysis resolved a read-only queryRaw statement with no mutation operations.' }
  }
  if (/^mixed-script-command:(?:prisma (?:db push|migrate (?:deploy|resolve))|pg_restore)$/u.test(site.method)) {
    return { disposition: 'CONFIRMED_WRITE_OWNER_UNRESOLVED', rationale: 'The executable command is intrinsically database-mutating; it requires a narrow migration or restore capability owner.' }
  }
  const payloadOnlyAmbiguity = reasons.size > 0
    && [...reasons].every((reason) => reason === 'dynamic_payload_may_contain_nested_write')
  if (site.kind === 'model' && (reasons.size === 0 || payloadOnlyAmbiguity)) {
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
    const result = confirmedReadOnlyDecisions.has(site.site_signature)
      ? { disposition: 'CONFIRMED_NON_WRITE', rationale: 'Source inspection proves a static SELECT projection; dynamic values are bound parameters/fragments and no mutation statement is reachable.' }
      : focusedDecision === 'OWNER_VALID' || focusedDecision === 'FOREIGN' || focusedDecision === 'CONTROLLED_MIGRATION'
      ? { disposition: 'CONFIRMED_WRITE_OWNER_RESOLVED', rationale: 'Focused architecture/source review resolved writer and target ownership against current decisions.' }
      : focusedDecision === 'OWNERSHIP_MANIFEST_GAP_REVIEW'
        ? { disposition: 'CONFIRMED_WRITE_OWNER_UNRESOLVED', rationale: 'Focused review confirmed a real schema-scoped ownership gap; no manifest change is assumed.' }
        : classify(site)
    const inferredOwnership = focusedDecision ?? ownershipClassification(site, result.disposition)
    return {
    record_id: site.site_signature,
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
    semantic_state: result.disposition === 'CONFIRMED_NON_WRITE'
      ? 'RESOLVED_NON_WRITE'
      : result.disposition === 'CONFIRMED_WRITE_OWNER_RESOLVED'
        ? (inferredOwnership === 'CONTROLLED_MIGRATION' ? 'CONTROLLED_MIGRATION_WRITE' : 'OWNER_VALID_WRITE')
        : 'MATERIAL_UNRESOLVED_WRITE_RISK',
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
  RAW_BASELINE_AMBIGUOUS: records.length,
  CONFIRMED_WRITE_OWNER_RESOLVED: records.filter(record => record.disposition === 'CONFIRMED_WRITE_OWNER_RESOLVED').length,
  CONFIRMED_WRITE_OWNER_UNRESOLVED: records.filter(record => ['CONFIRMED_DB_WRITE_OWNERSHIP_UNRESOLVED', 'CONFIRMED_WRITE_OWNER_UNRESOLVED'].includes(record.disposition) && record.ownership_classification !== 'OWNER_VALID').length,
  DYNAMIC_DELEGATE_UNRESOLVED: records.filter(record => record.disposition === 'GENUINELY_DYNAMIC_OR_UNPROVEN_DELEGATE').length,
  DYNAMIC_SQL_UNRESOLVED: records.filter(record => record.disposition === 'GENUINELY_DYNAMIC_SQL_UNRESOLVED').length,
  QUERY_RAW_SIDE_EFFECT_UNRESOLVED: records.filter(record => record.disposition === 'QUERY_RAW_INTENT_UNRESOLVED').length,
  SOURCE_FAMILY_REVIEW_REQUIRED: records.filter(record => record.disposition === 'SOURCE_FAMILY_REVIEW_REQUIRED').length,
  CONFIRMED_NON_WRITE: records.filter(record => record.disposition === 'CONFIRMED_NON_WRITE').length,
  GENUINELY_DYNAMIC_UNRESOLVED: 0,
  RESOLVED_NON_WRITE: records.filter(record => record.semantic_state === 'RESOLVED_NON_WRITE').length,
  OWNER_VALID_WRITE: records.filter(record => record.semantic_state === 'OWNER_VALID_WRITE').length,
  CONTROLLED_MIGRATION_WRITE: records.filter(record => record.semantic_state === 'CONTROLLED_MIGRATION_WRITE').length,
  MATERIAL_UNRESOLVED_WRITE_RISK: records.filter(record => record.semantic_state === 'MATERIAL_UNRESOLVED_WRITE_RISK').length,
}
summary.RECONCILIATION_TOTAL = summary.RESOLVED_NON_WRITE + summary.OWNER_VALID_WRITE + summary.CONTROLLED_MIGRATION_WRITE + summary.MATERIAL_UNRESOLVED_WRITE_RISK
summary.RECONCILIATION_EXACT = summary.RECONCILIATION_TOTAL === summary.RAW_BASELINE_AMBIGUOUS
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
