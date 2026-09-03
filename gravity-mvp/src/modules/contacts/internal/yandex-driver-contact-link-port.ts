import {
  linkContactToBestDriver,
} from '@/lib/contacts/yandex-link'

import type {
  YandexDriverContactLinkPortV1,
} from '../public/v1/yandex-driver-contact-link'

/** Owner-local binding; no persistence/provider implementation crosses public v1. */
export const yandexDriverContactLinkPortV1: YandexDriverContactLinkPortV1 = {
  link: linkContactToBestDriver,
}
