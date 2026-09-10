import { describe, expect, it, vi } from 'vitest'

import { createYandexDriverContactLinkHandlerV1 } from './yandex-driver-contact-link'

describe('Contacts Yandex driver link capability', () => {
    it('delegates only the confirmed-phone link operation', async () => {
        const link = vi.fn().mockResolvedValueOnce({
            action: 'linked',
            contactId: 'contact-1',
            driverId: 'yandex-driver-1',
        })
        const handler = createYandexDriverContactLinkHandlerV1({ link })

        await expect(handler('+79990000000')).resolves.toEqual({
            action: 'linked',
            contactId: 'contact-1',
            driverId: 'yandex-driver-1',
        })
        expect(link).toHaveBeenCalledWith('+79990000000')
    })
})
