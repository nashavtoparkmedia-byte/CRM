import { NextRequest } from 'next/server'
import { beforeEach, describe, expect, test, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
    getContext: vi.fn(),
    getLinkedDriverPhone: vi.fn(),
    search: vi.fn(),
    persist: vi.fn(),
    merge: vi.fn(),
    principal: vi.fn(),
}))

vi.mock('@/modules/contacts/public/v1', () => ({
    getContactParkCheckContextV1: mocks.getContext,
    persistContactParkCheckResultV1: mocks.persist,
}))

vi.mock('@/modules/fleet-operations/public/v1', () => ({
    getParkLinkedDriverPhoneV1: mocks.getLinkedDriverPhone,
    normalizeParkPhoneDigitsV1: (value: unknown) => String(value ?? '').replace(/\D/g, ''),
    searchYandexParksByPhonesV1: mocks.search,
}))

vi.mock('@/modules/platform-shell/internal/contact-park-merge-orchestrator', () => ({
    attemptAutomaticContactMergeFromPlatformV1: mocks.merge,
}))
vi.mock('@/modules/identity-access/public/v1', async importOriginal => ({
    ...await importOriginal<typeof import('@/modules/identity-access/public/v1')>(),
    getIntegrationAdminPrincipal: mocks.principal,
}))

import { POST } from './route'

const request = new NextRequest('https://crm.example/api/contacts/contact-1/parks', {
    method: 'POST',
    headers: { host: 'crm.example', origin: 'https://crm.example' },
})
const context = { params: Promise.resolve({ id: 'contact-1' }) }

function profile(overrides: Record<string, unknown> = {}) {
    return {
        id: 'profile-1',
        driverId: 'driver-1',
        profileClusterKey: 'cluster-1',
        contactId: 'contact-2',
        clusterWarnings: [],
        contactMergeCandidateIds: [],
        fullName: 'Иван Иванов',
        phones: ['+79990000000'],
        matchedPhones: ['+79990000000'],
        workStatus: 'working',
        currentStatus: 'working',
        ...overrides,
    }
}

function result(overrides: Record<string, unknown> = {}) {
    return {
        checkedParks: 2,
        results: [],
        errors: [],
        ...overrides,
    }
}

