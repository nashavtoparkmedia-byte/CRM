import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    identityFindUnique: vi.fn(),
    identityFindMany: vi.fn(),
    identityUpdate: vi.fn(),
    contactFindMany: vi.fn(),
    contactUpdate: vi.fn(),
    lockRows: vi.fn(),
    assertPostconditions: vi.fn(),
}))

const transaction = {
    contactIdentity: {
        findUnique: mocks.identityFindUnique,
        findMany: mocks.identityFindMany,
        update: mocks.identityUpdate,
    },
    contact: {
        findMany: mocks.contactFindMany,
        update: mocks.contactUpdate,
    },
}

vi.mock('@/modules/contacts/internal/contact-ownership-coordinator', () => ({
    runContactOwnershipTransaction: (work: (tx: typeof transaction) => unknown) => work(transaction),
    lockContactOwnershipRows: mocks.lockRows,
    assertContactOwnershipPostconditions: mocks.assertPostconditions,
}))

import { attachProviderIdentityAliasV1 } from './contact-phone-evidence'

const command = {
    identityId: 'identity-a',
    channel: 'whatsapp' as const,
    providerAccountId: 'wa-account-a',
    aliasType: 'wa_lid' as const,
    aliasValue: 'opaque-peer@lid',
    provenance: 'whatsapp-web.js',
    evidenceRoot: 'wa:wa-account-a:opaque-peer@lid',
}

function identity(id: string, contactId: string) {
    return {
        id,
        contactId,
        externalId: id === 'identity-b' ? 'other-primary@c.us' : 'identity-a@lid',
        channel: 'whatsapp',
        isActive: true,
        metadata: {
            providerAccountId: 'wa-account-a',
            providerAliasValues: id === 'identity-b' ? ['opaque-peer@lid'] : [],
        },
    }
}

