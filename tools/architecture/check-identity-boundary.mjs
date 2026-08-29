#!/usr/bin/env node
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const root = process.cwd()
const failures = []
const checks = []
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8')
const sha256 = (relative) => createHash('sha256').update(fs.readFileSync(path.join(root, relative))).digest('hex')
const assertCheck = (name, condition, detail) => {
    if (condition) checks.push(name)
    else failures.push({ check: name, detail })
}

const contract = read('gravity-mvp/src/contracts/identity-access/v1/identity-access.ts')
const handler = read('gravity-mvp/src/modules/identity-access/public/v1/identity-access-handler.ts')
const adapter = read('gravity-mvp/src/modules/identity-access/public/v1/legacy-user-service-adapter.ts')
const actions = read('gravity-mvp/src/modules/identity-access/public/v1/identity-actions.ts')
const topBar = read('gravity-mvp/src/components/layout/TopBar.tsx')
const amendment = JSON.parse(read('architecture/isolation/identity-access/v1/module-manifest-amendments.json'))

assertCheck(
    'contract is framework, persistence and provider neutral',
    !/(?:@\/lib|next\/|@prisma|prisma|telegram|whatsapp|max-actions|freeswitch)/i.test(contract),
    'contract contains an implementation dependency',
)
assertCheck(
    'handler depends only on the versioned contract',
    handler.includes("from '../../../../contracts/identity-access/v1'")
        && !/(?:@\/lib|next\/|@prisma|prisma)/i.test(handler),
    'owner handler leaks a legacy implementation dependency',
)
assertCheck(
    'legacy user service is isolated to the owner adapter',
    adapter.includes("from '@/lib/users/user-service'")
        && !actions.includes('@/lib/users/user-service'),
    'legacy user service escaped the compatibility adapter',
)
assertCheck(
    'server action facade composes handler and adapter',
    actions.startsWith("'use server'")
        && actions.includes('createIdentityAccessHandlerV1')
        && actions.includes('legacyUserServicePortV1'),
    'public server action composition is incomplete',
)
assertCheck(
    'representative consumer has no Identity internal import',
    !topBar.includes('@/lib/users/user-service'),
    'TopBar still imports the legacy Identity implementation',
)
assertCheck(
    'representative consumer uses versioned public targets',
    topBar.includes("from '@/contracts/identity-access/v1'")
        && topBar.includes("from '@/modules/identity-access/public/v1/identity-actions'"),
    'TopBar does not use both contract and public owner surface',
)
assertCheck(
    'current-user and list queries are explicit',
    topBar.includes('CURRENT_USER_QUERY_V1')
        && topBar.includes('LIST_USER_IDENTITIES_QUERY_V1'),
    'TopBar query semantics are not explicit',
)
assertCheck(
    'authenticate and end-session commands are explicit',
    topBar.includes('AUTHENTICATE_USER_COMMAND_V1')
        && topBar.includes('END_USER_SESSION_COMMAND_V1'),
    'TopBar session mutation semantics are not explicit',
)
assertCheck(
    'navigation behavior remains preserved',
    topBar.includes('window.location.reload()')
        && topBar.includes("window.location.href = '/login'"),
    'existing post-auth navigation changed',
)
assertCheck(
    'legacy Identity implementation is byte-identical',
    sha256('gravity-mvp/src/lib/users/user-service.ts') === 'cc026e94b3907bf3d4271a6f3d79d9dd05d04e67bc2439a4cab0baa185ef2f6f'
        && sha256('gravity-mvp/src/lib/users/auth-helpers.js') === 'c935ead6eaa8e19be1b71124c6bf6fbe7d6053d77173fc446171f1a21b4af95a',
    'protected auth implementation changed during boundary migration',
)
assertCheck(
    'module amendment declares the list query',
    amendment.milestone === 'CRM-ARCH-007'
        && amendment.amendments.length === 1
        && amendment.amendments[0].context === 'identity_access'
        && amendment.amendments[0].add_public_surface.includes('ListUserIdentitiesQuery.v1'),
    'Identity public manifest amendment is incomplete',
)
assertCheck(
    'contract identifiers cannot silently change version',
    [
        'identity_access.CurrentUserQuery.v1',
        'identity_access.ListUserIdentitiesQuery.v1',
        'identity_access.AuthenticateUserCommand.v1',
        'identity_access.EndUserSessionCommand.v1',
    ].every((identifier) => contract.includes(`'${identifier}'`)),
    'expected v1 semantic identifier missing',
)

process.stdout.write(`${JSON.stringify({
    status: failures.length === 0 ? 'PASS' : 'FAIL',
    checks,
    failures,
}, null, 2)}\n`)
if (failures.length > 0) process.exitCode = 1
