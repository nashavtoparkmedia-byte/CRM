# Future root metadata contract

One later read-only, checksum-bound root probe may close the gate by collecting sanitized metadata only: exact container ID/image/config user/runtime UID/GID; workdir; entrypoint and command arrays; environment variable names without values; mounts; networks; ports; labels; restart/health/logging; runtime dependencies; bounded process counts; one-browser/listener ownership; and numeric UID/GID/mode summaries for `/app/user_data` plus immediate lock/database files without names or content. It must not print environment values, browser data, profile paths beyond the known mount, message/contact/provider data, or credentials, and must not modify or stop anything.

Only after that report can an exact recreation method and a rollback to the current immutable image/config be prepared. Any UID ownership remediation needs separate architect approval.
