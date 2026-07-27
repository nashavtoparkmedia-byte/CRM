# Remaining blockers

Before the executable workflow completes successfully:

- exact final-image runtime Critical/fixable High/secret counts are not yet proven;
- final SPDX/CycloneDX checksums do not yet exist;
- immutable GHCR digests and pull-by-digest proof do not yet exist;
- exact final executable image UID/GID is only statically proven from base layers and Dockerfiles.

Before Stage 8B2, even after successful CI:

- the read-only production metadata probe requires explicit root execution;
- the isolated VPS image probe requires separate explicit root approval;
- actual production migration/table size/lock facts and verified backup are required;
- actual running browser/profile/listener ownership must be reviewed;
- any remaining unfixed High requires architect and owner security acceptance.

Codex does not accept these risks and this document contains no deploy authorization.
