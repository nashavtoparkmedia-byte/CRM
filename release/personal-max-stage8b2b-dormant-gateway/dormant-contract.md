# Dormant behavior contract

All four account allowlists are explicit empty strings. No database URL or HMAC value is configured. Source and executable-image evidence prove that dormant startup constructs no Prisma client, ingress, or worker pipeline. `/health` must report mode `dormant` and zero enabled accounts; `/ready` must report `dormant-ready`; a capture request must return `503 INGRESS_DORMANT`. The internal-only network has no route to MAX or any provider, and no browser/profile is mounted.
