# Browser ownership contract

`docker top` is the primary process source. A Chromium browser root process is a Chromium-family command without a `--type=` child marker; renderers are counted only by `--type=renderer`. The future probe records counts and the distinct numeric UID/GID evidence available from the scraper container. It does not print process command lines in the report.

Exactly one browser root process is required for a safe recreation decision. Zero is classified `BROWSER_OWNER_NOT_RUNNING`; more than one is `SECOND_BROWSER_DETECTED`. A process count is never interpreted as proof that an in-process listener is unique. No browser is launched and the existing profile is never attached elsewhere.
