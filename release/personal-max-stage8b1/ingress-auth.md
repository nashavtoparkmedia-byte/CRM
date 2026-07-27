# Internal ingress and authentication contract

Transport is HTTP on `crm_internal` from `max-web-scraper` to `max-personal-gateway:8080`. Compose declares only `expose`; there is no host `ports` mapping and no nginx route. The producer accepts only the exact private service hostname or loopback test endpoints and does not follow redirects.

`POST /v1/capture` requires `max-capture-hmac-v1`: key ID, 13-digit millisecond timestamp and SHA-256 HMAC over version, method, exact path, timestamp and body hash. Missing, unknown, expired and invalid credentials are denied. Comparison uses constant-time verification. Replay is bounded by clock skew and journal idempotency on `(accountId, captureEnvelopeId)`.

Request size, header time and body time are bounded. Credentials, bodies, provider identifiers and message text are excluded from structured logs and metric labels. The gateway supports at most four simultaneous rotation keys and the producer uses one active key.
