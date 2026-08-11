// Compatibility path for legacy callers. Contacts owns canonical display policy.
export {
  SEGMENT_LABELS,
  buildCanonicalContactSummary,
  formatContactPhone,
  getSegmentLabel,
} from '@/modules/contacts/public/v1/contact-display-policy'
export type { CanonicalContactSummary } from '@/modules/contacts/public/v1/contact-display-policy'
