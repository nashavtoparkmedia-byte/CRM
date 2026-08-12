# Scheduled Fleet cron boundary selection

This slice closes the final four live architecture findings without an exception. Operations and Observability owns cron-route orchestration, HTTP result mapping, and health telemetry. Fleet Operations owns the fixed Yandex sync and scraper-dispatch operations, including credential lookup and provider transport.

The public boundary is deliberately narrow:

- `runScheduledScraperDispatchCronV1` and `runScheduledYandexSyncCronV1` are the only new Operations capabilities.
- `dispatchScheduledScraperChecksV1` accepts no caller-controlled operation, credential, URL, query, or model selector and returns aggregate outcomes only.
- the route retains its existing `CRON_SECRET` bearer check before invoking the Operations capability.
- the enforcement probe rejects an unrelated additional cron capability and proves zero live findings, zero dependency cycles, and zero direct provider-transport findings.

This closes the live-architecture opening denominator of 1,288 findings. It does not declare whole-project readiness; authoritative CI, protected Messages reconciliation, release identity, and production gates remain separate Definition-of-Done work.
