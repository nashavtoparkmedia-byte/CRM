# Contact A+B UAT checklist

This is a future checklist only. Contact aliases in evidence are salted hashes; the test authority holds the exact account/conversation allowlist outside reports.

- [ ] Interleave Contact A and Contact B commands and prove each conversation's independent FIFO.
- [ ] Use identical text across A and B and prove distinct command, route, attempt, and idempotency identities.
- [ ] Prove account A SessionOwner token has zero authority for account B.
- [ ] Prove conversation A route has zero authority for conversation B.
- [ ] Expire/take over one synthetic fence and prove every delayed stale request is refused.
- [ ] Preserve one physical sender winner for the account under split-brain simulation.
- [ ] Confirm wrong-account actions = 0, wrong-conversation actions = 0, stale-fence sends = 0.
- [ ] Stop immediately on unknown outcome, route conflict, ownership ambiguity, or isolation regression.
