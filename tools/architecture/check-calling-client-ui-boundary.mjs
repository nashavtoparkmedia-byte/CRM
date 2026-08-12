#!/usr/bin/env node

import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { scanArchitecture } from './enforce-architecture.mjs'

const root = process.cwd()
const read = (relative) => readFileSync(path.join(root, relative), 'utf8')
const sha256 = (source) => createHash('sha256').update(source).digest('hex')

const callingConsumers = new Map([
  ['gravity-mvp/src/app/calls/page.tsx', 'client-ui/CallsList'],
  ['gravity-mvp/src/app/messages/components/ChatHeader.tsx', 'client-ui/CallButton'],
  ['gravity-mvp/src/app/messages/components/ChatList.tsx', 'client-ui/CallToolbar'],
  ['gravity-mvp/src/app/messages/components/ContactProfileDrawer.tsx', 'client-ui/CallButton'],
  ['gravity-mvp/src/app/layout.tsx', 'client-ui/IncomingCallPopup'],
  ['gravity-mvp/src/components/layout/TopBar.tsx', 'client-ui/CallToolbar'],
  ['gravity-mvp/src/app/settings/integrations/telephony/TelephonyConnectionClient.tsx', 'client-ui/TelephonyTabs'],
  ['gravity-mvp/src/app/settings/integrations/telephony-ai/TelephonyAiClient.tsx', 'client-ui/TelephonyTabs'],
])

