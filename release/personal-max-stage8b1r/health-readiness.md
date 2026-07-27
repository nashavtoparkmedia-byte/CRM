# Health and readiness gates

Dormant mode requires `/health` and `/ready` HTTP 200 with all feature sets empty and no spool/ingress side effect. Invalid active configuration must terminate rather than listen.

Active readiness requires: valid exact account flags, explicit gateway database URL, reachable database, migration `20260727154647_add_max_capture_ingress`, configured HMAC, recent authenticated durable journal ACK, observed noncritical producer/spool state, zero lost-before-spool, zero envelope collisions, healthy journal ingestion, bounded normalizer/comparison lag, zero critical/wrong-account regression, one expected browser owner, inactive sender/provider modules and a healthy worker queue.

The executable proof requires 503 before the first ACK and during database outage, then 200 after spool recovery. A process answering `/health` alone is not release readiness.
