import {
  startMaxContactResolutionShadow,
  type LegacyContactResolutionOutcome,
  type MaxContactResolutionShadowInput,
  type MaxContactResolutionShadowStart,
} from '../internal/external-contact-operations'
import { yandexDriverContactLinkPortV1 } from '../internal/yandex-driver-contact-link-port'
import {
  createYandexDriverContactLinkHandlerV1,
  type YandexDriverContactLinkResultV1,
} from '../public/v1/yandex-driver-contact-link'

export type { LegacyContactResolutionOutcome }
export type { YandexDriverContactLinkResultV1 }
export const startMaxContactResolutionShadowV1 = (input: MaxContactResolutionShadowInput): Promise<MaxContactResolutionShadowStart> => startMaxContactResolutionShadow(input)
const linkContactToBestDriver = createYandexDriverContactLinkHandlerV1(yandexDriverContactLinkPortV1)
export const linkContactToBestDriverV1 = (phone: string | null | undefined): Promise<YandexDriverContactLinkResultV1> => linkContactToBestDriver(phone)
