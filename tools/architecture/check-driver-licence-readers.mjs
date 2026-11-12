#!/usr/bin/env node
// Driver-licence (ВУ) reader inventory (Owner D2, OD-03; Security D2 criterion 4).
//
// Who sees the ВУ is Contacts' read authority (ContactReadAuthorityQuery.v1),
// applied through Fleet's licence view. Since the Owner's decision of 2026-11-11
// (~10:20) every verified staff reader role sees the full number, so what guards
// the ВУ is the personal sign-in: no reader may show it outside a verified
// session, and none may print it to a log. This control keeps an exact inventory of every non-test source file that touches the ВУ
// under ANY of its names: the licence fields (licenseNumber, licenseHistory, …)
// and the person keys that embed it (externalPersonKey / profileClusterKey are
// `vu:<normalized ВУ>`, normalizedVu, rawVu). Each file carries a disposition:
//
//   owner_internal — Fleet or Cash code that owns, normalizes, writes or compares
//                    the ВУ and hands it to no reader.
//   evidence_key   — Contacts evidence and clustering keys used for decisions,
//                    never rendered.
//   command_input  — a command contract that carries the ВУ as an input.
//   admin_only     — output reaches only an integration-admin surface; `gate`
//                    names the guard and `gateFile` where it is. Verified here:
//                    in a route file EVERY exported HTTP handler must call the
//                    guard before its first data read (a guard in PATCH says
//                    nothing about GET); a page or action module must call it.
//                    `becomes: 'masked'` marks a D2 conduit that is admin-only
//                    until its masking step lands (Cash's referral reads), when
//                    it must move to `masked`.
//   masked         — a D2 surface behind the read authority whose ВУ passes
//                    through Fleet's licence view (maskDriverLicenceV1, verified
//                    here).
//   d2l            — a legacy screen that shows the ВУ on the legacy perimeter
//                    (no personal sign-in yet); the P1 «D2-L» moves it onto the
//                    Staff Session read authority. `owner` names the context that
//                    executes it.
//   view_decision  — carries the licenceView decision or its type, never a number.
//   type_only      — declares or re-exports a ВУ-bearing type and reads no data.
//   licence_term_only — the word names a questionnaire flag or field («has a
//                    licence», categories) or a component, not the number.
//
// A file is a ВУ reader when, with comments stripped, it matches any rule:
//   name        — any spelling of licen[cs]e, case-insensitive (licenseNumber,
//                 licence, searchProfilesByLicence, SQL "licenseNumber", …);
//   person_key  — externalPersonKey, profileClusterKey, normalizedVu, rawVu or a
//                 `vu:${…}` template;
//   conduit     — a type that carries the ВУ between layers
//                 (CashReferralManagerProfileV1, the referral responses, the
//                 Fleet licence DTOs);
//   driver_row  — a Prisma Driver read without `select`, or an `include` of a
//                 Driver relation as `true`: the whole row, licenseNumber with it.
// False positives are classified, never excluded from the scan.
//
// It fails on a reader that is not listed, a listed file that no longer reads the
// ВУ (stale), an admin_only entry whose guard is gone, a masked entry without the
// mask, and any log or error text that prints a ВУ carrier. It then runs negative
// probes proving each of those failures fires.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')

