'use server'

import {
    ContactConversationsQueryValidationError,
    type ContactConversationsResultV1,
} from '@/contracts/messaging/v1'
import { contactConversationsV1 } from '@/modules/messaging/public/v1'

export type ContactConversationsActionResultV1 =
    | { ok: true; result: ContactConversationsResultV1 }
    | { ok: false; error: 'invalid_query' | 'unavailable' }

/**
 * The browser's way to messaging.ContactConversationsQuery.v1. Transport glue
 * only: the query is passed to the Messaging capability as given and its answer
 * returned unchanged; validation, ordering and every rule stay in Messaging.
 *
 * An action that throws answers HTTP 500 to the page, so a failure is returned
 * as data instead. A rejected query is the caller's error; anything else means
 * no answer, which a caller must treat as no evidence at all.
 */
export async function readContactConversationsAction(query: unknown): Promise<ContactConversationsActionResultV1> {
    try {
        return { ok: true, result: await contactConversationsV1(query) }
    } catch (error: unknown) {
        if (error instanceof ContactConversationsQueryValidationError) return { ok: false, error: 'invalid_query' }
        console.error('[readContactConversationsAction] query failed:', error instanceof Error ? error.message : error)
        return { ok: false, error: 'unavailable' }
    }
}
