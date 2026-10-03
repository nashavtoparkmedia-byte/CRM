#!/usr/bin/env node

/**
 * identity_access owns the mobile push provider, through its mobile-delivery
 * internal boundary.
 *
 * The invariant this milestone introduced: the FCM adapter, its configuration
 * and the provider credential names belong to the mobile-delivery boundary
 * inside identity_access, and every other context - Messaging and Calling
 * included - reaches mobile notification delivery only through its public
 * capability, never the internal.
 *
 * mobile-delivery is a code boundary, not a bounded context: the owning context
 * is identity_access, which already owns device registration, eligibility and
 * the session binding a delivery is resolved against.
 *
 * Deliberately narrow. It does not re-check what the generic architecture
 * controls already enforce, and it is not a repository dependency linter: it
 * asserts provider ownership, and the import rule that makes that ownership
 * real, and nothing else.
 *
 * Semantic rather than filename-shaped: a rename inside the context does not
 * weaken it, because the rule is "nothing outside the context imports the
 * context's internal", and the manifest half is keyed on environment names.
 */

import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const sourceRoot = 'gravity-mvp/src'
const contextDir = 'gravity-mvp/src/modules/identity-access'
const boundaryDir = 'gravity-mvp/src/modules/identity-access/internal/mobile-delivery'
const boundaryPublicDir = 'gravity-mvp/src/modules/identity-access/public/v1/mobile-delivery'
const boundaryApplicationFile = 'gravity-mvp/src/modules/identity-access/application/mobile-delivery-operations.ts'
const internalDir = boundaryDir
const manifestDir = 'architecture/contexts/v1/manifests'

/** The provider credential names this context owns after the relocation. */
const PROVIDER_ENV_NAMES = [
    'MOBILE_PUSH_ENABLED',
    'MOBILE_PUSH_FCM_ALLOW_LOOPBACK_OVERRIDE',
    'MOBILE_PUSH_FCM_CLIENT_EMAIL',
    'MOBILE_PUSH_FCM_ENDPOINT_OVERRIDE',
    'MOBILE_PUSH_FCM_PRIVATE_KEY',
    'MOBILE_PUSH_FCM_PROJECT_ID',
]

const checks = []
const failures = []
const check = (name, condition, detail) => (condition ? checks.push(name) : failures.push({ name, detail }))

const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const sourceFiles = (directory) => fs.readdirSync(path.join(root, directory), { withFileTypes: true })
    .flatMap((entry) => {
        const relative = `${directory}/${entry.name}`
        if (entry.isDirectory()) return sourceFiles(relative)
        return /\.(?:ts|tsx)$/.test(entry.name) ? [relative] : []
    })

/** Every module specifier a file imports or re-exports from. */
function importSpecifiers(source) {
    const specifiers = []
    const pattern = /(?:import|export)\s[^;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/gu
    let match
    while ((match = pattern.exec(source)) !== null) specifiers.push(match[1] ?? match[2] ?? match[3])
    return specifiers
}

/**
 * Does this specifier, resolved from this file, reach mobile_delivery's
 * internal? Covers the aliased form and every relative spelling, so a caller
 * cannot climb out and back in with `../`.
 */
function reachesContextInternal(fromFile, specifier) {
    if (/^@\/modules\/identity-access\/internal\/mobile-delivery(?:\/|$)/u.test(specifier)) return true
    if (!specifier.startsWith('.')) return false
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(fromFile), specifier))
    return resolved === internalDir || resolved.startsWith(`${internalDir}/`)
}

/**
 * The boundary is its internal, the application operation that fronts it, and
 * the public facade that re-exports that operation. Those are the sanctioned
 * route in - the same route identity_access's other capabilities take - so they
 * count as inside. Everything else in the repository is outside.
 */
const insideBoundary = (file) => file === boundaryApplicationFile
    || [boundaryDir, boundaryPublicDir].some((directory) => file === directory || file.startsWith(`${directory}/`))

// ── 1. nothing outside the context imports the context's internal ───────────
const offenders = []
for (const file of sourceFiles(sourceRoot)) {
    if (insideBoundary(file)) continue
    for (const specifier of importSpecifiers(read(file))) {
        if (reachesContextInternal(file, specifier)) offenders.push({ file, specifier })
    }
}
check(
    'nothing outside the mobile-delivery boundary imports its internal provider implementation',
    offenders.length === 0,
    JSON.stringify(offenders),
)

// ── 2. the provider implementation actually lives in the context ────────────
const internalFiles = fs.existsSync(path.join(root, internalDir)) ? sourceFiles(internalDir) : []
const providerCarriers = internalFiles.filter((file) => /fcm/iu.test(path.basename(file)))
check(
    'the FCM provider adapter is implemented inside the mobile-delivery boundary',
    providerCarriers.length > 0,
    `no FCM implementation found under ${internalDir}`,
)