const NAME_RULE = /licen[cs]e/iu
const PERSON_KEY_RULE = /\bexternalPersonKey\b|\bprofileClusterKey\b|\bnormalizedVu\b|\brawVu\b|`vu:\$\{/u
const CONDUIT_RULE = /\b(?:CashReferralManagerProfileV1|ReferralSearchResponse|ReferralPersonResponse|DriverProfileForContactV2|DriverProfilesByExactLicenceResultV1)\b/u
const DRIVER_READ = /\b(?:prisma|tx|db|transaction|client)\s*\.\s*driver\s*\.\s*(?:findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow)\s*\(/gu
const DRIVER_INCLUDE = /\binclude\s*:\s*\{[^}]*\b(?:driver|drivers|driverProfiles|mainDriver|contactProfile)\s*:\s*true\b/u

/** Source text without line and block comments; string and template contents are kept. */
export function stripComments(text) {
  let out = ''
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i]
    const n = text[i + 1]
    if (quote !== null) {
      out += c
      if (c === '\\') { out += n ?? ''; i += 1 } else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; continue }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i += 1; out += '\n'; continue }
    if (c === '/' && n === '*') {
      i += 2
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') out += '\n'; i += 1 }
      i += 1
      continue
    }
    out += c
  }
  return out
}

/** The rules a source text matches (comments stripped). */
export function licenceReaderRules(source) {
  const text = stripComments(source)
  const rules = []
  if (NAME_RULE.test(text)) rules.push('name')
  if (PERSON_KEY_RULE.test(text)) rules.push('person_key')
  if (CONDUIT_RULE.test(text)) rules.push('conduit')
  const rowRead = [...text.matchAll(DRIVER_READ)].some((match) => !/\bselect\s*:/u.test(callArguments(text, match.index + match[0].length)))
  if (rowRead || DRIVER_INCLUDE.test(text)) rules.push('driver_row')
  return rules
}
// A carrier used as a VALUE (`.x` or `${x}`) inside the argument list of a log
// call or an error constructor. A field NAME in a message ('licenseNumber must
// be a string') is not the number and does not count.
const LOG_OR_ERROR_CALL = /\b(?:console\.(?:log|warn|error|info|debug)|new \w*Error)\s*\(/gu
const CARRIER_VALUE = /(?:\.|\$\{\s*)(?:licen[cs]e(?:Number|History)|externalPersonKey|profileClusterKey|normalizedVu|rawVu)\b/u

/** The balanced argument text of the call whose "(" ends at `open`. */
function callArguments(text, open) {
  let depth = 1
  let index = open
  while (index < text.length && depth > 0) {
    const char = text[index]
    if (char === '(') depth += 1
    else if (char === ')') depth -= 1
    index += 1
  }
  return text.slice(open, index - 1)
}

export function printsLicenceCarrier(text) {
  for (const match of text.matchAll(LOG_OR_ERROR_CALL)) {
    if (CARRIER_VALUE.test(callArguments(text, match.index + match[0].length))) return true
  }
  return false
}
const SOURCE_ROOTS = ['gravity-mvp/src', 'tg-bot/src', 'tg-bot/tg-bot-frontend', 'max-web-scraper', 'yandex-fleet-scraper/src', 'avito-worker/src', 'tools/audio-bridge-day1']
const TEST_FILE = /(?:\.test\.(?:[cm]?[jt]sx?)$|\/__tests__\/|\/node_modules\/)/u
const CODE_FILE = /\.(?:[cm]?[jt]sx?)$/u

const ADMIN_GATES = {
  getIntegrationAdminPrincipal: 'getIntegrationAdminPrincipal()',
  hasIntegrationAdminAccess: 'hasIntegrationAdminAccess()',
  requireIntegrationAdminPageAccess: 'requireIntegrationAdminPageAccess(',
}

const fleet = 'fleet_operations'
const work = 'work_management'
const contacts = 'contacts'
const P = 'gravity-mvp/src/'

/** The exact inventory. Keys are repository paths. */
export const LICENCE_READERS = {
  [`${P}app/api/bot-link/route.ts`]: { disposition: 'admin_only', gate: 'hasIntegrationAdminAccess' },
  [`${P}app/api/contacts/[id]/driver-person/route.ts`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal' },
  [`${P}app/api/contacts/[id]/parks/route.ts`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal' },
  [`${P}app/api/contacts/[id]/route.ts`]: { disposition: 'd2l', owner: contacts, note: 'GET is ungated at app level (only PATCH is guarded): Messages contact panel with licenseHistory; its own PR gates GET with the read authority (Security 2026-11-12)' },
  [`${P}app/contacts/licence-search/route.ts`]: { disposition: 'masked', gateFile: `${P}modules/fleet-operations/public/v1/driver-profiles-by-exact-licence-handler.ts`, note: '«Люди» ВУ search transport (POST body); answers Fleet\'s masked profiles, never the typed licence' },
  [`${P}app/api/debug-db/list-all-chats/route.ts`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', note: 'debug listing includes the chat\'s Driver row' },
  [`${P}app/api/monitoring/attention/route.ts`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/api/monitoring/drivers/[id]/attention/route.ts`]: { disposition: 'owner_internal', note: 'mobile-session write; reads the Driver row, returns only the attention id and status' },
  [`${P}app/api/monitoring/drivers/[id]/event/route.ts`]: { disposition: 'owner_internal', note: 'mobile-session write; returns only the event id and type' },
  [`${P}app/api/monitoring/drivers/[id]/fleet-check/route.ts`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/api/monitoring/drivers/route.ts`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/api/monitoring/fleet-check/callback/route.ts`]: { disposition: 'owner_internal', note: 'scraper callback; reads the Driver row, returns only ok and the status' },
  [`${P}app/api/webhooks/bot/route.ts`]: { disposition: 'owner_internal', note: 'bot webhook compares the person key to find a driver\'s parks; it returns no key' },
  [`${P}app/compensation/referrals/ReferralManager.tsx`]: { disposition: 'admin_only', becomes: 'masked', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/compensation/referrals/page.tsx`, note: 'D2: masked by licenceView once the referral reads move onto ContactReadAuthorityQuery.v1 (after #214)' },
  [`${P}app/compensation/referrals/actions.ts`]: { disposition: 'admin_only', becomes: 'masked', gate: 'getIntegrationAdminPrincipal', note: 'server actions that answer the browser with the referral views (full ВУ); D2: masked after #214' },
  [`${P}app/compensation/referrals/referral-data.ts`]: { disposition: 'admin_only', becomes: 'masked', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/compensation/referrals/page.tsx`, note: 'D2: masked after #214' },
  [`${P}app/compensation/referrals/view.ts`]: { disposition: 'admin_only', becomes: 'masked', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/compensation/referrals/page.tsx`, note: 'D2: masked after #214' },
  [`${P}app/contacts/LicenceSearchClient.tsx`]: { disposition: 'masked', gateFile: `${P}modules/fleet-operations/public/v1/driver-profiles-by-exact-licence-handler.ts`, note: 'renders the ВУ search answer as the server masked it' },
  [`${P}app/contacts/[id]/PersonCardView.tsx`]: { disposition: 'masked', gateFile: `${P}modules/fleet-operations/public/v1/driver-profiles-for-contacts-v2-handler.ts`, note: 'renders the profile ВУ as Fleet masked it for the reader\'s view' },
  [`${P}app/contacts/page.tsx`]: { disposition: 'licence_term_only', note: 'names the ВУ search component; carries no number' },
  [`${P}app/drivers/actions.ts`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/drivers/archive/ArchiveClient.tsx`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/messages/components/ContactEvidenceDetails.tsx`]: { disposition: 'd2l', owner: contacts, note: 'renders the ungated GET /api/contacts/[id] until its gate lands' },
  [`${P}app/messages/components/DriverPersonSearchModal.tsx`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/api/contacts/[id]/driver-person/route.ts`, note: 'renders /api/contacts/[id]/driver-person; D2-L' },
  [`${P}app/messages/hooks/useContact.ts`]: { disposition: 'd2l', owner: contacts, note: 'fetches the ungated GET /api/contacts/[id] until its gate lands' },
  [`${P}app/monitoring/MonitoringClient.tsx`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/monitoring/components/AllDriversSection.tsx`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/monitoring/components/AttentionSection.tsx`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/monitoring/lib/types.ts`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/monitoring/page.tsx`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/settings/integrations/bot/BotPageClient.tsx`]: { disposition: 'admin_only', gate: 'requireIntegrationAdminPageAccess', gateFile: `${P}app/settings/integrations/bot/page.tsx`, note: 'its data comes from /api/bot-link (hasIntegrationAdminAccess)' },
  [`${P}app/tasks/excel-actions.ts`]: { disposition: 'd2l', owner: work },
  [`${P}contracts/contacts/v1/contact-person-card-contracts.ts`]: { disposition: 'view_decision' },
  [`${P}contracts/contacts/v1/driver-person-confirmation-command.ts`]: { disposition: 'evidence_key' },
  [`${P}contracts/fleet-operations/v1/driver-licence-view.ts`]: { disposition: 'view_decision' },
  [`${P}contracts/fleet-operations/v1/driver-profiles-by-exact-licence-query.ts`]: { disposition: 'masked', gateFile: `${P}modules/fleet-operations/public/v1/driver-profiles-by-exact-licence-handler.ts` },
  [`${P}contracts/fleet-operations/v1/index.ts`]: { disposition: 'type_only', note: 're-exports the licence view and the exact-licence contract' },
  [`${P}contracts/fleet-operations/v1/resolve-imported-driver-command.ts`]: { disposition: 'command_input' },
  [`${P}contracts/fleet-operations/v2/driver-profiles-for-contacts-query.ts`]: { disposition: 'masked', gateFile: `${P}modules/fleet-operations/public/v1/driver-profiles-for-contacts-v2-handler.ts` },
  [`${P}lib/MessageService.ts`]: { disposition: 'owner_internal', note: 'retrySend includes the chat\'s Driver row to resend; it answers only success and error' },
  [`${P}lib/ai-call/default-scenario.ts`]: { disposition: 'licence_term_only', note: 'questionnaire flag hasLicenseB' },
  [`${P}lib/ai-call/devSimulator.ts`]: { disposition: 'licence_term_only', note: 'questionnaire field name' },
  [`${P}lib/ai-call/mock-payload.ts`]: { disposition: 'licence_term_only', note: 'has_license / license_categories' },
  [`${P}lib/aiCallAnalysis/qualifyPrompt.ts`]: { disposition: 'licence_term_only', note: 'has_license / license_categories' },
  [`${P}lib/tasks/excel-contract.ts`]: { disposition: 'd2l', owner: work },
  [`${P}lib/tasks/list-columns.ts`]: { disposition: 'd2l', owner: work },
  [`${P}lib/tasks/list-renderers.tsx`]: { disposition: 'd2l', owner: work },
  [`${P}lib/tasks/list-views.ts`]: { disposition: 'd2l', owner: work },
  [`${P}lib/tasks/scenario-config.ts`]: { disposition: 'd2l', owner: work },
  [`${P}lib/tasks/scenario-fields.ts`]: { disposition: 'd2l', owner: work },
  [`${P}modules/contacts/internal/contact-merge-state-composer.ts`]: { disposition: 'evidence_key' },
  [`${P}modules/contacts/internal/contact-person-card.ts`]: { disposition: 'evidence_key', note: 'the card carries only the count of confirmed cluster keys, never a key' },
  [`${P}modules/calling/internal/ai-calls/ai-conversation-simulated-provider.ts`]: { disposition: 'licence_term_only', note: 'simulated lead questionnaire field license_category (C4, #210)' },
  [`${P}modules/contacts/internal/identity-access-contact-person-card-authority.ts`]: { disposition: 'view_decision' },
  [`${P}modules/contacts/public/v1/contact-merge-handler.ts`]: { disposition: 'evidence_key' },
  [`${P}modules/contacts/public/v1/contact-read-authority.ts`]: { disposition: 'view_decision' },
  [`${P}modules/contacts/public/v1/driver-person-confirmation.ts`]: { disposition: 'evidence_key' },
  [`${P}modules/contacts/public/v1/index.ts`]: { disposition: 'view_decision' },
  [`${P}modules/contacts/public/v1/legacy-prisma-contact-merge-adapter.ts`]: { disposition: 'evidence_key' },
  [`${P}modules/fleet-operations/application/cash-referral-manager-operations.ts`]: { disposition: 'admin_only', becomes: 'masked', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/compensation/referrals/page.tsx`, note: 'forwards searchProfilesByLicence and its profiles; D2: masked after #214' },
  [`${P}modules/fleet-operations/application/fleet-operations.ts`]: { disposition: 'owner_internal', note: 'binds the licence port to the masking handlers' },
  [`${P}modules/fleet-operations/internal/compensation/cash-referral-manager-service.ts`]: { disposition: 'admin_only', becomes: 'masked', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/compensation/referrals/page.tsx`, note: 'referral search by licence; D2: masked after #214' },
  [`${P}modules/fleet-operations/internal/compensation/cash-referral-manager.ts`]: { disposition: 'admin_only', becomes: 'masked', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/compensation/referrals/page.tsx`, note: 'D2: masked after #214' },
  [`${P}modules/fleet-operations/internal/compensation/compensation-referral-ledger.ts`]: { disposition: 'owner_internal', note: 'stores a digest of the person key, never the key' },
  [`${P}modules/fleet-operations/internal/compensation/compensation-referral-qualification.ts`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/internal/compensation/compensation-referral-service.ts`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/internal/compensation/legacy-prisma-cash-referral-decision-adapter.ts`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/internal/compensation/legacy-prisma-cash-referral-manager-adapter.ts`]: { disposition: 'admin_only', becomes: 'masked', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/compensation/referrals/page.tsx`, note: 'D2: masked after #214' },
  [`${P}modules/fleet-operations/internal/legacy-prisma-yandex-fleet-reconciler-adapter.ts`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/public/v1/driver-licence-mask.ts`]: { disposition: 'owner_internal', note: 'the one place a view turns into a shown ВУ' },
  [`${P}modules/fleet-operations/public/v1/driver-licence-read-port.ts`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/public/v1/driver-profiles-by-exact-licence-handler.ts`]: { disposition: 'masked' },
  [`${P}modules/fleet-operations/public/v1/driver-profiles-for-contacts-v2-handler.ts`]: { disposition: 'masked' },
  [`${P}modules/fleet-operations/public/v1/index.ts`]: { disposition: 'type_only', note: 're-exports CashReferralManagerProfileV1, the licence port types and the mask' },
  [`${P}modules/fleet-operations/public/v1/legacy-prisma-driver-licence-adapter.ts`]: { disposition: 'owner_internal', note: 'the one reader of the stored ВУ for the D2 handlers' },
  [`${P}modules/fleet-operations/public/v1/legacy-prisma-driver-license-maintenance-adapter.js`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/public/v1/legacy-prisma-resolve-imported-driver-adapter.ts`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/public/v1/monitoring-ui/ActionButtons.tsx`]: { disposition: 'd2l', owner: fleet },
  [`${P}modules/fleet-operations/public/v1/monitoring-ui/FleetCheckModal.tsx`]: { disposition: 'd2l', owner: fleet },
  [`${P}modules/fleet-operations/public/v1/park-phone-search.ts`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/api/contacts/[id]/parks/route.ts`, note: 'returns the profile ВУ to /api/contacts/[id]/parks and /api/bot-link, both integration-admin' },
  [`${P}modules/fleet-operations/public/v1/resolve-imported-driver-handler.ts`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/public/v1/scheduled-scraper-check-dispatch.ts`]: { disposition: 'owner_internal', note: 'dispatches fleet checks by the profile licence' },
  [`${P}modules/fleet-operations/public/v1/yandex-fleet-reconciler.ts`]: { disposition: 'owner_internal' },
  [`${P}modules/platform-shell/application/contact-licence-search-composition.ts`]: { disposition: 'masked', gateFile: `${P}modules/fleet-operations/public/v1/driver-profiles-by-exact-licence-handler.ts`, note: 'passes Contacts\' view to Fleet; withholds an unmasked last-4 answer' },
  [`${P}modules/platform-shell/application/contact-person-card-composition.ts`]: { disposition: 'masked', gateFile: `${P}modules/fleet-operations/public/v1/driver-profiles-for-contacts-v2-handler.ts`, note: 'passes Contacts\' view to Fleet; withholds an answer for another view or an unmasked one' },
  [`${P}modules/platform-shell/public/v1/index.ts`]: { disposition: 'type_only', note: 're-exports the ВУ search composition and its profile type' },
  ['tools/audio-bridge-day1/llm-client.js']: { disposition: 'licence_term_only', note: 'questionnaire field name' },
  ['yandex-fleet-scraper/src/api.ts']: { disposition: 'owner_internal', note: 'Fleet\'s scraper service checks a licence on Yandex' },
  ['yandex-fleet-scraper/src/worker.ts']: { disposition: 'owner_internal', note: 'Fleet\'s scraper worker' },
}

