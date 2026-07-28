# Privacy and query bounds

SQL accepts zero accounts only for `dormant`, one exact account for `one-account`, and one/two exact accounts for the other targets. Raw IDs exist only in the root-owned `0700` temporary directory and are interpolated after a strict character/length check. Reports contain only full SHA-256 account aliases and never contain the alias mapping.

Queries select no message text, payload, sanitized payload, caption, phone, display name, contact data, provider payload, credential, HMAC, or raw account ID. The transaction is read-only with a 5-second statement timeout, 1-second lock timeout, and 10-second idle timeout. Journal reads use bounded `(accountId, observedAt)` index ranges; related reads use account/source indexes. No full-table journal scan is used.

Runtime inspection uses narrow Docker templates and never reads `.Config.Env`, Compose interpolation, profile contents, logs, or provider data. Image references, image IDs, repository digests, source revisions, container start time, health, restart counts, sanitized network/port/mount/user/restart/security settings, Compose identity labels, and a sanitized profile mount destination/count/RW flag are non-secret operational evidence.

The complete embedded Stage 8B2A/8B2B reports are already sanitized evidence: they contain hashes, bounded counts, backup metadata, runtime topology, and safety booleans, but no database URL, environment values, message/profile content, raw account ID, HMAC, or provider credential.

`rawJournalRows` means durable rows in `MaxRawTransportEvent`. It is never renamed or copied into a physical-frame field. Physical-frame count remains explicit unknown until a privacy-safe, window-aligned source is separately authorized.
