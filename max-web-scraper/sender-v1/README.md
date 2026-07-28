# Personal MAX text sender v1

This directory is a contract and synthetic adapter only. `max-web-scraper/index.js` does not import it, no HTTP route is registered, and no browser or provider client is available here. Production wiring remains forbidden until the architecture gate separately accepts the SessionOwner migration, scraper metadata, durable replay/idempotency stores, exact route verifier, command-attempt verifier, and canary configuration.

The in-memory replay and idempotency stores exist only for deterministic offline tests. A future runtime adapter must inject crash-durable stores with the same fail-closed interfaces; constructing fresh in-memory stores on restart is not acceptable. Authentication uses the dedicated `personal-max-sender-v1` namespace and does not reuse capture credentials. Authentication never substitutes for the account/owner/fencing check performed immediately before the injected synthetic boundary.

All physical gates are disabled by default. The contract permits text only, forbids reply/reaction/media and fallback routing, and never reports recipient delivery. The synthetic adapter records identities in a test ledger and permanently reports zero physical provider calls.
