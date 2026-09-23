import 'server-only'

import { CURRENT_USER_QUERY_V1 } from '@/contracts/identity-access/v1'
import { queryCurrentUserV1 } from '@/modules/identity-access/public/v1/identity-actions'
import {
    compensationManagerApplicationV1,
    compensationManagerApplicationsV1,
    compensationManagerBudgetV1,
    compensationManagerEvidenceSourceV1,
    compensationManagerPeriodKeyV1,
    resolveCompensationManagerPrincipalV1,
} from '@/modules/fleet-operations/public/v1'
import { listYandexConnectionMetadataV1 } from '@/modules/fleet-operations/public/v1/yandex-connection-capability'
import { readTelegramBotFileV1 } from '@/modules/telegram-channel/public/v1'

/**
 * Everything the manager screens read, in one server-only module.
 *
 * Three boundaries meet here and nowhere else: identity-access proves who is
 * acting, fleet_operations owns the applications and the money, and the
 * Telegram channel owns the bot account that holds the support screenshot. The
 * screens compose these; they never reach past them.
 *
 * Requiring a CRM session here narrows who reaches this data. It is not
 * authentication: the CRM identifies a user by an unsigned cookie, which is a
 * known systemic limitation recorded for the production rollout.
 */

/** The CRM roles that may look at compensation and act on it. */
export const MANAGER_ROLES_V1 = ['Менеджер', 'Руководитель', 'Администратор'] as const

export type ManagerSessionRefusalV1 =
    | 'not_authenticated'
    | 'user_disabled'
    | 'user_identity_incomplete'
    | 'role_not_allowed'

export type ManagerSessionV1 =
    | { ok: true; principal: { principalId: string; operatorLabel: string }; role: string }
    | { ok: false; refusal: ManagerSessionRefusalV1 }

export async function managerSession(): Promise<ManagerSessionV1> {
    const result = await queryCurrentUserV1({ contract: CURRENT_USER_QUERY_V1 })
    const user = (result as { user: unknown }).user as { role?: string } | null
    const acting = resolveCompensationManagerPrincipalV1(user as never)
    if (!acting.resolved) return { ok: false, refusal: acting.refusal }
    const role = typeof user?.role === 'string' ? user.role : ''
    if (!(MANAGER_ROLES_V1 as readonly string[]).includes(role)) {
        return { ok: false, refusal: 'role_not_allowed' }
    }
    return { ok: true, principal: acting.principal, role }
}

export interface ManagerParkOptionV1 {
    externalParkId: string
    name: string
}

export async function managerParkOptions(): Promise<ManagerParkOptionV1[]> {
    const parks = await listYandexConnectionMetadataV1()
    return parks.map((park: { parkId: string; name?: string | null }) => ({
        externalParkId: park.parkId,
        name: park.name || park.parkId,
    }))
}

export interface ManagerBoardFilterV1 {
    periodKey?: string | null
    state?: string | null
    externalParkId?: string | null
    cursor?: string | null
}

export async function managerBoard(filter: ManagerBoardFilterV1) {
    const periodKey = typeof filter.periodKey === 'string' && filter.periodKey !== ''
        ? filter.periodKey
        : compensationManagerPeriodKeyV1()
    const [budget, list, parks] = await Promise.all([
        compensationManagerBudgetV1(periodKey),
        compensationManagerApplicationsV1({
            periodKey,
            state: filter.state ?? null,
            externalParkId: filter.externalParkId ?? null,
            cursor: filter.cursor ?? null,
        }),
        managerParkOptions(),
    ])
    return { periodKey, budget, list, parks }
}

export async function managerApplication(applicationId: string) {
    return compensationManagerApplicationV1(applicationId)
}

export type ManagerEvidenceV1 =
    | { ok: true; contentType: string; bytes: Uint8Array }
    | { ok: false; reason: 'missing' | 'not_found' | 'unsupported_media' | 'too_large' | 'unavailable' }

/**
 * Fetches the support screenshot for one application.
 *
 * The caller names an application; the file id is resolved here and handed
 * straight to the Telegram channel, so it never reaches a browser, a URL or a
 * log line.
 */
export async function managerEvidence(applicationId: string): Promise<ManagerEvidenceV1> {
    const source = await compensationManagerEvidenceSourceV1(applicationId)
    if (source === null) return { ok: false, reason: 'missing' }
    const file = await readTelegramBotFileV1({ fileId: source.fileId })
    if (file.ok) return { ok: true, contentType: file.contentType, bytes: file.bytes }
    return { ok: false, reason: file.reason === 'invalid_file_id' ? 'not_found' : file.reason }
}
