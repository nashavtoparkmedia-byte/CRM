#!/usr/bin/env node

// Cash-compensation edge perimeter — boundary control.
//
// The manager surface is gated at the edge for the pilot, not by a new
// application auth subsystem, so the whole invariant lives in one file that
// the edge_delivery context owns: deploy/nginx/templates/crm.conf.template.
// This control asserts the properties the gate depends on, because nothing
// else does: no nginx syntax checker exists in this repository, and
// edge_delivery's own compatibility_strategy demands route changes be verified.
//
// What has to hold, and why each part matters:
//   - every CRM vhost that proxies to Gravity carries the gate; if one does
//     not, that hostname is an open bypass of the other;
//   - the gate is scoped to the /compensation segment by an exact match plus a
//     trailing-slash prefix, so sibling paths such as /compensationfoo and
//     every unrelated CRM route keep their current behaviour;
//   - each gated location repeats its vhost's generic proxy directives
//     verbatim, so the functional delta for the route is exactly "+ Basic
//     Auth" and nothing about proxying silently changed;
//   - the password file is read from the dedicated auth directory on the
//     read-only templates mount and never from the writable conf.d output
//     directory, and no credential material is committed. The auth directory
//     exists so that host-side traversal, not file ownership, is what keeps
//     unrelated host accounts away from the hash.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const TEMPLATE = 'deploy/nginx/templates/crm.conf.template'
const EXPECTED_SELECTORS = ['= /compensation', '^~ /compensation/']
const CREDENTIAL_PATH = '/etc/nginx/templates/auth/compensation.htpasswd'

const checks = []
const failures = []
const check = (name, ok, detail) => (ok ? checks.push(name) : failures.push({ check: name, detail }))

const source = readFileSync(TEMPLATE, 'utf8')

/** Split the template into server blocks, keeping each block's own text. */
function serverBlocks(text) {
    const blocks = []
    const pattern = /^server \{\n([\s\S]*?)^\}$/gmu
    let match
    while ((match = pattern.exec(text)) !== null) blocks.push(match[1])
    return blocks
}

/** Location selectors and their directive lines, comments stripped. */
function locations(block) {
    const found = []
    const pattern = /^    location ([^{]+)\{\n([\s\S]*?)^    \}$/gmu
    let match
    while ((match = pattern.exec(block)) !== null) {
        found.push({
            selector: match[1].trim(),
            directives: match[2]
                .split('\n')
                .map((line) => line.trim())
                .filter((line) => line.length > 0 && !line.startsWith('#')),
        })
    }
    return found
}

// Only the vhosts that actually proxy the CRM to Gravity need the gate. The
// :80 block redirects and the www block returns 301, so neither serves the
// surface; treating them as gated targets would be a false requirement.
const proxyingVhosts = serverBlocks(source)
    .map(locations)
    .filter((entries) => entries.some((entry) => (
        entry.selector === '/' && entry.directives.some((directive) => directive.startsWith('proxy_pass'))
    )))

check(
    'both CRM vhosts proxy the surface',
    proxyingVhosts.length === 2,
    `expected 2 proxying CRM vhosts, found ${proxyingVhosts.length}`,
)

for (const [index, entries] of proxyingVhosts.entries()) {
    const generic = entries.find((entry) => entry.selector === '/')
    const gated = entries.filter((entry) => entry.selector.includes('/compensation'))
    const label = `vhost ${index + 1}`

    check(
        `${label} gates exactly the compensation segment`,
        gated.length === EXPECTED_SELECTORS.length
            && EXPECTED_SELECTORS.every((selector) => gated.some((entry) => entry.selector === selector)),
        `selectors present: ${JSON.stringify(gated.map((entry) => entry.selector))}`,
    )

    for (const entry of gated) {
        const auth = entry.directives.filter((directive) => directive.startsWith('auth_basic'))
        const proxy = entry.directives.filter((directive) => !directive.startsWith('auth_basic'))

        check(
            `${label} ${entry.selector} requires Basic Auth`,
            auth.some((directive) => /^auth_basic\s+"/u.test(directive))
                && auth.some((directive) => directive === `auth_basic_user_file ${CREDENTIAL_PATH};`),
            `auth directives: ${JSON.stringify(auth)}`,
        )

        // Parity, not similarity: the gated route must proxy exactly as the
        // generic location does, so the only behavioural change is the gate.
        check(
            `${label} ${entry.selector} preserves generic proxy semantics`,
            JSON.stringify(proxy) === JSON.stringify(generic.directives),
            `only-here: ${JSON.stringify(proxy.filter((d) => !generic.directives.includes(d)))}; `
            + `missing: ${JSON.stringify(generic.directives.filter((d) => !proxy.includes(d)))}`,
        )
    }
}

// The credential is host-managed. It must be read from the read-only templates
// mount, never from conf.d, which the entrypoint writes into, and the template
// itself must never carry credential material.
check(
    'credential is read from the dedicated auth directory on the read-only mount',
    source.includes(`auth_basic_user_file ${CREDENTIAL_PATH};`)
        && !/auth_basic_user_file\s+\/etc\/nginx\/conf\.d/u.test(source)
        && !/auth_basic_user_file\s+\/etc\/nginx\/templates\/[^/]+;/u.test(source),
    'the password file must live in the auth subdirectory of the templates mount',
)

const HASH = /\$(2[aby]|apr1|[156])\$|\{SHA\}/u

check(
    'no credential material is committed in the template',
    !HASH.test(source),
    'the template appears to contain a password hash',
)

// Only the credential's exact path is git-ignored, so the auth directory stays
// visible for ordinary files. That is deliberate, and this is its safety net:
// nothing tracked under it may carry a password hash.
const trackedAuthFiles = execFileSync('git', ['ls-files', 'deploy/nginx/templates/auth'], { encoding: 'utf8' })
    .split('\n')
    .filter((line) => line.length > 0)

check(
    'no credential material is committed in the auth directory',
    trackedAuthFiles.every((file) => !HASH.test(readFileSync(file, 'utf8'))),
    `tracked files under the auth directory: ${JSON.stringify(trackedAuthFiles)}`,
)

process.stdout.write(`${JSON.stringify({
    status: failures.length ? 'FAIL' : 'PASS',
    control: 'compensation-edge-perimeter',
    surface: TEMPLATE,
    owner_context: 'edge_delivery',
    proxying_vhosts: proxyingVhosts.length,
    checks,
    failures,
}, null, 2)}\n`)

assert.equal(failures.length, 0, 'compensation edge perimeter boundary violated')
