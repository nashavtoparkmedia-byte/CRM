import { describe, expect, it } from 'vitest'

import {
    classifyCashOrderParkAuthorityV1,
    crossCheckCashOrderCredentialsV1,
    type CashOrderActiveLinkV1,
    type CashOrderAuthoritySnapshotV1,
} from './cash-order-park-authority'

const YOKO = 'ext-yoko'
const OTHER = 'ext-other'

function link(overrides: Partial<CashOrderActiveLinkV1> = {}): CashOrderActiveLinkV1 {
    return {
        linkId: 'link-yoko',
        localParkId: 'park-yoko',
        linkExternalParkId: YOKO,
        parkExternalParkId: YOKO,
        apiConnectionId: 'conn-yoko',
        apiConnectionParkId: YOKO,
        ...overrides,
    }
}

function snapshot(links: CashOrderActiveLinkV1[]): CashOrderAuthoritySnapshotV1 {
    return {
        parks: [
            { id: 'park-yoko', externalParkId: YOKO },
            { id: 'park-other', externalParkId: OTHER },
        ],
        links,
    }
}

const otherLink = link({
    linkId: 'link-other',
    localParkId: 'park-other',
    linkExternalParkId: OTHER,
    parkExternalParkId: OTHER,
    apiConnectionId: 'conn-other',
    apiConnectionParkId: OTHER,
})

describe('park authority', () => {
    it('processes a park with exactly one consistent active link', () => {
        expect(classifyCashOrderParkAuthorityV1(YOKO, snapshot([link(), otherLink]))).toEqual({
            status: 'authoritative',
            externalParkId: YOKO,
            localParkId: 'park-yoko',
            linkId: 'link-yoko',
            connectionId: 'conn-yoko',
        })
    })

    it('fails an enabled id with no active Park row', () => {
        expect(classifyCashOrderParkAuthorityV1('ext-unknown', snapshot([link()])))
            .toEqual({ status: 'failed', externalParkId: 'ext-unknown', code: 'park_not_active' })
    })

    it('fails a park with no active link rather than falling back to any connection', () => {
        expect(classifyCashOrderParkAuthorityV1(YOKO, snapshot([otherLink])))
            .toMatchObject({ status: 'failed', code: 'park_connection_missing' })
    })

    it('refuses to choose between two active links on the same park', () => {
        const duplicate = link({ linkId: 'link-yoko-2', apiConnectionId: 'conn-yoko-2' })
        expect(classifyCashOrderParkAuthorityV1(YOKO, snapshot([link(), duplicate, otherLink])))
            .toMatchObject({ status: 'failed', code: 'ambiguous_active_connection' })
        // Order of the rows never turns the refusal into a first-wins choice.
        expect(classifyCashOrderParkAuthorityV1(YOKO, snapshot([duplicate, otherLink, link()])))
            .toMatchObject({ status: 'failed', code: 'ambiguous_active_connection' })
    })

    it('refuses when another park carries this park id in its link', () => {
        const reused = link({ linkId: 'link-other-reuse', localParkId: 'park-other', parkExternalParkId: OTHER })
        expect(classifyCashOrderParkAuthorityV1(YOKO, snapshot([link(), reused])))
            .toMatchObject({ status: 'failed', code: 'ambiguous_active_connection' })
    })

    it('refuses when the single link external id is also carried elsewhere', () => {
        const drifted = link({ linkExternalParkId: 'ext-shared' })
        const sharer = link({ linkId: 'link-shared', localParkId: 'park-other', linkExternalParkId: 'ext-shared', parkExternalParkId: OTHER })
        expect(classifyCashOrderParkAuthorityV1(YOKO, snapshot([drifted, sharer])))
            .toMatchObject({ status: 'failed', code: 'ambiguous_active_connection' })
    })

    it('fails a single link whose ids disagree', () => {
        expect(classifyCashOrderParkAuthorityV1(YOKO, snapshot([link({ apiConnectionParkId: 'ext-stale' })])))
            .toMatchObject({ status: 'failed', code: 'connection_park_mismatch' })
        expect(classifyCashOrderParkAuthorityV1(YOKO, snapshot([link({ linkExternalParkId: 'ext-typo' })])))
            .toMatchObject({ status: 'failed', code: 'connection_park_mismatch' })
    })

    it('fails a link on another park that alone carries this park id', () => {
        const foreign = link({ localParkId: 'park-other', parkExternalParkId: OTHER })
        expect(classifyCashOrderParkAuthorityV1(YOKO, snapshot([foreign])))
            .toMatchObject({ status: 'failed', code: 'connection_park_mismatch' })
    })

    it('resumes after rotation once exactly one link remains, on the new connection', () => {
        const rotated = link({ linkId: 'link-yoko-new', apiConnectionId: 'conn-yoko-new' })
        expect(classifyCashOrderParkAuthorityV1(YOKO, snapshot([link(), rotated]))).toMatchObject({ status: 'failed' })
        expect(classifyCashOrderParkAuthorityV1(YOKO, snapshot([rotated])))
            .toMatchObject({ status: 'authoritative', connectionId: 'conn-yoko-new' })
    })

    it('keeps a failing park from affecting another park', () => {
        const duplicate = link({ linkId: 'link-yoko-2', apiConnectionId: 'conn-yoko-2' })
        const current = snapshot([link(), duplicate, otherLink])
        expect(classifyCashOrderParkAuthorityV1(OTHER, current))
            .toMatchObject({ status: 'authoritative', connectionId: 'conn-other' })
    })
})

describe('credential cross-check', () => {
    const authority = {
        status: 'authoritative' as const,
        externalParkId: YOKO,
        localParkId: 'park-yoko',
        linkId: 'link-yoko',
        connectionId: 'conn-yoko',
    }
    const entry = (overrides: Record<string, unknown> = {}) => ({
        connectionId: 'conn-yoko', localParkId: 'park-yoko', parkId: YOKO, ...overrides,
    })

    it('binds exactly one matching entry', () => {
        const entries = [entry(), entry({ connectionId: 'conn-other', localParkId: 'park-other', parkId: OTHER })]
        expect(crossCheckCashOrderCredentialsV1(authority, entries)).toEqual({ ok: true, entry: entries[0] })
    })

    it('fails the legacy fallback, whose entries carry no local park', () => {
        expect(crossCheckCashOrderCredentialsV1(authority, [entry({ localParkId: null })]))
            .toEqual({ ok: false, code: 'authority_credential_mismatch' })
    })

    it('fails a duplicate link that appeared after the metadata read', () => {
        expect(crossCheckCashOrderCredentialsV1(authority, [entry(), entry({ connectionId: 'conn-yoko-2' })]))
            .toEqual({ ok: false, code: 'authority_credential_mismatch' })
    })

    it('fails when the external and local matches are different entries', () => {
        const entries = [entry({ localParkId: 'park-other' }), entry({ parkId: 'ext-else' })]
        expect(crossCheckCashOrderCredentialsV1(authority, entries))
            .toEqual({ ok: false, code: 'authority_credential_mismatch' })
    })

    it('fails when the credential entry is not the authoritative connection', () => {
        expect(crossCheckCashOrderCredentialsV1(authority, [entry({ connectionId: 'conn-rotated' })]))
            .toEqual({ ok: false, code: 'authority_credential_mismatch' })
    })

    it('fails when no entry exists', () => {
        expect(crossCheckCashOrderCredentialsV1(authority, [])).toEqual({ ok: false, code: 'authority_credential_mismatch' })
    })
})
