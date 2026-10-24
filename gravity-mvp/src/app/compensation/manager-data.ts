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

import { MANAGER_BOARD_ALL_STATES } from './money'

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

/**
 * The board, read for one filter.
 *
 * With neither a month nor a status chosen it opens as the inbox: every
 * application still waiting for a manager's decision (the backend's `new`
 * state), whatever month its budget belongs to, newest first. An October claim
 * filed on 2 November is therefore on the first screen, and still charged to
 * October. A chosen month narrows the list to that budget month; a chosen
 * status (or `all`) narrows or widens it across months. The budget summary is
 * always one month's own figures: the chosen month, or the current one.
 */
export async function managerBoard(filter: ManagerBoardFilterV1) {
    const chosenMonth = typeof filter.periodKey === 'string' && filter.periodKey !== '' ? filter.periodKey : null
    const chosenState = typeof filter.state === 'string' && filter.state !== '' ? filter.state : null
    const inbox = chosenMonth === null && chosenState === null
    const periodKey = chosenMonth ?? compensationManagerPeriodKeyV1()
    const [budget, list, parks] = await Promise.all([
        compensationManagerBudgetV1(periodKey),
        compensationManagerApplicationsV1({
            periodKey: chosenMonth,
            state: inbox ? 'new' : chosenState === MANAGER_BOARD_ALL_STATES ? null : chosenState,
            externalParkId: filter.externalParkId ?? null,
            cursor: filter.cursor ?? null,
        }),
        managerParkOptions(),
    ])
    return { periodKey, chosenMonth, chosenState, inbox, budget, list, parks }
}

export async function managerApplication(applicationId: string) {
    return compensationManagerApplicationV1(applicationId)
}

export type ManagerEvidenceV1 =
    | { ok: true; contentType: string; bytes: Uint8Array }
    | { ok: false; reason: 'missing' | 'not_found' | 'unsupported_media' | 'too_large' | 'unavailable' }

/**
 * What an evidence file is, read from its first bytes. The type the channel
 * reports comes from the file's name, which the sender chose, so it is never
 * trusted on its own: only these signatures are served, each as itself.
 */
function evidenceMediaType(bytes: Uint8Array): string | null {
    const startsWith = (signature: readonly number[], offset = 0) =>
        bytes.length >= offset + signature.length && signature.every((value, index) => bytes[offset + index] === value)
    if (startsWith([0xff, 0xd8, 0xff])) return 'image/jpeg'
    if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
    if (startsWith([0x47, 0x49, 0x46, 0x38, 0x37, 0x61]) || startsWith([0x47, 0x49, 0x46, 0x38, 0x39, 0x61])) return 'image/gif'
    if (startsWith([0x52, 0x49, 0x46, 0x46]) && startsWith([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp'
    if (startsWith([0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf'
    return null
}

/**
 * Fetches the support reply (an image or a PDF) for one application.
 *
 * The caller names an application; the file id is resolved here and handed
 * straight to the Telegram channel, so it never reaches a browser, a URL or a
 * log line. The bytes decide the type: a file whose content is not one of the
 * formats above is refused as unsupported, whatever its name says.
 */
export async function managerEvidence(applicationId: string): Promise<ManagerEvidenceV1> {
    const source = await compensationManagerEvidenceSourceV1(applicationId)
    if (source === null) return { ok: false, reason: 'missing' }
    const file = await readTelegramBotFileV1({ fileId: source.fileId })
    if (!file.ok) return { ok: false, reason: file.reason === 'invalid_file_id' ? 'not_found' : file.reason }
    const contentType = evidenceMediaType(file.bytes)
    if (contentType === null) return { ok: false, reason: 'unsupported_media' }
    return { ok: true, contentType, bytes: file.bytes }
}
