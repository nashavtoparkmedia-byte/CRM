export type ConfirmationReceiptType =
  | 'provider_acceptance'
  | 'recipient_delivery'
  | 'recipient_read'
  | 'unknown_receipt'

export interface ReceiptSemantics {
  readonly evidenceKind: 'provider_acceptance_receipt' | 'recipient_delivery_receipt' | 'recipient_read_receipt' | 'unknown_receipt'
  readonly impliesProviderAcceptance: boolean
  readonly changesDispatchState: boolean
  readonly recipientStateProjected: false
}

export const RECEIPT_SEMANTICS: Readonly<Record<ConfirmationReceiptType, ReceiptSemantics>> = Object.freeze({
  provider_acceptance: Object.freeze({
    evidenceKind: 'provider_acceptance_receipt',
    impliesProviderAcceptance: true,
    changesDispatchState: true,
    recipientStateProjected: false,
  }),
  recipient_delivery: Object.freeze({
    evidenceKind: 'recipient_delivery_receipt',
    impliesProviderAcceptance: false,
    changesDispatchState: false,
    recipientStateProjected: false,
  }),
  recipient_read: Object.freeze({
    evidenceKind: 'recipient_read_receipt',
    impliesProviderAcceptance: false,
    changesDispatchState: false,
    recipientStateProjected: false,
  }),
  unknown_receipt: Object.freeze({
    evidenceKind: 'unknown_receipt',
    impliesProviderAcceptance: false,
    changesDispatchState: false,
    recipientStateProjected: false,
  }),
})
