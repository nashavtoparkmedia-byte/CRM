# Profile ownership contract

The profile is inspected only through the existing scraper container at `/app/user_data`; no second mount or container is allowed. The mount must be exactly one read-write production mount and the path must exist as a real directory, not a symbolic link. The report records numeric UID/GID, octal mode, device and inode, current-runtime writability, accepted UID `1001` compatibility, group compatibility, and ACL availability/presence as booleans or `UNKNOWN`.

No child filename or content may be printed. A profile owned by the current runtime UID but not safely writable by UID 1001 yields `UID_TRANSITION_REQUIRES_CONTROLLED_OWNERSHIP_CHANGE`; the probe never performs that change. Missing, multiply mounted, read-only, symlinked, or provably incompatible profiles fail closed. Incomplete ACL or group-membership evidence yields `UID_TRANSITION_UNKNOWN`.
