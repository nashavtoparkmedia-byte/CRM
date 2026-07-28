# Canary safety contract

Current state is `PREPARED_NOT_EXECUTED`: physical sender disabled, global emergency stop active by default, exact account/conversation allowlists empty, future images not built, new migrations not executed, scraper sender runtime unwired, metadata uncollected, and no production secret generated.

Future physical action requires all gates simultaneously: exact account and conversation allowlists; active DB-time SessionOwner; immediate owner/token verification; exact account-matching route; text-only payload; nonterminal command/attempt correlation; HMAC namespace/replay validation; durable idempotency; kill switches clear; and account/conversation/daily limits below bounds. HMAC never replaces fencing.

Media, reply, reaction, phone/display-name fallback, wildcard enablement, blind retry, two profile owners, and recipient-delivery claims are forbidden. Allowed outcomes remain `REFUSED_BEFORE_SEND`, `ACCEPTED_BY_SENDER_BOUNDARY`, `PROVIDER_CONFIRMED`, `UNKNOWN_AFTER_ATTEMPT`, `FAILED_BEFORE_PROVIDER`, and `UNSUPPORTED`.

The current in-memory replay/idempotency implementations are synthetic test doubles. A production adapter requires separately reviewed crash-durable stores. Until then, no sender route may be registered and no physical feature flag may be enabled.
