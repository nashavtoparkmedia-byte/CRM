import {
  startMaxContactResolutionShadow,
  linkContactToBestDriver,
  type LegacyContactResolutionOutcome,
  type MaxContactResolutionShadowInput,
  type MaxContactResolutionShadowStart,
  type LinkResult,
} from '../internal/external-contact-operations'

export type { LegacyContactResolutionOutcome }
export type YandexDriverContactLinkResultV1 = LinkResult
export const startMaxContactResolutionShadowV1 = (input: MaxContactResolutionShadowInput): Promise<MaxContactResolutionShadowStart> => startMaxContactResolutionShadow(input)
export const linkContactToBestDriverV1 = (phone: string | null | undefined): Promise<YandexDriverContactLinkResultV1> => linkContactToBestDriver(phone)
