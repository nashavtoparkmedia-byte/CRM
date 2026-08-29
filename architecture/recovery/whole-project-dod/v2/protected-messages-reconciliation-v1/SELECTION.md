# Protected Messages reconciliation v1

Authority is the current per-file production composite under `/opt/crm`, not a
historical branch and not production Git HEAD by itself. The registry freezes
the 26 selected production surfaces by SHA-256 and maps each to the accepted
candidate target. Production-only transport files are deliberately mapped to
their Telegram owner-controlled successor paths.

Every delta uses the closed classification vocabulary required by the recovery
checkpoint. `UNKNOWN` is enforcement-failing. Required behavior is accepted
only when the target hash and the behavior-specific source probes match;
obsolete and security-risk paths carry negative source probes where applicable.

This bounded gate does not invoke the authoritative whole-repository write scan.
