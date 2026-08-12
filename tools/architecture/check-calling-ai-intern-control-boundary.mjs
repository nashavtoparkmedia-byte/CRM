#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')
const componentPath = 'gravity-mvp/src/app/messages/components/AiInternToggle.tsx'
const oldTargetPath = 'gravity-mvp/src/app/settings/ai/actions.ts'
const actionsPath = 'gravity-mvp/src/modules/calling/public/v1/ai-intern-control-actions.ts'
const adapterPath = 'gravity-mvp/src/modules/calling/public/v1/legacy-prisma-ai-intern-control-adapter.ts'
const exactCapabilities = ['getAiInternStateV1', 'setAiInternStateV1']

function capabilityNames(source) {
    return [...source.matchAll(/export async function (\w+)/g)]
        .map((match) => match[1])
        .sort()
}

const component = read(componentPath)
const actions = read(actionsPath)
const adapter = read(adapterPath)

assert.deepEqual(capabilityNames(actions), exactCapabilities)
assert.doesNotMatch(actions, /apiKeyEncrypted|providerCredential|export \*/)
const unrelatedWriteProbe = `${actions}\nexport async function setAiProviderCredentialV1() {}\n`
assert.notDeepEqual(capabilityNames(unrelatedWriteProbe), exactCapabilities)

assert.match(component, /@\/modules\/calling\/public\/v1\/ai-intern-control-actions/)
assert.doesNotMatch(component, /@\/app\/settings\/ai\/actions/)
assert.match(component, /result\.internEnabled \?\? true/)
assert.match(component, /setEnabled\(newVal\)/)
assert.match(component, /setEnabled\(!newVal\)/)
assert.match(component, /SET_AI_INTERN_STATE_COMMAND_V1/)

for (const capability of exactCapabilities) {
    const offset = actions.indexOf(`export async function ${capability}`)
    const body = actions.slice(offset, actions.indexOf('\n}', offset) + 2)
    assert(body.indexOf('requireIntegrationAdminAccess()') < body.indexOf('aiInternControl.'))
}
assert.match(actions, /revalidatePath\('\/settings\/ai'\)/)
assert.match(actions, /console\.error\('\[AI Config\] saveAiConfig error:', detail\)/)
assert.match(actions, /throw new Error\(`Не удалось сохранить настройки AI: \$\{detail\}`\)/)

assert.match(adapter, /select: \{ internEnabled: true \}/)
assert.match(adapter, /entries: \[\{ field: 'internEnabled', value: enabled \}\]/)
assert.doesNotMatch(adapter, /apiKeyEncrypted|providerCredential/)
assert.equal(
    sha256(read('gravity-mvp/src/modules/calling/public/v1/legacy-prisma-ai-agent-config-adapter.ts')),
    '09113bfcb337d061d9234e39158d47e90d5b319b1ef4aecb7e7a24c123b553f2',
)

const callingManifest = JSON.parse(read('architecture/contexts/v1/manifests/calling.json'))
const messagingManifest = JSON.parse(read('architecture/contexts/v1/manifests/messaging.json'))
assert(callingManifest.public_surface.includes('AiInternControl.v1'))
assert(callingManifest.commands.includes('SetAiInternStateCommand.v1'))
assert(messagingManifest.allowed_dependencies.some((dependency) => (
    dependency.context === 'calling' && dependency.surface === 'calling.public'
)))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => (
    finding.file === componentPath && finding.details?.target === oldTargetPath
)), [])
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])

process.stdout.write(`${JSON.stringify({
    status: 'PASS',
    runtime_consumers: 1,
    read_capabilities: 1,
    write_capabilities: 1,
    negative_unrelated_write_probe: 'REJECTED',
    credential_fields_exposed: 0,
    dependency_cycle: 'ABSENT',
    current_findings: scan.findings.length,
}, null, 2)}\n`)