describe('provider identity alias ownership', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.lockRows.mockResolvedValue({
            contactIds: ['contact-a', 'contact-b'],
            identityIds: ['identity-a', 'identity-b'],
            phoneIds: [],
            normalizedPhones: [],
            mergeIds: [],
        })
        mocks.identityUpdate.mockResolvedValue({})
        mocks.contactUpdate.mockResolvedValue({})
    })

    test('commits a bounded conflict on both owners before reporting an alias collision', async () => {
        mocks.identityFindUnique.mockResolvedValue(identity('identity-a', 'contact-a'))
        mocks.identityFindMany.mockResolvedValue([identity('identity-b', 'contact-b')])
        mocks.contactFindMany.mockResolvedValue([
            { id: 'contact-a', customFields: {} },
            { id: 'contact-b', customFields: {} },
        ])

        await expect(attachProviderIdentityAliasV1(command))
            .rejects.toThrow('IDENTITY_ALIAS_COLLISION')

        expect(mocks.contactUpdate).toHaveBeenCalledTimes(2)
        for (const call of mocks.contactUpdate.mock.calls) {
            const conflict = call[0].data.customFields.identityConflicts[0]
            expect(conflict).toMatchObject({
                conflictType: 'provider_identity_alias_collision',
                evidenceRoot: command.evidenceRoot,
                status: 'open',
                details: {
                    channel: 'whatsapp',
                    providerAccountId: 'wa-account-a',
                    aliasType: 'wa_lid',
                    aliasValue: 'opaque-peer@lid',
                },
            })
        }
        expect(mocks.identityUpdate).toHaveBeenCalledTimes(2)
        expect(mocks.identityUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'identity-a' },
            data: { metadata: expect.objectContaining({ conflictState: 'conflicted' }) },
        }))
        expect(mocks.identityUpdate).toHaveBeenCalledWith(expect.objectContaining({
            where: { id: 'identity-b' },
            data: { metadata: expect.objectContaining({ conflictState: 'conflicted' }) },
        }))
        expect(mocks.assertPostconditions).toHaveBeenCalled()
    })

    test('attaches a non-colliding alias without marking the identity conflicted', async () => {
        mocks.identityFindUnique.mockResolvedValue(identity('identity-a', 'contact-a'))
        mocks.identityFindMany.mockResolvedValue([])

        await expect(attachProviderIdentityAliasV1(command)).resolves.toMatchObject({
            identityId: 'identity-a',
            aliasType: 'wa_lid',
            aliasValue: 'opaque-peer@lid',
        })
        expect(mocks.contactUpdate).not.toHaveBeenCalled()
        expect(mocks.identityUpdate).toHaveBeenCalledTimes(1)
        expect(mocks.identityUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: { metadata: expect.objectContaining({
                providerAliasValues: ['opaque-peer@lid'],
            }) },
        }))
    })

    test('treats an alias colliding with another Contact primary identity as a durable conflict', async () => {
        mocks.identityFindUnique.mockResolvedValue(identity('identity-a', 'contact-a'))
        mocks.identityFindMany.mockResolvedValue([{
            ...identity('identity-b', 'contact-b'),
            externalId: command.aliasValue,
            metadata: { providerAccountId: command.providerAccountId },
        }])
        mocks.contactFindMany.mockResolvedValue([
            { id: 'contact-a', customFields: {} },
            { id: 'contact-b', customFields: {} },
        ])

        await expect(attachProviderIdentityAliasV1(command))
            .rejects.toThrow('IDENTITY_ALIAS_COLLISION')
        expect(mocks.contactUpdate).toHaveBeenCalledTimes(2)
        expect(mocks.identityUpdate).toHaveBeenCalledTimes(2)
    })

    describe('the identity account stamp is not person authority', () => {
        test.each([
            ['carries no stamp (every production WhatsApp identity)', {}],
            ['was first stamped by another connection', { providerAccountId: 'wa-account-first-seen' }],
        ])('attaches a provider-proven alias to an identity that %s', async (_label, stamp) => {
            mocks.identityFindUnique.mockResolvedValue({
                ...identity('identity-a', 'contact-a'),
                metadata: { ...stamp, providerAliasValues: [] },
            })
            mocks.identityFindMany.mockResolvedValue([])

            await expect(attachProviderIdentityAliasV1(command)).resolves.toMatchObject({
                identityId: 'identity-a',
                aliasValue: 'opaque-peer@lid',
            })
            expect(mocks.identityUpdate).toHaveBeenCalledOnce()
            expect(mocks.identityUpdate).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: 'identity-a' },
                data: { metadata: expect.objectContaining({ providerAliasValues: ['opaque-peer@lid'] }) },
            }))
            expect(mocks.contactUpdate).not.toHaveBeenCalled()
        })

        test('an alias owned by another Contact under a different account stamp is still a genuine collision', async () => {
            // The account difference used to filter this candidate out, hiding a real
            // cross-person contradiction and attaching the alias to both people.
            mocks.identityFindUnique.mockResolvedValue(identity('identity-a', 'contact-a'))
            mocks.identityFindMany.mockResolvedValue([{
                ...identity('identity-b', 'contact-b'),
                metadata: { providerAccountId: 'wa-account-other', providerAliasValues: ['opaque-peer@lid'] },
            }])
            mocks.contactFindMany.mockResolvedValue([
                { id: 'contact-a', customFields: {} },
                { id: 'contact-b', customFields: {} },
            ])

            await expect(attachProviderIdentityAliasV1(command))
                .rejects.toThrow('IDENTITY_ALIAS_COLLISION')
            expect(mocks.contactUpdate).toHaveBeenCalledTimes(2)
            expect(mocks.identityUpdate).toHaveBeenCalledWith(expect.objectContaining({
                where: { id: 'identity-b' },
                data: { metadata: expect.objectContaining({ conflictState: 'conflicted' }) },
            }))
            // Neither identity gains the alias: the only updates mark both conflicted.
            expect(mocks.identityUpdate).toHaveBeenCalledTimes(2)
            for (const [call] of mocks.identityUpdate.mock.calls) {
                expect(call.data.metadata.conflictState).toBe('conflicted')
                expect(call.data.metadata.providerAliases).toBeUndefined()
            }
        })

        test('the same Contact\'s redundant primary under another stamp is recognised, not duplicated', async () => {
            mocks.identityFindUnique.mockResolvedValue(identity('identity-a', 'contact-a'))
            mocks.identityFindMany.mockResolvedValue([{
                ...identity('identity-b', 'contact-a'),
                externalId: command.aliasValue,
                metadata: { providerAccountId: 'wa-account-other' },
            }])

            // The already-owned outcome attaches nothing and writes nothing.
            await expect(attachProviderIdentityAliasV1(command)).resolves.toMatchObject({
                identityId: 'identity-a',
                aliasValue: 'opaque-peer@lid',
            })
            expect(mocks.identityUpdate).not.toHaveBeenCalled()
            expect(mocks.contactUpdate).not.toHaveBeenCalled()
        })

        test.each([
            ['an inactive identity', { isActive: false }],
            ['an identity on another channel', { channel: 'telegram' }],
        ])('still refuses %s', async (_label, override) => {
            mocks.identityFindUnique.mockResolvedValue({ ...identity('identity-a', 'contact-a'), ...override })

            await expect(attachProviderIdentityAliasV1(command)).rejects.toThrow('IDENTITY_ALIAS_SCOPE_MISMATCH')
            expect(mocks.identityFindMany).not.toHaveBeenCalled()
            expect(mocks.identityUpdate).not.toHaveBeenCalled()
        })
    })
})
