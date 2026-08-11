'use client'

// Compatibility path for legacy callers. Calling owns the browser SIP runtime.
export {
  SipProvider,
  useSip,
} from '@/modules/calling/public/v1/sip-client-context'
export type {
  ActiveCallInfo,
  CallState,
  IncomingCallAlertInfo,
  IncomingCallInfo,
  SipStatus,
} from '@/modules/calling/public/v1/sip-client-context'
