import {
    linkContactToBestDriver,
    type LinkResult,
} from '@/lib/contacts/yandex-link'

export type YandexDriverContactLinkResultV1 = LinkResult

export const yandexDriverContactLinkV1 = Object.freeze({
    linkContactToBestDriver: (phone: string | null | undefined): Promise<YandexDriverContactLinkResultV1> => (
        linkContactToBestDriver(phone)
    ),
})