// ── 3. no other context carries a provider implementation of its own ────────
const strayProviders = sourceFiles(sourceRoot)
    .filter((file) => !file.startsWith(`${boundaryDir}/`))
    .filter((file) => /fcm-http|fcm-transport/iu.test(path.basename(file)))
check(
    'no code outside the mobile-delivery boundary carries an FCM provider implementation',
    strayProviders.length === 0,
    JSON.stringify(strayProviders),
)

// ── 4. the public surface stays narrow: no configuration or credential ──────
const publicIndex = read(`${contextDir}/public/v1/mobile-delivery/index.ts`)
const leaked = ['readFcmTransportConfigV1', 'createFcmHttpV1TransportV1', 'FcmTransportConfigV1', 'MobilePushEnvironmentV1']
    .filter((name) => new RegExp(`\\b${name}\\b`, 'u').test(publicIndex))
check(
    'the mobile-delivery public capability exposes no provider configuration or adapter factory',
    leaked.length === 0,
    JSON.stringify(leaked),
)

// ── 5. manifest ownership matches the code ──────────────────────────────────
const manifestOf = (id) => JSON.parse(read(`${manifestDir}/${id}.json`))
const envNamesOf = (id) => (manifestOf(id).credential_relationships?.environment_names ?? [])
const owner = manifestOf('identity_access')
const missing = PROVIDER_ENV_NAMES.filter((name) => !envNamesOf('identity_access').includes(name))
check(
    'identity_access declares ownership of every mobile push provider credential name',
    missing.length === 0,
    JSON.stringify(missing),
)
const retained = PROVIDER_ENV_NAMES.filter((name) => envNamesOf('messaging').includes(name))
check(
    'messaging no longer declares ownership of a mobile push provider credential name',
    retained.length === 0,
    JSON.stringify(retained),
)
check(
    'identity_access owns the mobile-delivery module and contract paths',
    [contextDir, 'gravity-mvp/src/contracts/identity-access'].every((path) => owner.owned_paths.includes(path)),
    JSON.stringify(owner.owned_paths),
)
check(
    'the owning context declares the FCM provider relationship',
    (owner.provider_relationships ?? []).some((entry) => /fcm/iu.test(entry.name)),
    JSON.stringify(owner.provider_relationships),
)
check(
    'credential values still may not cross a public contract',
    (owner.forbidden_dependencies ?? []).includes('credentialValuesInContracts'),
    JSON.stringify(owner.forbidden_dependencies),
)

// ── 6. mobile-delivery is a code boundary, not a bounded context ────────────
const contextIds = new Set(JSON.parse(read('architecture/contexts/v1/context-index.json'))
    .contexts.map((entry) => entry.context))
check(
    'mobile_delivery is not registered as a bounded context',
    !contextIds.has('mobile_delivery'),
    'a mobile_delivery context manifest exists',
)

// ── 7. consumers reach only the public capability ───────────────────────────
for (const consumer of ['messaging', 'calling']) {
    const reaches = sourceFiles(`${sourceRoot}/modules/${consumer}`)
        .flatMap((file) => importSpecifiers(read(file)).map((specifier) => ({ file, specifier })))
        .filter(({ specifier }) => /mobile-delivery/u.test(specifier))
    const nonPublic = reaches.filter(({ specifier }) =>
        !/public\/v1\/mobile-delivery/u.test(specifier))
    check(
        `${consumer} reaches mobile delivery only through its public capability or contract`,
        nonPublic.length === 0,
        JSON.stringify(nonPublic),
    )
}

// ── fail-closed: the detector must actually detect ──────────────────────────
const probes = [
    { name: 'aliased internal import', file: 'gravity-mvp/src/modules/messaging/x.ts', specifier: '@/modules/identity-access/internal/mobile-delivery/fcm-http-v1-transport' },
    { name: 'relative climb into internal', file: 'gravity-mvp/src/modules/calling/internal/y.ts', specifier: '../../identity-access/internal/mobile-delivery/mobile-delivery-config' },
]
const undetected = probes.filter((probe) => !reachesContextInternal(probe.file, probe.specifier))
check('the detector flags a synthetic violation of each shape', undetected.length === 0, JSON.stringify(undetected))
const falsePositives = [
    { file: 'gravity-mvp/src/modules/messaging/x.ts', specifier: '@/modules/identity-access/public/v1/mobile-delivery' },
    { file: 'gravity-mvp/src/modules/calling/x.ts', specifier: '@/contracts/identity-access/v1' },
].filter((probe) => reachesContextInternal(probe.file, probe.specifier))
check('the detector does not flag the permitted public and contract routes', falsePositives.length === 0, JSON.stringify(falsePositives))

process.stdout.write(`${JSON.stringify({
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    checks,
    failures,
    scanned_files: sourceFiles(sourceRoot).length,
    context_internal_files: internalFiles.length,
    negative_probes: probes.length + falsePositives.length,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
