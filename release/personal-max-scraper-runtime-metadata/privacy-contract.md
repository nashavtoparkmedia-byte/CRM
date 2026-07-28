# Privacy contract

The future probe is a bounded runtime-metadata inspection, not a browser-profile inspection. It may retain a root-only `0600` Docker inspection document only inside its private temporary directory and must delete that directory on exit. The sanitized report contains environment variable names only. Environment values, cookies, local storage, IndexedDB, browser history, contact identifiers, message bodies, screenshots, provider payloads, and credentials are forbidden in stdout, stderr, diagnostics, and the report.

The only permitted profile path is the already-known mount point `/app/user_data`. The probe may call `stat`, perform non-writing access tests, and count locks without listing child names. It must never use `cat` on profile content, recursively enumerate the profile, start a browser, contact MAX, or mount the profile in another container. Container IDs are reported only as SHA-256 hashes.

No shell tracing is permitted. Every Docker operation is read-only (`ps`, `inspect`, `top`, and tightly bounded `exec` for `id`, `ps` metadata, `stat`, access booleans, descriptor counts, and lock counts). The script must fail closed before publishing if its sanitized-output scan detects credential-like keys with values.