describe('Contact park check reliability boundary', () => {
    beforeEach(() => {
        vi.clearAllMocks()
        mocks.getContext.mockResolvedValue({ activePhones: ['+79990000000'], yandexDriverId: null })
        mocks.getLinkedDriverPhone.mockResolvedValue(null)
        mocks.persist.mockResolvedValue(true)
        mocks.principal.mockResolvedValue({
            id: 'identity-access:integration-admin-session',
            kind: 'integration_admin_session',
        })
    })

    test('rejects unsigned and cross-origin checks before every read, provider call, or mutation', async () => {
        mocks.principal.mockResolvedValueOnce(null)
        const unauthorized = await POST(request, context)
        expect(unauthorized.status).toBe(401)

        const crossOrigin = await POST(new NextRequest(
            'https://crm.example/api/contacts/contact-1/parks',
            {
                method: 'POST',
                headers: { host: 'crm.example', origin: 'https://attacker.example' },
            },
        ), context)
        expect(crossOrigin.status).toBe(403)
        expect(mocks.principal).toHaveBeenCalledTimes(1)
        expect(mocks.getContext).not.toHaveBeenCalled()
        expect(mocks.getLinkedDriverPhone).not.toHaveBeenCalled()
        expect(mocks.search).not.toHaveBeenCalled()
        expect(mocks.merge).not.toHaveBeenCalled()
        expect(mocks.persist).not.toHaveBeenCalled()
    })

    test('reports no profiles as not_found only after complete provider coverage', async () => {
        mocks.search.mockResolvedValue(result())

        const response = await POST(request, context)
        const body = await response.json()

        expect(body).toMatchObject({ checkStatus: 'complete', driverLink: { status: 'not_found' } })
        expect(mocks.merge).not.toHaveBeenCalled()
        expect(mocks.persist).toHaveBeenCalledWith('contact-1', expect.objectContaining({
            checkStatus: 'complete',
            driverLink: expect.objectContaining({ status: 'not_found' }),
        }))
    })

    test('does not turn a partial empty response into authoritative not_found', async () => {
        mocks.search.mockResolvedValue(result({
            errors: [{ parkId: 'park-2', parkName: 'Park 2', message: 'timeout' }],
        }))

        const body = await (await POST(request, context)).json()

        expect(body).toMatchObject({ checkStatus: 'partial', driverLink: { status: 'review_required' } })
        expect(mocks.merge).not.toHaveBeenCalled()
        expect(mocks.persist).toHaveBeenCalledWith('contact-1', expect.objectContaining({ checkStatus: 'partial' }))
    })

    test('classifies total provider failure and configured-zero coverage as failed attempts', async () => {
        mocks.search.mockResolvedValueOnce(result({
            errors: [
                { parkId: 'park-1', parkName: 'Park 1', message: 'timeout' },
                { parkId: 'park-2', parkName: 'Park 2', message: 'timeout' },
            ],
        }))
        const failed = await (await POST(request, context)).json()
        expect(failed).toMatchObject({ checkStatus: 'failed', driverLink: { status: 'error' } })

        mocks.search.mockResolvedValueOnce(result({ checkedParks: 0 }))
        const noParksResponse = await POST(request, context)
        const noParks = await noParksResponse.json()
        expect(noParksResponse.status).toBe(503)
        expect(noParks).toMatchObject({ error: 'NO_PARKS', checkStatus: 'failed', driverLink: { status: 'error' } })
        expect(mocks.persist).toHaveBeenLastCalledWith('contact-1', expect.objectContaining({ checkStatus: 'failed' }))
        expect(mocks.merge).not.toHaveBeenCalled()
    })

    test('never automatically merges a foreign Contact from partial coverage', async () => {
        mocks.search.mockResolvedValue(result({
            results: [{ parkId: 'park-1', parkName: 'Park 1', profiles: [profile()] }],
            errors: [{ parkId: 'park-2', parkName: 'Park 2', message: 'timeout' }],
        }))

        const body = await (await POST(request, context)).json()

        expect(body).toMatchObject({ checkStatus: 'partial', driverLink: { status: 'review_required' } })
        expect(mocks.merge).not.toHaveBeenCalled()
    })

    test('keeps equal provider profile IDs in different parks distinct without a cluster key', async () => {
        mocks.search.mockResolvedValue(result({
            results: [
                { parkId: 'park-1', parkName: 'Park 1', profiles: [profile({ profileClusterKey: undefined })] },
                { parkId: 'park-2', parkName: 'Park 2', profiles: [profile({ profileClusterKey: undefined })] },
            ],
        }))

        const body = await (await POST(request, context)).json()

        expect(body.driverLink.status).toBe('ambiguous')
        expect(body.identityClusters).toHaveLength(2)
        expect(body.identityClusters.map((cluster: { profileClusterKey: string }) => cluster.profileClusterKey)).toEqual([
            'park-profile:park-1:profile-1',
            'park-profile:park-2:profile-1',
        ])
        expect(mocks.merge).not.toHaveBeenCalled()
    })

    test('unions cluster Contact IDs, merge candidates, and warnings and forces review', async () => {
        mocks.search.mockResolvedValue(result({
            results: [
                {
                    parkId: 'park-1',
                    parkName: 'Park 1',
                    profiles: [profile({
                        contactId: 'contact-2',
                        contactMergeCandidateIds: ['contact-3'],
                        clusterWarnings: ['partial_cluster_evidence'],
                    })],
                },
                {
                    parkId: 'park-2',
                    parkName: 'Park 2',
                    profiles: [profile({
                        id: 'profile-2',
                        driverId: 'driver-2',
                        contactId: 'contact-4',
                        contactMergeCandidateIds: ['contact-2', 'contact-3'],
                        clusterWarnings: ['confirmed_person_contradiction', 'partial_cluster_evidence'],
                    })],
                },
            ],
        }))

        const body = await (await POST(request, context)).json()

        expect(body.driverLink.status).toBe('review_required')
        expect(body.identityClusters).toEqual([expect.objectContaining({
            profileClusterKey: 'cluster-1',
            profileKeys: ['park-1:profile-1', 'park-2:profile-2'],
            contactIds: ['contact-2', 'contact-4'],
            contactMergeCandidateIds: ['contact-2', 'contact-3'],
            warnings: ['confirmed_person_contradiction', 'partial_cluster_evidence'],
            driverIds: ['driver-1', 'driver-2'],
        })])
        expect(mocks.merge).not.toHaveBeenCalled()
    })

    test('allows the existing exact-pair merge capability only on clean complete evidence', async () => {
        mocks.search
            .mockResolvedValueOnce(result({
                results: [{ parkId: 'park-1', parkName: 'Park 1', profiles: [profile()] }],
            }))
            .mockResolvedValueOnce(result({
                results: [{ parkId: 'park-1', parkName: 'Park 1', profiles: [profile({ contactId: 'contact-2' })] }],
            }))
        mocks.merge.mockResolvedValue({ status: 'merged', survivorContactId: 'contact-2' })

        const body = await (await POST(request, context)).json()

        expect(mocks.merge).toHaveBeenCalledWith('contact-1', 'contact-2')
        expect(mocks.search).toHaveBeenCalledTimes(2)
        expect(body).toMatchObject({ checkStatus: 'complete', driverLink: { status: 'merged', contactId: 'contact-2' } })
        expect(mocks.persist).toHaveBeenCalledWith('contact-2', expect.objectContaining({ checkStatus: 'complete' }))
    })

    test('fails closed on partial evidence from the bounded rerun after a clean-owner merge', async () => {
        mocks.search
            .mockResolvedValueOnce(result({
                results: [{ parkId: 'park-1', parkName: 'Park 1', profiles: [profile()] }],
            }))
            .mockResolvedValueOnce(result({
                results: [{ parkId: 'park-1', parkName: 'Park 1', profiles: [profile({ contactId: 'contact-2' })] }],
                errors: [{ parkId: 'park-2', parkName: 'Park 2', message: 'timeout' }],
            }))
        mocks.merge.mockResolvedValue({ status: 'merged', survivorContactId: 'contact-2' })

        const body = await (await POST(request, context)).json()

        expect(mocks.merge).toHaveBeenCalledTimes(1)
        expect(mocks.search).toHaveBeenCalledTimes(2)
        expect(body).toMatchObject({
            checkStatus: 'partial',
            automaticMerge: { status: 'merged', survivorContactId: 'contact-2' },
            driverLink: { status: 'review_required', contactId: 'contact-2' },
        })
        expect(mocks.persist).toHaveBeenCalledWith('contact-2', expect.objectContaining({
            checkStatus: 'partial',
            driverLink: expect.objectContaining({ status: 'review_required' }),
        }))
    })

    test('evaluates a reconciler-issued exact pair and reruns Fleet once after merge', async () => {
        mocks.search
            .mockResolvedValueOnce(result({
                results: [{
                    parkId: 'park-1',
                    parkName: 'Park 1',
                    profiles: [profile({
                        contactId: null,
                        clusterWarnings: ['contact_auto_merge_candidate'],
                        contactMergeCandidateIds: ['contact-2', 'contact-1'],
                    })],
                }],
            }))
            .mockResolvedValueOnce(result({
                results: [{
                    parkId: 'park-1',
                    parkName: 'Park 1',
                    profiles: [profile({
                        contactId: 'contact-2',
                        clusterWarnings: [],
                        contactMergeCandidateIds: [],
                    })],
                }],
            }))
        mocks.merge.mockResolvedValue({ status: 'merged', survivorContactId: 'contact-2' })

        const body = await (await POST(request, context)).json()

        expect(mocks.merge).toHaveBeenCalledWith('contact-1', 'contact-2')
        expect(mocks.search).toHaveBeenCalledTimes(2)
        expect(body).toMatchObject({
            checkStatus: 'complete',
            automaticMerge: { status: 'merged', survivorContactId: 'contact-2' },
            driverLink: { status: 'merged', contactId: 'contact-2' },
        })
        expect(mocks.persist).toHaveBeenCalledWith('contact-2', expect.any(Object))
    })

    test('fails closed when the bounded rerun reports a different clean Contact owner', async () => {
        mocks.search
            .mockResolvedValueOnce(result({
                results: [{
                    parkId: 'park-1',
                    parkName: 'Park 1',
                    profiles: [profile({
                        contactId: null,
                        clusterWarnings: ['contact_auto_merge_candidate'],
                        contactMergeCandidateIds: ['contact-1', 'contact-2'],
                    })],
                }],
            }))
            .mockResolvedValueOnce(result({
                results: [{
                    parkId: 'park-1',
                    parkName: 'Park 1',
                    profiles: [profile({
                        contactId: 'contact-3',
                        clusterWarnings: [],
                        contactMergeCandidateIds: [],
                    })],
                }],
            }))
        mocks.merge.mockResolvedValue({ status: 'merged', survivorContactId: 'contact-2' })

        const body = await (await POST(request, context)).json()

        expect(mocks.merge).toHaveBeenCalledTimes(1)
        expect(mocks.merge).toHaveBeenCalledWith('contact-1', 'contact-2')
        expect(mocks.search).toHaveBeenCalledTimes(2)
        expect(body).toMatchObject({
            automaticMerge: { status: 'merged', survivorContactId: 'contact-2' },
            driverLink: {
                status: 'ambiguous',
                contactId: 'contact-2',
                driverId: 'driver-1',
            },
        })
        expect(mocks.persist).toHaveBeenCalledWith('contact-2', expect.objectContaining({
            driverLink: expect.objectContaining({ status: 'ambiguous' }),
        }))
    })
})
