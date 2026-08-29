import { describe, expect, it, vi } from 'vitest'

const linkContactToBestDriver = vi.hoisted(() => vi.fn())

vi.mock('@/lib/contacts/yandex-link', () => ({ linkContactToBestDriver }))

import { yandexDriverContactLinkV1 } from './yandex-driver-contact-link'

describe('Contacts Yandex driver link capability', () => {
    it('delegates only the confirmed-phone link operation', async () => {
        linkContactToBestDriver.mockResolvedValueOnce({
            action: 'linked',
            contactId: 'contact-1',
            driverId: 'yandex-driver-1',
        })

        await expect(yandexDriverContactLinkV1.linkContactToBestDriver('+79990000000')).resolves.toEqual({
            action: 'linked',
            contactId: 'contact-1',
            driverId: 'yandex-driver-1',
        })
        expect(linkContactToBestDriver).toHaveBeenCalledWith('+79990000000')
    })
})
