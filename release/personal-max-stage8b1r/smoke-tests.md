# Smoke tests

The GitHub-hosted executable proof performs these tests without production secrets, public ports, Chromium launch or MAX access:

1. Build both Dockerfiles from the exact checked-out commit and pinned base digests.
2. Assert gateway runtime UID/GID 1000:1000 and scraper runtime UID/GID 1001:1001.
3. Run dormant gateway on `--network none`; require health/readiness 200.
4. Run malformed active configuration on `--network none`; require bounded fail-closed exit.
5. Create an internal-only network and disposable pinned PostgreSQL 16 volume.
6. Apply the complete migration chain from the exact gateway image.
7. Start active gateway; require health 200 and readiness 503 before capture.
8. Run default-off scraper harness and prove no spool path side effect.
9. Enable the actual TransportInterceptor hook, durable spool and authenticated ingress; require one ACK and readiness 200.
10. Stop gateway, persist another physical frame, recreate gateway, drain the retained frame and require readiness 200.
11. Generate SBOMs, run Grype/Trivy policy gates and secret scan.
12. Publish unique immutable tags, pull both by digest and require exact image-ID equality.

The later root isolated probe repeats the core flow in a separately approved VPS Docker namespace and also checks production container IDs before/after. Neither proof launches the scraper's normal entrypoint.
