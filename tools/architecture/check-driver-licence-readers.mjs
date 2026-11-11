#!/usr/bin/env node
// Driver-licence (ВУ) reader inventory (Owner D2, OD-03; Security D2 criterion 4).
//
// The full ВУ number may be shown to an Администратор only; Менеджер and
// Руководитель see its last four characters, and the decision is Contacts' read
// authority (ContactReadAuthorityQuery.v1) applied by Fleet's mask. This control
// keeps an exact inventory of every non-test source file that touches the ВУ
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
//                    names the guard and `gateFile` where it is (verified here).
//   masked         — a D2 surface that must mask by licenceView
//                    (maskDriverLicenceV1, verified here).
//   d2l            — a legacy screen that still shows the full ВУ on the legacy
//                    perimeter; the P1 «D2-L» moves it to personal sign-in and the
//                    mask. `owner` names the context that executes it.
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

export const LICENCE_CARRIER = /\blicen[cs]e(?:Number|History|_number)\b|\bdriver_?licen[cs]e\b|\bdriverLicen[cs]e\b|\bexternalPersonKey\b|\bprofileClusterKey\b|\bnormalizedVu\b|\brawVu\b|`vu:\$\{/u
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
const P = 'gravity-mvp/src/'

/** The exact inventory. Keys are repository paths. */
export const LICENCE_READERS = {
  [`${P}app/api/bot-link/route.ts`]: { disposition: 'admin_only', gate: 'hasIntegrationAdminAccess' },
  [`${P}app/api/contacts/[id]/driver-person/route.ts`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal' },
  [`${P}app/api/contacts/[id]/parks/route.ts`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal' },
  [`${P}app/api/contacts/[id]/route.ts`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', note: 'Messages contact panel (licenseHistory); D2-L moves it to the reader authority and the mask' },
  [`${P}app/api/monitoring/attention/route.ts`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/api/monitoring/drivers/[id]/fleet-check/route.ts`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/api/monitoring/drivers/route.ts`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/api/webhooks/bot/route.ts`]: { disposition: 'owner_internal', note: 'bot webhook compares the person key to find a driver\'s parks; it returns no key' },
  [`${P}app/compensation/referrals/ReferralManager.tsx`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/compensation/referrals/page.tsx`, note: 'D2: masked by licenceView once the referral reads move onto ContactReadAuthorityQuery.v1 (after #214)' },
  [`${P}app/compensation/referrals/referral-data.ts`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/compensation/referrals/page.tsx`, note: 'D2: masked after #214' },
  [`${P}app/compensation/referrals/view.ts`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/compensation/referrals/page.tsx`, note: 'D2: masked after #214' },
  [`${P}app/drivers/actions.ts`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/drivers/archive/ArchiveClient.tsx`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/messages/components/ContactEvidenceDetails.tsx`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/api/contacts/[id]/route.ts`, note: 'renders /api/contacts/[id]; D2-L' },
  [`${P}app/messages/components/DriverPersonSearchModal.tsx`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/api/contacts/[id]/driver-person/route.ts`, note: 'renders /api/contacts/[id]/driver-person; D2-L' },
  [`${P}app/messages/hooks/useContact.ts`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/api/contacts/[id]/route.ts`, note: 'fetches /api/contacts/[id]; D2-L' },
  [`${P}app/monitoring/MonitoringClient.tsx`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/monitoring/components/AllDriversSection.tsx`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/monitoring/components/AttentionSection.tsx`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/monitoring/lib/types.ts`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/monitoring/page.tsx`]: { disposition: 'd2l', owner: fleet },
  [`${P}app/settings/integrations/bot/BotPageClient.tsx`]: { disposition: 'admin_only', gate: 'requireIntegrationAdminPageAccess', gateFile: `${P}app/settings/integrations/bot/page.tsx`, note: 'its data comes from /api/bot-link (hasIntegrationAdminAccess)' },
  [`${P}app/tasks/components/TaskCaseListHeader.tsx`]: { disposition: 'd2l', owner: work },
  [`${P}app/tasks/excel-actions.ts`]: { disposition: 'd2l', owner: work },
  [`${P}contracts/contacts/v1/driver-person-confirmation-command.ts`]: { disposition: 'evidence_key' },
  [`${P}contracts/fleet-operations/v1/resolve-imported-driver-command.ts`]: { disposition: 'command_input' },
  [`${P}lib/tasks/excel-contract.ts`]: { disposition: 'd2l', owner: work },
  [`${P}lib/tasks/list-columns.ts`]: { disposition: 'd2l', owner: work },
  [`${P}lib/tasks/list-renderers.tsx`]: { disposition: 'd2l', owner: work },
  [`${P}lib/tasks/list-views.ts`]: { disposition: 'd2l', owner: work },
  [`${P}lib/tasks/scenario-config.ts`]: { disposition: 'd2l', owner: work },
  [`${P}lib/tasks/scenario-fields.ts`]: { disposition: 'd2l', owner: work },
  [`${P}modules/contacts/internal/contact-merge-state-composer.ts`]: { disposition: 'evidence_key' },
  [`${P}modules/contacts/internal/contact-person-card.ts`]: { disposition: 'evidence_key', note: 'the card carries only the count of confirmed cluster keys, never a key' },
  [`${P}modules/contacts/public/v1/contact-merge-handler.ts`]: { disposition: 'evidence_key' },
  [`${P}modules/contacts/public/v1/driver-person-confirmation.ts`]: { disposition: 'evidence_key' },
  [`${P}modules/contacts/public/v1/legacy-prisma-contact-merge-adapter.ts`]: { disposition: 'evidence_key' },
  [`${P}modules/fleet-operations/internal/compensation/cash-referral-manager-service.ts`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/compensation/referrals/page.tsx`, note: 'referral search by licence; D2: masked after #214' },
  [`${P}modules/fleet-operations/internal/compensation/cash-referral-manager.ts`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/compensation/referrals/page.tsx`, note: 'D2: masked after #214' },
  [`${P}modules/fleet-operations/internal/compensation/compensation-referral-ledger.ts`]: { disposition: 'owner_internal', note: 'stores a digest of the person key, never the key' },
  [`${P}modules/fleet-operations/internal/compensation/compensation-referral-qualification.ts`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/internal/compensation/compensation-referral-service.ts`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/internal/compensation/legacy-prisma-cash-referral-decision-adapter.ts`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/internal/compensation/legacy-prisma-cash-referral-manager-adapter.ts`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/compensation/referrals/page.tsx`, note: 'D2: masked after #214' },
  [`${P}modules/fleet-operations/internal/legacy-prisma-yandex-fleet-reconciler-adapter.ts`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/public/v1/legacy-prisma-driver-license-maintenance-adapter.js`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/public/v1/legacy-prisma-resolve-imported-driver-adapter.ts`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/public/v1/monitoring-ui/ActionButtons.tsx`]: { disposition: 'd2l', owner: fleet },
  [`${P}modules/fleet-operations/public/v1/monitoring-ui/FleetCheckModal.tsx`]: { disposition: 'd2l', owner: fleet },
  [`${P}modules/fleet-operations/public/v1/park-phone-search.ts`]: { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: `${P}app/api/contacts/[id]/parks/route.ts`, note: 'returns the profile ВУ to /api/contacts/[id]/parks and /api/bot-link, both integration-admin' },
  [`${P}modules/fleet-operations/public/v1/resolve-imported-driver-handler.ts`]: { disposition: 'owner_internal' },
  [`${P}modules/fleet-operations/public/v1/yandex-fleet-reconciler.ts`]: { disposition: 'owner_internal' },
}

const DISPOSITIONS = new Set(['owner_internal', 'evidence_key', 'command_input', 'admin_only', 'masked', 'd2l'])

/** Every tracked non-test code file under the source roots that names a ВУ carrier. */
export function discoverLicenceReaders(files, readFile) {
  return files
    .filter((file) => CODE_FILE.test(file) && !TEST_FILE.test(file))
    .filter((file) => LICENCE_CARRIER.test(readFile(file)))
    .sort()
}

/** The violations of one inventory against one source snapshot. */
export function licenceReaderViolations(inventory, discovered, readFile) {
  const violations = []
  const listed = new Set(Object.keys(inventory))
  for (const file of discovered) {
    if (!listed.has(file)) violations.push(`unlisted ВУ reader: ${file}`)
    if (printsLicenceCarrier(readFile(file))) violations.push(`a log or error text prints a ВУ carrier: ${file}`)
  }
  const found = new Set(discovered)
  for (const [file, entry] of Object.entries(inventory)) {
    if (!DISPOSITIONS.has(entry.disposition)) violations.push(`unknown disposition ${entry.disposition}: ${file}`)
    if (!found.has(file)) violations.push(`stale inventory entry (no longer reads the ВУ): ${file}`)
    if (entry.disposition === 'admin_only') {
      const token = ADMIN_GATES[entry.gate]
      const gateFile = entry.gateFile ?? file
      if (!token) violations.push(`admin_only without a known gate: ${file}`)
      else if (!readFile(gateFile).includes(token)) violations.push(`admin_only guard ${entry.gate} is gone from ${gateFile} (for ${file})`)
    }
    if (entry.disposition === 'masked' && found.has(file) && !readFile(file).includes('maskDriverLicenceV1')) {
      violations.push(`masked reader without maskDriverLicenceV1: ${file}`)
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
    ['guard removed', { ...base, 'a/gate.ts': 'nothing' }, { 'a/reader.ts': { disposition: 'admin_only', gate: 'getIntegrationAdminPrincipal', gateFile: 'a/gate.ts' } }, /guard getIntegrationAdminPrincipal is gone/u],
    ['mask missing', base, { 'a/reader.ts': { disposition: 'masked' } }, /masked reader without maskDriverLicenceV1/u],
    ['logged carrier', { 'a/reader.ts': "console.error('x', row.normalizedVu)" }, { 'a/reader.ts': { disposition: 'owner_internal' } }, /log or error text prints a ВУ carrier/u],
    ['thrown carrier', { 'a/reader.ts': 'throw new Error(`bad ${driver.licenseNumber}`)' }, { 'a/reader.ts': { disposition: 'owner_internal' } }, /log or error text prints a ВУ carrier/u],
    ['field name is not a value', { 'a/reader.ts': "throw new TypeError('licenseNumber must be a string'); const v = row.licenseNumber" }, { 'a/reader.ts': { disposition: 'owner_internal' } }, null],
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
  process.stdout.write(`${JSON.stringify({ control: 'driver-licence-readers', status: 'PASS', readers: discovered.length, by_disposition: byDisposition, negative_probes: probes })}\n`)
}
