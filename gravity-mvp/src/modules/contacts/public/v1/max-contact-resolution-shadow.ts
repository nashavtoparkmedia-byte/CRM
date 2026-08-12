import { startMaxContactResolutionShadow } from '@/lib/contacts/max-contact-resolution-shadow'
import type {
    LegacyContactResolutionOutcome,
    MaxContactResolutionShadowInput,
    MaxContactResolutionShadowStart,
} from '@/lib/contacts/contact-resolution-shadow.types'

export type { LegacyContactResolutionOutcome }

export const maxContactResolutionShadowV1 = Object.freeze({
    start: (input: MaxContactResolutionShadowInput): Promise<MaxContactResolutionShadowStart> => (
        startMaxContactResolutionShadow(input)
    ),
})
