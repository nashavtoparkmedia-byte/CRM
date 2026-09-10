import { startMaxContactResolutionShadow as startShadow } from '@/lib/contacts/max-contact-resolution-shadow'
import type {
  LegacyContactResolutionOutcome,
  MaxContactResolutionShadowInput,
  MaxContactResolutionShadowStart,
} from '@/lib/contacts/contact-resolution-shadow.types'

export type { LegacyContactResolutionOutcome, MaxContactResolutionShadowInput, MaxContactResolutionShadowStart }
export const startMaxContactResolutionShadow = (input: MaxContactResolutionShadowInput): Promise<MaxContactResolutionShadowStart> => startShadow(input)
