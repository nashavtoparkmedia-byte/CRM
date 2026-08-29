import { startMaxContactResolutionShadow as startShadow } from '@/lib/contacts/max-contact-resolution-shadow'
import type {
  LegacyContactResolutionOutcome,
  MaxContactResolutionShadowInput,
  MaxContactResolutionShadowStart,
} from '@/lib/contacts/contact-resolution-shadow.types'
import { linkContactToBestDriver as linkDriver, type LinkResult } from '@/lib/contacts/yandex-link'

export type { LegacyContactResolutionOutcome, MaxContactResolutionShadowInput, MaxContactResolutionShadowStart, LinkResult }
export const startMaxContactResolutionShadow = (input: MaxContactResolutionShadowInput): Promise<MaxContactResolutionShadowStart> => startShadow(input)
export const linkContactToBestDriver = (phone: string | null | undefined): Promise<LinkResult> => linkDriver(phone)
