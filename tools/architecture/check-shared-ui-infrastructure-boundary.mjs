#!/usr/bin/env node

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const legacyTargets = [
  'gravity-mvp/src/components/ui/PageContainer.tsx',
  'gravity-mvp/src/components/ui/button.tsx',
  'gravity-mvp/src/components/layout/PageShell.tsx',
  'gravity-mvp/src/components/ui/input.tsx',
  'gravity-mvp/src/components/ui/SectionDescription.tsx',
  'gravity-mvp/src/components/ui/dialog.tsx',
  'gravity-mvp/src/components/ui/badge.tsx',
  'gravity-mvp/src/components/layout/PageHeader.tsx',
  'gravity-mvp/src/components/ui/table.tsx',
  'gravity-mvp/src/components/ui/tooltip.tsx',
  'gravity-mvp/src/components/ui/card.tsx',
  'gravity-mvp/src/components/ui/tabs.tsx',
  'gravity-mvp/src/components/ui/checkbox.tsx',
  'gravity-mvp/src/components/ui/label.tsx',
  'gravity-mvp/src/components/ui/DashboardTabs.tsx',
  'gravity-mvp/src/components/ui/DateTimePicker.tsx',
  'gravity-mvp/src/components/Header.tsx',
  'gravity-mvp/src/components/NeumorphicCard.tsx',
]
const replacements = [
  ['gravity-mvp/src/infrastructure/ui/PageContainer.tsx', /export function PageContainer/],
  ['gravity-mvp/src/infrastructure/ui/button.tsx', /const Button = React\.forwardRef/],
  ['gravity-mvp/src/infrastructure/ui/PageShell.tsx', /export function PageShell/],
  ['gravity-mvp/src/infrastructure/ui/input.tsx', /const Input = React\.forwardRef/],
  ['gravity-mvp/src/infrastructure/ui/SectionDescription.tsx', /export function SectionDescription/],
  ['gravity-mvp/src/infrastructure/ui/dialog.tsx', /const Dialog = DialogPrimitive\.Root/],
  ['gravity-mvp/src/infrastructure/ui/badge.tsx', /function Badge/],
  ['gravity-mvp/src/infrastructure/ui/PageHeader.tsx', /export function PageHeader/],
  ['gravity-mvp/src/infrastructure/ui/table.tsx', /const Table = React\.forwardRef/],
  ['gravity-mvp/src/infrastructure/ui/tooltip.tsx', /const Tooltip = TooltipPrimitive\.Root/],
  ['gravity-mvp/src/infrastructure/ui/card.tsx', /const Card = React\.forwardRef/],
  ['gravity-mvp/src/infrastructure/ui/tabs.tsx', /const Tabs = TabsPrimitive\.Root/],
  ['gravity-mvp/src/infrastructure/ui/checkbox.tsx', /const Checkbox = React\.forwardRef/],
  ['gravity-mvp/src/infrastructure/ui/label.tsx', /const Label = React\.forwardRef/],
  ['gravity-mvp/src/infrastructure/ui/DashboardTabs.tsx', /export function DashboardTabs/],
  ['gravity-mvp/src/infrastructure/ui/DateTimePicker.tsx', /export default function DateTimePicker/],
  ['gravity-mvp/src/infrastructure/ui/Header.tsx', /export default function Header/],
  ['gravity-mvp/src/infrastructure/ui/NeumorphicCard.tsx', /export default function NeumorphicCard/],
]

for (const [file, implementation] of replacements) {
  const source = read(file)
  assert.match(source, implementation)
  assert.doesNotMatch(source, /export \*|@\/components\/(?:ui\/PageContainer|ui\/button|layout\/PageShell)/)
}
for (const legacy of legacyTargets) {
  const source = read(legacy)
  assert.match(source, /@deprecated/)
  assert.match(source, /@\/infrastructure\/ui\//)
  assert.doesNotMatch(source, /function PageContainer|React\.forwardRef|function PageShell/)
}

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
assert.equal(registry.exceptions.filter((entry) =>
  legacyTargets.some((target) => entry.subject.endsWith(`:${target}`))).length, 0)
const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) =>
  legacyTargets.includes(finding.details?.target)), [])

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  extracted_implementations: replacements.length,
  retired_findings: 444,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
