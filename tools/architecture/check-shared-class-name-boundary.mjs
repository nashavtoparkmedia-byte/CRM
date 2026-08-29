#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const consumers = [
  'gravity-mvp/src/app/dashboard/components/DashboardCard.tsx',
  'gravity-mvp/src/app/drivers/DriversClient.tsx',
  'gravity-mvp/src/app/drivers/components/SegmentCards.tsx',
  'gravity-mvp/src/app/settings/integrations/avito/page.tsx',
  'gravity-mvp/src/components/Sidebar.tsx',
  'gravity-mvp/src/components/ui/EmptyState.tsx',
  'gravity-mvp/src/components/ui/avatar.tsx',
  'gravity-mvp/src/components/ui/checkbox.tsx',
  'gravity-mvp/src/components/ui/dropdown-menu.tsx',
  'gravity-mvp/src/components/ui/label.tsx',
  'gravity-mvp/src/components/ui/select.tsx',
  'gravity-mvp/src/components/ui/separator.tsx',
  'gravity-mvp/src/components/ui/sheet.tsx',
  'gravity-mvp/src/components/ui/skeleton.tsx',
  'gravity-mvp/src/components/ui/switch.tsx',
  'gravity-mvp/src/infrastructure/ui/SectionDescription.tsx',
  'gravity-mvp/src/infrastructure/ui/badge.tsx',
  'gravity-mvp/src/infrastructure/ui/button.tsx',
  'gravity-mvp/src/infrastructure/ui/card.tsx',
  'gravity-mvp/src/infrastructure/ui/dialog.tsx',
  'gravity-mvp/src/infrastructure/ui/input.tsx',
  'gravity-mvp/src/infrastructure/ui/table.tsx',
  'gravity-mvp/src/infrastructure/ui/tabs.tsx',
  'gravity-mvp/src/infrastructure/ui/tooltip.tsx',
]

for (const consumer of consumers) {
  const source = read(consumer)
  assert.doesNotMatch(source, /@\/lib\/utils/)
  assert.match(source, /@\/infrastructure\/ui\/class-names/)
}

const shim = read('gravity-mvp/src/lib/utils.ts')
assert.match(shim, /export \{ cn \} from '@\/infrastructure\/ui\/class-names'/)
assert.doesNotMatch(shim, /export \*/)

const implementation = read('gravity-mvp/src/infrastructure/ui/class-names.ts')
assert.match(implementation, /clsx/)
assert.match(implementation, /twMerge/)
assert.doesNotMatch(implementation, /@\/lib\/prisma|Service|Repository|\$queryRaw|\$executeRaw/)

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file) && finding.details?.target === 'gravity-mvp/src/lib/utils.ts'), [])
assert.deepEqual(scan.findings.filter((finding) =>
  consumers.includes(finding.file) && finding.details?.target?.endsWith('/infrastructure/ui/class-names.ts')), [])

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const live = new Set(scan.findings.map((finding) => finding.fingerprint))
assert.equal(registry.exceptions.filter((entry) =>
  consumers.includes(entry.file) && !live.has(entry.fingerprint)).length, 0)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  consumers: consumers.length,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