const HTTP_HANDLER = /export\s+async\s+function\s+(GET|POST|PUT|PATCH|DELETE)\s*\(/gu
/** The first data read of a handler; a guard must come before it. */
const FIRST_READ = /prisma\.|\.json\(\)|searchParams|\$queryRaw|findUnique|findMany|findFirst/u

/**
 * Each exported HTTP handler of a route file with the body text that belongs to
 * it: the parameter list is skipped by balanced parentheses, the body by
 * balanced braces. Comments are stripped by the caller.
 */
export function routeHandlers(source) {
  const handlers = []
  for (const match of source.matchAll(HTTP_HANDLER)) {
    let index = match.index + match[0].length
    let depth = 1
    while (index < source.length && depth > 0) {
      if (source[index] === '(') depth += 1
      else if (source[index] === ')') depth -= 1
      index += 1
    }
    const open = source.indexOf('{', index)
    if (open < 0) continue
    let braces = 1
    let end = open + 1
    while (end < source.length && braces > 0) {
      if (source[end] === '{') braces += 1
      else if (source[end] === '}') braces -= 1
      end += 1
    }
    handlers.push({ method: match[1], body: source.slice(open + 1, end - 1) })
  }
  return handlers
}

/**
 * Whether a gate file guards every way in. A route file passes only when EACH
 * exported HTTP handler calls the guard before its first data read (a guard in
 * PATCH says nothing about GET); any other gate file (a page, a server-action
 * module) must call the guard somewhere.
 */
export function gateViolations(gateSource, token) {
  const source = stripComments(gateSource)
  const handlers = routeHandlers(source)
  if (handlers.length === 0) return source.includes(token) ? [] : ['the guard is gone']
  const violations = []
  for (const handler of handlers) {
    const guard = handler.body.indexOf(token)
    const read = handler.body.search(FIRST_READ)
    if (guard < 0) violations.push(`the guard is missing in ${handler.method}`)
    else if (read >= 0 && read < guard) violations.push(`${handler.method} reads data before the guard`)
  }
  return violations
}

const DISPOSITIONS = new Set(['owner_internal', 'evidence_key', 'command_input', 'admin_only', 'masked', 'd2l', 'view_decision', 'type_only', 'licence_term_only'])

/** Every tracked non-test code file under the source roots that names a ВУ carrier. */
export function discoverLicenceReaders(files, readFile) {
  return files
    .filter((file) => CODE_FILE.test(file) && !TEST_FILE.test(file))
    .filter((file) => licenceReaderRules(readFile(file)).length > 0)
    .sort()
}

/** The violations of one inventory against one source snapshot. */
export function licenceReaderViolations(inventory, discovered, readFile) {
  const violations = []
  const listed = new Set(Object.keys(inventory))
  for (const file of discovered) {
    if (!listed.has(file)) violations.push(`unlisted ВУ reader: ${file}`)
    if (printsLicenceCarrier(stripComments(readFile(file)))) violations.push(`a log or error text prints a ВУ carrier: ${file}`)
  }
  const found = new Set(discovered)
  for (const [file, entry] of Object.entries(inventory)) {
    if (!DISPOSITIONS.has(entry.disposition)) violations.push(`unknown disposition ${entry.disposition}: ${file}`)
    if (!found.has(file)) violations.push(`stale inventory entry (no longer reads the ВУ): ${file}`)
    if (entry.disposition === 'admin_only') {
      const token = ADMIN_GATES[entry.gate]
      const gateFile = entry.gateFile ?? file
      if (!token) violations.push(`admin_only without a known gate: ${file}`)
      else for (const problem of gateViolations(readFile(gateFile), token)) violations.push(`admin_only guard ${entry.gate}: ${problem} in ${gateFile} (for ${file})`)
    }
    // A contract declares the masked field; its handler (gateFile) applies the mask.
    if (entry.disposition === 'masked' && found.has(file) && !readFile(entry.gateFile ?? file).includes('maskDriverLicenceV1')) {
      violations.push(`masked reader without maskDriverLicenceV1: ${file}`)
    }
    if (entry.becomes !== undefined && (entry.becomes !== 'masked' || entry.disposition !== 'admin_only')) {
      violations.push(`only an admin_only reader may carry the pending condition becomes: 'masked': ${file}`)
    }
    if (entry.disposition === 'd2l' && typeof entry.owner !== 'string') violations.push(`d2l entry without an owner: ${file}`)
  }
  return violations
}

function trackedFiles() {
  return execFileSync('git', ['-C', root, 'ls-files', '-z', '--', ...SOURCE_ROOTS], { encoding: 'utf8' })
    .split('\0').filter(Boolean)
}

/** Negative probes: each violation class must fire on a synthetic snapshot. */
function runNegativeProbes() {
  const base = { 'a/reader.ts': 'const x = driver.licenseNumber', 'a/gate.ts': 'await getIntegrationAdminPrincipal()' }
  const reader = (files) => (file) => files[file] ?? ''
  const probes = [
    ['unlisted reader', { ...base, 'a/new.ts': 'row.externalPersonKey' }, { 'a/reader.ts': { disposition: 'd2l', owner: 'x' } }, /unlisted ВУ reader: a\/new\.ts/u],
    ['vu person-key template', { ...base, 'a/key.ts': 'const k = `vu:${n}`' }, { 'a/reader.ts': { disposition: 'd2l', owner: 'x' } }, /unlisted ВУ reader: a\/key\.ts/u],
    ['stale entry', base, { 'a/reader.ts': { disposition: 'd2l', owner: 'x' }, 'a/gone.ts': { disposition: 'd2l', owner: 'x' } }, /stale inventory entry .*a\/gone\.ts/u],
    ['guard removed', { ...base, 'a/gate.ts': 'nothing' }, { 'a/reader.ts': { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: 'a/gate.ts' } }, /guard getIntegrationAdminPrincipal: the guard is gone/u],
    ['guard only in PATCH, GET ungated', { 'a/reader.ts': 'const x = driver.licenseNumber', 'a/route.ts': "export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) { const row = await prisma.contact.findUnique({ where: { id: '1' } }); return row }\nexport async function PATCH(req: Request) { if (!await getIntegrationAdminPrincipal()) return null; return 1 }" }, { 'a/reader.ts': { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: 'a/route.ts' } }, /the guard is missing in GET in a\/route\.ts/u],
    ['guard after the first read', { 'a/reader.ts': 'const x = driver.licenseNumber', 'a/route.ts': 'export async function GET(req: Request) { const rows = await prisma.driver.findMany({ select: { id: true } }); if (!await getIntegrationAdminPrincipal()) return null; return rows }' }, { 'a/reader.ts': { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: 'a/route.ts' } }, /GET reads data before the guard/u],
    ['every handler guarded first', { 'a/reader.ts': 'const x = driver.licenseNumber', 'a/route.ts': 'export async function GET(req: Request) { if (!await getIntegrationAdminPrincipal()) return null; return await prisma.driver.findMany({ select: { id: true } }) }\nexport async function POST(req: Request) { if (!await getIntegrationAdminPrincipal()) return null; const body = await req.json(); return body }' }, { 'a/reader.ts': { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: 'a/route.ts' } }, null],
    ['mask missing', base, { 'a/reader.ts': { disposition: 'masked' } }, /masked reader without maskDriverLicenceV1/u],
    ['logged carrier', { 'a/reader.ts': "console.error('x', row.normalizedVu)" }, { 'a/reader.ts': { disposition: 'owner_internal' } }, /log or error text prints a ВУ carrier/u],
    ['thrown carrier', { 'a/reader.ts': 'throw new Error(`bad ${driver.licenseNumber}`)' }, { 'a/reader.ts': { disposition: 'owner_internal' } }, /log or error text prints a ВУ carrier/u],
    ['field name is not a value', { 'a/reader.ts': "throw new TypeError('licenseNumber must be a string'); const v = row.licenseNumber" }, { 'a/reader.ts': { disposition: 'owner_internal' } }, null],
    ['full Driver row without select', { ...base, 'a/row.ts': 'await prisma.driver.findMany({ where: { id } })' }, { 'a/reader.ts': { disposition: 'd2l', owner: 'x' } }, /unlisted ВУ reader: a\/row\.ts/u],
    ['Driver relation included whole', { ...base, 'a/inc.ts': 'prisma.chat.findMany({ include: { driver: true } })' }, { 'a/reader.ts': { disposition: 'd2l', owner: 'x' } }, /unlisted ВУ reader: a\/inc\.ts/u],
    ['raw SQL string', { ...base, 'a/sql.ts': 'prisma.$queryRawUnsafe(\'SELECT "licenseNumber" FROM "Driver"\')' }, { 'a/reader.ts': { disposition: 'd2l', owner: 'x' } }, /unlisted ВУ reader: a\/sql\.ts/u],
    ['British spelling', { ...base, 'a/uk.ts': 'searchProfilesByLicence(licence)' }, { 'a/reader.ts': { disposition: 'd2l', owner: 'x' } }, /unlisted ВУ reader: a\/uk\.ts/u],
    ['conduit type', { ...base, 'a/type.ts': 'let r: ReferralSearchResponse' }, { 'a/reader.ts': { disposition: 'd2l', owner: 'x' } }, /unlisted ВУ reader: a\/type\.ts/u],
    ['comment only is not a reader', { 'a/reader.ts': 'const x = driver.licenseNumber', 'a/c.ts': '// licenseNumber is never read here\nconst y = 1' }, { 'a/reader.ts': { disposition: 'd2l', owner: 'x' } }, null],
    ['selected Driver read is not a row', { 'a/reader.ts': 'const x = driver.licenseNumber', 'a/s.ts': 'prisma.driver.findMany({ select: { id: true } })' }, { 'a/reader.ts': { disposition: 'd2l', owner: 'x' } }, null],
    ['d2l without owner', base, { 'a/reader.ts': { disposition: 'd2l' } }, /d2l entry without an owner/u],
  ]
  for (const [name, files, inventory, expected] of probes) {
    const readFile = reader(files)
    const violations = licenceReaderViolations(inventory, discoverLicenceReaders(Object.keys(files), readFile), readFile)
    if (expected === null) assert.deepEqual(violations, [], `probe «${name}» flagged a field name: ${JSON.stringify(violations)}`)
    else assert(violations.some((violation) => expected.test(violation)), `negative probe «${name}» did not fire: ${JSON.stringify(violations)}`)
  }
  return probes.length
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const discovered = discoverLicenceReaders(trackedFiles(), read)
  const violations = licenceReaderViolations(LICENCE_READERS, discovered, read)
  assert.deepEqual(violations, [], `driver-licence reader inventory drift:\n${violations.join('\n')}`)
  const probes = runNegativeProbes()
  const byDisposition = {}
  for (const entry of Object.values(LICENCE_READERS)) byDisposition[entry.disposition] = (byDisposition[entry.disposition] ?? 0) + 1
  const pendingMask = Object.entries(LICENCE_READERS).filter(([, entry]) => entry.becomes === 'masked').map(([file]) => file)
  process.stdout.write(`${JSON.stringify({ control: 'driver-licence-readers', status: 'PASS', readers: discovered.length, by_disposition: byDisposition, d2_condition_admin_only_until_masked: pendingMask.length, negative_probes: probes })}\n`)
}