for (const [consumer, capability] of callingConsumers) {
  const source = read(consumer)
  assert.match(source, new RegExp(`@/modules/calling/public/v1/${capability}`))
  assert.doesNotMatch(source, /@\/components\/sip\//)
}

const driverPage = read('gravity-mvp/src/app/drivers/[id]/page.tsx')
for (const name of ['DriverCallButton', 'DriverCallsList', 'DriverAiMockCallButton']) {
  assert.match(driverPage, new RegExp(`@/modules/fleet-operations/internal/client-ui/${name}`))
}
assert.doesNotMatch(driverPage, /@\/modules\/calling\//)
assert.doesNotMatch(driverPage, /@\/components\/sip\//)

const callingUi = {
  ActiveCallPopup: 'f7700d253b859ee01b43f89cc7ba8af0fb068a13f49042b8c1fd18a56490fdf3',
  AiMockCallButton: '0f43b263af489520593cb4548bf65431ac6d10632099242f1b0a6d664874983b',
  CallButton: 'b9f554840500cead890682042236df2568fb8d3024a72ea163b88df32942d51e',
  CallToolbar: '20a7882a3baf097e68058bef84d95cf7c51d6e76f3a86831e73a6cd75001544e',
  CallsList: 'a3170cf9229a7f5f209da37973bd220da5824b76468a8046cff198ec9e016303',
  IncomingCallPopup: '204e10ff13102736b2ea13eab60d98d9d9c57a29a3a47045a69fd5bcdaf9c6a7',
}
for (const [name, expected] of Object.entries(callingUi)) {
  const implementation = read(`gravity-mvp/src/modules/calling/public/v1/client-ui/${name}.tsx`)
  assert.equal(sha256(implementation), expected)
  const shim = read(`gravity-mvp/src/components/sip/${name}.tsx`)
  assert.match(shim, new RegExp(`@/modules/calling/public/v1/client-ui/${name}`))
  assert.doesNotMatch(shim, /export \*/)
}

const telephonyTabs = read('gravity-mvp/src/modules/calling/public/v1/client-ui/TelephonyTabs.tsx')
assert.equal(sha256(telephonyTabs), '1fa174a67b8763590b1ec2059076a5e290cd53e6dd60646abf9715bbd5faedc8')
assert.match(telephonyTabs, /export type TelephonyTabKey = 'connection' \| 'ai'/)
assert.match(telephonyTabs, /export default function TelephonyTabs/)
assert.doesNotMatch(telephonyTabs, /export \*|@\/lib\/prisma|fetch\(/)
const unrelatedTabProbe = `${telephonyTabs}\nexport function ProviderCredentialsTab() { return null }\n`
assert.notEqual(
  [...unrelatedTabProbe.matchAll(/export\s+(?:default\s+)?function\s+(\w+)/g)].map((match) => match[1]).join(','),
  'TelephonyTabs',
)

const audio = read('gravity-mvp/src/modules/calling/public/v1/call-alert-audio.ts')
assert.equal(sha256(audio), '8b6cd6047ac4853f5317cc60bcf5b7d7a61aa9910cebabdc4eb0f69118758d97')
assert.match(audio, /export async function startIncomingRingtone/)
assert.doesNotMatch(audio, /@\/lib\/prisma|\$queryRaw|\$executeRaw/)
const audioShim = read('gravity-mvp/src/lib/sip/callAlertAudio.ts')
assert.match(audioShim, /@\/modules\/calling\/public\/v1\/call-alert-audio/)
assert.doesNotMatch(audioShim, /export \*/)

const bridge = read('gravity-mvp/src/infrastructure/ui/calling-client-capability.tsx')
assert.equal(sha256(bridge), 'a6d98724fcad0474b6f024242d744a1bcc8117de70fda6c2762ce86fa35c9823')
assert.match(bridge, /interface OutboundCallingClientCapability/)
assert.match(bridge, /hasActiveCall: boolean/)
assert.match(bridge, /startPlaceholderOutbound\(phoneNumber: string, displayName\?: string \| null\): void/)
assert.match(bridge, /cancelPlaceholderOutbound\(\): void/)
assert.match(bridge, /setActiveCallFsUuid\(fsUuid: string\): void/)
assert.doesNotMatch(bridge, /fetch\(|@\/modules\/|@\/lib\/prisma|answer\(|hangup\(|toggleMute/)

const sipProvider = read('gravity-mvp/src/modules/calling/public/v1/sip-client-context.tsx')
assert.match(sipProvider, /<OutboundCallingClientProvider value=\{\{ status, hasActiveCall: !!activeCall, startPlaceholderOutbound, cancelPlaceholderOutbound, setActiveCallFsUuid \}\}>/)

const fleetButton = read('gravity-mvp/src/modules/fleet-operations/internal/client-ui/DriverCallButton.tsx')
assert.match(fleetButton, /useOutboundCallingClient/)
assert.doesNotMatch(fleetButton, /@\/modules\/calling\//)
assert.equal(
  fleetButton
    .replace("import { useOutboundCallingClient } from '@/infrastructure/ui/calling-client-capability'", "import { useSip } from '@/modules/calling/public/v1/sip-client-context'")
    .replace('const { status, hasActiveCall: activeCall, startPlaceholderOutbound, cancelPlaceholderOutbound, setActiveCallFsUuid } = useOutboundCallingClient()', 'const { status, activeCall, startPlaceholderOutbound, cancelPlaceholderOutbound, setActiveCallFsUuid } = useSip()'),
  read('gravity-mvp/src/modules/calling/public/v1/client-ui/CallButton.tsx'),
)
assert.equal(
  read('gravity-mvp/src/modules/fleet-operations/internal/client-ui/DriverCallsList.tsx'),
  read('gravity-mvp/src/modules/calling/public/v1/client-ui/CallsList.tsx'),
)
assert.equal(
  read('gravity-mvp/src/modules/fleet-operations/internal/client-ui/DriverAiMockCallButton.tsx'),
  read('gravity-mvp/src/modules/calling/public/v1/client-ui/AiMockCallButton.tsx'),
)

const manifest = JSON.parse(read('architecture/contexts/v1/manifests/calling.json'))
assert(manifest.public_surface.includes('CallingClientUi.v1'))
assert(manifest.public_surface.includes('CallAlertAudio.v1'))

const scan = await scanArchitecture(root)
assert.deepEqual(scan.findings.filter((finding) => finding.rule === 'dependency_graph_cycle'), [])
assert.deepEqual(scan.findings.filter((finding) =>
  finding.details?.target?.includes('/components/sip/')
  || finding.details?.target === 'gravity-mvp/src/lib/sip/callAlertAudio.ts'), [])

const registry = JSON.parse(read('architecture/enforcement/v1/exceptions.json'))
const live = new Set(scan.findings.map((finding) => finding.fingerprint))
assert.equal(registry.exceptions.filter((entry) => !live.has(entry.fingerprint)).length, 0)

process.stdout.write(`${JSON.stringify({
  status: 'PASS',
  calling_consumers: callingConsumers.size,
  fleet_adapters: 3,
  dependency_cycles: 0,
  current_findings: scan.findings.length,
  registry_entries: registry.exceptions.length,
}, null, 2)}\n`)
