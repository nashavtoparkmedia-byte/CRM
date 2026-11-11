import 'server-only'

// The public entry to manual calls for HTTP routes and other contexts. Each operation applies
// Calling's verified-destination policy (manual-call.ts); nothing here takes a phone number.
export {
  cancelManualCall as cancelManualCallV1,
  readManualCallAvailability as readManualCallAvailabilityV1,
  startManualCall as startManualCallV1,
} from '../../application/manual-call-runtime'
