# Accepted image security evidence

The immutable gateway ref is the accepted Stage 8B1R publication. Its release gate required linux/amd64, runtime UID/GID `1000:1000`, zero runtime Critical, zero fixable runtime High, zero image secrets, non-empty SBOMs, executable dormant proof, and pull-by-digest equality. This package does not rebuild, pull, retag, or substitute the digest. Runtime additionally drops all capabilities, enables no-new-privileges, uses a read-only root filesystem, and exposes no host port.
