import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ permission: vi.fn() }))
vi.mock('@/modules/contacts/public/v1', () => ({ getContactCommunicationPermissionV1: mocks.permission }))

import { readChannelDeliveryErrorV1 } from './delivery-state-policy'
import {
    prepareOutboundConversationV1,
    proveOutboundConversationRouteV1,
    registerOutboundConversationPreparerV1,
} from './outbound-conversation-identity-runtime'

const prepared = {
    chatId: 'chat-1',
    channel: 'telegram' as const,
    contactId: 'contact-1',
    contactIdentityId: 'identity-1',
    providerAccountId: 'account-1',
    connectionId: 'connection-1',
    identityTarget: 'peer-1',
    target: 'peer-1',
    isMaxPersonal: false,
}
const snapshot = {
    id: 'chat-1',
    contactId: 'contact-1',
    contactIdentityId: 'identity-1',
    channel: 'telegram',
    externalChatId: 'telegram:peer-1',
    metadata: { providerAccountId: 'account-1', connectionId: 'connection-1' },
}

function answer(decision: 'allow' | 'deny', reason: string, retryable: boolean, extra: Record<string, unknown> = {}) {
    return {
        contract: 'contacts.ContactCommunicationPermissionResult.v1',
        decision,
        retryable,
        reason,
        requestedContactId: 'contact-1',
        communicationClass: 'message',
        canonicalContactId: decision === 'allow' ? 'canonical-1' : null,
        policyVersion: decision === 'allow' ? 3 : null,
        ...extra,
    }
}

async function refusalOf(promise: Promise<unknown>) {
    const error = await promise.then(() => null, (thrown: unknown) => thrown)
    expect(error).toBeInstanceOf(Error)
    return { message: (error as Error).message, typed: readChannelDeliveryErrorV1(error) }
}

function withPreparer(preparer = vi.fn().mockResolvedValue(prepared)) {
    const unregister = registerOutboundConversationPreparerV1(preparer)
    return { preparer, unregister }
}

describe('Messaging outbound conversation identity runtime', () => {
    beforeEach(() => {
        mocks.permission.mockReset()
        mocks.permission.mockResolvedValue(answer('allow', 'no_restriction', false))
    })

    test('delegates the exact snapshot and requested transport to the composed Platform Shell proof', async () => {
        const { preparer, unregister } = withPreparer()
        await expect(prepareOutboundConversationV1(snapshot, 'connection-1'))
            .resolves.toEqual({ ...prepared, contactPermission: { canonicalContactId: 'canonical-1', policyVersion: 3 } })
        expect(preparer).toHaveBeenCalledWith(snapshot, 'connection-1')
        unregister()
        await expect(prepareOutboundConversationV1(snapshot))
            .rejects.toThrow('OUTBOUND_CONVERSATION_IDENTITY_CAPABILITY_NOT_REGISTERED')
        await expect(proveOutboundConversationRouteV1(snapshot))
            .rejects.toThrow('OUTBOUND_CONVERSATION_IDENTITY_CAPABILITY_NOT_REGISTERED')
    })

    test('reads the Contacts message permission fresh, for the Contact the proof names, on every call', async () => {
        const { unregister } = withPreparer(vi.fn().mockResolvedValue({ ...prepared, contactId: 'contact-from-proof' }))
        mocks.permission.mockResolvedValue(answer('allow', 'no_restriction', false, { requestedContactId: 'contact-from-proof' }))
        await prepareOutboundConversationV1({ ...snapshot, contactId: 'caller-supplied' })
        await prepareOutboundConversationV1({ ...snapshot, contactId: 'caller-supplied' })
        expect(mocks.permission).toHaveBeenCalledTimes(2)
        expect(mocks.permission).toHaveBeenCalledWith({
            contract: 'contacts.ContactCommunicationPermissionQuery.v1',
            contactId: 'contact-from-proof',
            communicationClass: 'message',
        })
        unregister()
    })

    test('refuses a standing restriction as terminal, before any binding is returned', async () => {
        const { unregister } = withPreparer()
        for (const reason of ['restricted_all', 'restricted_message', 'contact_unknown', 'contact_archived', 'unsupported_communication_class']) {
            mocks.permission.mockResolvedValue(answer('deny', reason, false))
            expect(await refusalOf(prepareOutboundConversationV1(snapshot))).toEqual({
                message: `MESSAGING_CONTACT_PERMISSION_REFUSED:${reason}`,
                typed: { outcome: 'terminal', code: 'MESSAGING_CONTACT_PERMISSION_REFUSED' },
            })
        }
        unregister()
    })

    test('refuses an unestablished store or lineage as not dispatched, safe to redeliver', async () => {
        const { unregister } = withPreparer()
        for (const reason of ['policy_unavailable', 'lineage_unsafe']) {
            mocks.permission.mockResolvedValue(answer('deny', reason, true))
            expect(await refusalOf(prepareOutboundConversationV1(snapshot))).toEqual({
                message: `MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED:${reason}`,
                typed: { outcome: 'safe_to_redeliver', code: 'MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED' },
            })
        }
        mocks.permission.mockRejectedValue(new Error('connection reset'))
        expect(await refusalOf(prepareOutboundConversationV1(snapshot))).toEqual({
            message: 'MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED:policy_unavailable',
            typed: { outcome: 'safe_to_redeliver', code: 'MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED' },
        })
        unregister()
    })

    test('never allows on an answer it cannot read (fail closed, not dispatched)', async () => {
        const { unregister } = withPreparer()
        for (const unreadable of [
            null,
            undefined,
            'allow',
            {},
            answer('allow', 'no_restriction', false, { canonicalContactId: null }),
            answer('allow', 'no_restriction', false, { canonicalContactId: '' }),
            answer('allow', 'no_restriction', false, { policyVersion: null }),
            answer('allow', 'no_restriction', false, { policyVersion: 1.5 }),
            answer('allow', 'no_restriction', false, { requestedContactId: 'contact-2' }),
            answer('deny', 'restricted_all', true, { decision: 'maybe' }),
        ]) {
            mocks.permission.mockResolvedValue(unreadable)
            const refusal = await refusalOf(prepareOutboundConversationV1(snapshot))
            expect(refusal.typed).toEqual({ outcome: 'safe_to_redeliver', code: 'MESSAGING_CONTACT_PERMISSION_NOT_DISPATCHED' })
        }
        unregister()
    })

    test('reads no permission when the route proof itself refuses', async () => {
        const { unregister } = withPreparer(vi.fn().mockRejectedValue(new Error('CONTACT_CONVERSATION_NOT_PRIVATE')))
        await expect(prepareOutboundConversationV1(snapshot)).rejects.toThrow('CONTACT_CONVERSATION_NOT_PRIVATE')
        expect(mocks.permission).not.toHaveBeenCalled()
        unregister()
    })

    test('proves a route without reading or applying any permission', async () => {
        const { preparer, unregister } = withPreparer()
        mocks.permission.mockResolvedValue(answer('deny', 'restricted_all', false))
        await expect(proveOutboundConversationRouteV1(snapshot, 'connection-1')).resolves.toEqual(prepared)
        expect(preparer).toHaveBeenCalledWith(snapshot, 'connection-1')
        expect(mocks.permission).not.toHaveBeenCalled()
        unregister()
    })
})
