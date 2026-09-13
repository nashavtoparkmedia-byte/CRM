import { describe, expect, it } from 'vitest'

import {
    resolveManagerPrincipalV1,
    type AuthenticatedCrmUserV1,
} from './compensation-manager-principal'

function user(overrides: Partial<AuthenticatedCrmUserV1> = {}): AuthenticatedCrmUserV1 {
    return {
        id: 'u1',
        firstName: 'Анна',
        lastName: 'Петрова',
        role: 'Менеджер',
        status: 'Активен',
        ...overrides,
    }
}

describe('resolving the acting manager', () => {
    it('derives a namespaced principal from the signed-in user', () => {
        expect(resolveManagerPrincipalV1(user())).toEqual({
            resolved: true,
            principal: { principalId: 'crm_user:u1', operatorLabel: 'Анна Петрова' },
        })
    })

    it('gives two different managers two different principals', () => {
        const first = resolveManagerPrincipalV1(user({ id: 'u1', firstName: 'Анна', lastName: 'Петрова' }))
        const second = resolveManagerPrincipalV1(user({ id: 'u2', firstName: 'Иван', lastName: 'Смирнов' }))
        expect(first.resolved && second.resolved).toBe(true)
        if (!first.resolved || !second.resolved) return
        expect(first.principal.principalId).not.toBe(second.principal.principalId)
        expect(first.principal.operatorLabel).not.toBe(second.principal.operatorLabel)
    })

    it('keeps the acting id even when the name is missing', () => {
        const resolution = resolveManagerPrincipalV1(user({ firstName: '  ', lastName: '' }))
        expect(resolution).toEqual({
            resolved: true,
            principal: { principalId: 'crm_user:u1', operatorLabel: 'crm_user:u1' },
        })
    })

    it('namespaces the principal so it cannot collide with another subsystem', () => {
        const resolution = resolveManagerPrincipalV1(user({ id: 'manager' }))
        expect(resolution.resolved && resolution.principal.principalId).toBe('crm_user:manager')
    })
})

describe('failing closed', () => {
    it('refuses an anonymous session', () => {
        expect(resolveManagerPrincipalV1(null)).toEqual({ resolved: false, refusal: 'not_authenticated' })
        expect(resolveManagerPrincipalV1(undefined)).toEqual({ resolved: false, refusal: 'not_authenticated' })
    })

    it('refuses a disabled account', () => {
        expect(resolveManagerPrincipalV1(user({ status: 'Отключен' })))
            .toEqual({ resolved: false, refusal: 'user_disabled' })
    })

    it('refuses an identity with no id', () => {
        expect(resolveManagerPrincipalV1(user({ id: '   ' })))
            .toEqual({ resolved: false, refusal: 'user_identity_incomplete' })
    })

    it('never produces a shared fallback principal', () => {
        const refused = [
            resolveManagerPrincipalV1(null),
            resolveManagerPrincipalV1(user({ status: 'Отключен' })),
            resolveManagerPrincipalV1(user({ id: '' })),
        ]
        for (const resolution of refused) {
            expect(resolution.resolved).toBe(false)
            expect(JSON.stringify(resolution)).not.toMatch(/manager|admin|system/i)
        }
    })
})
