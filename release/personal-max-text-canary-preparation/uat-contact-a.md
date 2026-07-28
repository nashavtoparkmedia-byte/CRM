# Contact A UAT checklist

This is a future checklist only. Use one architect-approved account hash and one exact conversation hash; never select by display name or phone.

- [ ] Send three distinct text intents and prove FIFO, exact route, one attempt each, and exact provider confirmation.
- [ ] Send three identical text intents and prove three distinct command/attempt identities with no payload-hash deduplication.
- [ ] Send a bounded burst and prove stable FIFO with no second browser/sender owner.
- [ ] Reconnect the gateway-side client and prove durable idempotency and unchanged fence.
- [ ] Perform the separately approved restart case and prove one owner, one listener, and no repeated action.
- [ ] Delay provider confirmation and preserve `UNKNOWN_AFTER_ATTEMPT`/reconciliation semantics without blind retry.
- [ ] Inject one unknown outcome and prove the canary stops before another physical action.
- [ ] Re-read the exact account/conversation/route snapshot immediately before every attempt.
- [ ] Confirm wrong-chat actions = 0, wrong-account actions = 0, stale-fence sends = 0.
