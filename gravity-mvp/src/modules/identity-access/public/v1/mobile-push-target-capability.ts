/**
 * Mobile Push v1 — the ONE public identity_access capability that hands a
 * device's provider token to another context.
 *
 * It is a reviewed runtime provider capability: its only consumer is
 * Messaging's push runtime, which uses the token as the address of exactly one
 * FCM request and never stores, logs or returns it. The operation itself lives
 * in the application layer; this facade only publishes it, and it is
 * deliberately not re-exported from the public barrel.
 */
export { resolveMobilePushTargetV1 } from '../../application/mobile-push-target-operations'
