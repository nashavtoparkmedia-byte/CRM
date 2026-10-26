import { describe, expect, it } from 'vitest'
import {
    SEND_TO_CONTACT_COMMAND_V1,
    SendToContactValidationError,
    type SendToContactDeliveryStateV1,
} from '../../../contracts/messaging/v1/send-to-contact-command'
import type { DeliveryStateV1 } from '../public/v1/delivery-state-policy'
import {
    prepareSendToContactRequestV1,
    sendToContactClientMessageIdV1,
    sendToContactSemanticPayloadSha256V1,
} from './send-to-contact-request'

const base = {
    contract: SEND_TO_CONTACT_COMMAND_V1,
    requestId: 'run-1:step-1',
    contactId: 'contact-1',
    content: 'Здравствуйте! 👋',
}

const sha = (input: Record<string, unknown>) => prepareSendToContactRequestV1(input).semanticPayloadSha256

// Pinned against an independent implementation (Python hashlib over
// json.dumps(..., ensure_ascii=False, separators=(',', ':'))).
const ABSENT = 'b21d05f9fa155c12f518f8577fba109c02e62c7b82da727ca2991c0e2826c4a3'
const TELEGRAM_WHATSAPP = 'a58866ee4260dfffcaa5377878ff9a11706caf7bd11678ed9122cf0a66a74a21'
const ALL_THREE = '447d7c4a4e630275eb380d4189dd5224a148549cd20b095c26ba9b34df027426'

describe('the semantic payload fingerprint', () => {
    it('matches the pinned vectors', () => {
        expect(sha(base)).toBe(ABSENT)
        expect(sha({ ...base, allowedChannels: ['telegram', 'whatsapp'] })).toBe(TELEGRAM_WHATSAPP)
        expect(sha({ ...base, allowedChannels: ['max', 'telegram', 'whatsapp'] })).toBe(ALL_THREE)
    })

    it('is lowercase hex sha256', () => {
        expect(sha(base)).toMatch(/^[0-9a-f]{64}$/)
    })

    it('ignores the order of allowedChannels', () => {
        expect(sha({ ...base, allowedChannels: ['whatsapp', 'telegram'] })).toBe(TELEGRAM_WHATSAPP)
        expect(sha({ ...base, allowedChannels: ['whatsapp', 'max', 'telegram'] })).toBe(ALL_THREE)
    })

    it('never equates an absent narrowing with the full set', () => {
        expect(ALL_THREE).not.toBe(ABSENT)
    })

    it('excludes the requestId', () => {
        expect(sha({ ...base, requestId: 'another-request' })).toBe(ABSENT)
    })

    it('binds the contactId and the content exactly', () => {
        for (const changed of [
            { contactId: 'Contact-1' },
            { contactId: 'contact-2' },
            { content: 'Здравствуйте! 👋 ' },
            { content: ' Здравствуйте! 👋' },
            { content: 'Здравствуйте!👋' },
        ]) expect(sha({ ...base, ...changed })).not.toBe(ABSENT)
        // Canonically equivalent but different code points are different payloads.
        expect(sha({ ...base, content: 'é' })).not.toBe(sha({ ...base, content: 'é' }))
    })

    it('lets no field forge a boundary into its neighbour', () => {
        const left = sha({ ...base, contactId: 'a', content: 'b","c' })
        const right = sha({ ...base, contactId: 'a","b', content: 'c' })
        expect(left).toBe('aba2a3598021df9accdc096a0f148ae7d1ba42127b7acb2309a0f16170ee2608')
        expect(right).toBe('9acdee60a851f25c839f6358a7b14cbd22b3e81a9754a12e4c45dd150c5aa599')
    })

    it('hashes a parsed command without changing its channel order', () => {
        const prepared = prepareSendToContactRequestV1({ ...base, allowedChannels: ['whatsapp', 'telegram'] })
        expect(prepared.command.allowedChannels).toEqual(['whatsapp', 'telegram'])
        expect(sendToContactSemanticPayloadSha256V1(prepared.command)).toBe(TELEGRAM_WHATSAPP)
    })
})

describe('prepareSendToContactRequestV1', () => {
    it('validates, fingerprints and names the one Message of the intent', () => {
        expect(prepareSendToContactRequestV1(base)).toEqual({
            command: base,
            semanticPayloadSha256: ABSENT,
            clientMessageId: 'stc:run-1:step-1',
        })
        expect(sendToContactClientMessageIdV1('r')).toBe('stc:r')
    })

    it('throws before fingerprinting, so a malformed or unsupported command cannot claim its requestId', () => {
        for (const input of [
            { ...base, contract: 'messaging.SendToContactCommand.v2' },
            { ...base, allowedChannels: ['telegram', 'telegram'] },
            { ...base, content: '   ' },
            { ...base, requestId: '' },
            { ...base, extra: true },
        ]) expect(() => prepareSendToContactRequestV1(input)).toThrow(SendToContactValidationError)
    })
})

describe('SendToContactDeliveryStateV1', () => {
    it('re-declares exactly Messaging\'s seven delivery states', () => {
        type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false
        const same: Same<SendToContactDeliveryStateV1, DeliveryStateV1> = true
        expect(same).toBe(true)
    })
})
