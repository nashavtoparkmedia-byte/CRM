# Health and readiness gates

`/health` reports bounded operational state; `/ready` returns success only for dormant-safe or fully safe active state. `/metrics` contains counters/gauges without message, caption, raw payload, credential or full provider-ID labels.

Active readiness requires valid config, reachable DB, migration 53 present, configured HMAC, authenticated producer health, noncritical spool, zero lost-before-spool, zero envelope collisions, healthy journal ingestion, recent ACK, bounded normalizer/comparison lag, zero critical regression, zero wrong-account difference, one expected browser owner, inactive sender/provider modules and healthy worker queue.

Stage 8B2 additionally needs an external runtime observation proving exactly one browser owner because Docker metadata is not imported into the gateway. Any failed gate stops the canary; HTTP process liveness alone is insufficient.
