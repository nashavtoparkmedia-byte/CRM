# Runtime UID/GID contract

## Evidence

- Gateway base index: `node:22.22.2-alpine3.23@sha256:8ea2348b068a9544dae7317b4f3aafcdc032df1647bb7d768a05a5cad1a7683f`; linux/amd64 manifest `sha256:cb15fca92530d7ac113467696cf1001208dac49c3c64355fd1348c11a88ddf8f`. Its immutable config history explicitly runs `addgroup -g 1000 node` and `adduser -u 1000 -G node ... node`.
- Scraper base index: `mcr.microsoft.com/playwright:v1.62.0-noble@sha256:baed2032d533817f3dbe6425de795788430ba345e819a1201337009ba17c9d07`; linux/amd64 manifest `sha256:02bbb2155cd7109e3e9c741941097ed1608cf8b6fa44ee2595896da2bdc1f471`. Its immutable `sha256:50cbb76d250a50002045a95f484c5f40573cde831adbe40c784052c037e36118` config history creates `pwuser`; inspection of the exact layer records UID/GID 1001:1001. The executable workflow independently verifies that final identity before publication.
- The executable workflow independently asserts `process.getuid():process.getgid()` inside both final images.

## Contract

- Gateway: Dockerfile `USER node`, UID 1000, GID 1000, `/app` read-only at runtime except platform-managed temporary files. It has no Chromium profile and no spool mount.
- Scraper: Dockerfile `USER pwuser`, UID 1001, GID 1001. It remains the sole Chromium/profile and durable-spool producer.
- Spool producer: scraper UID/GID 1001:1001.
- Spool consumer: no second filesystem consumer. The gateway receives authenticated HTTP envelopes and must not mount the spool.
- Host spool directory: root-created once as UID/GID 1001:1001 mode 0700. Segment, watermark and metadata files are mode 0600. No world or shared-group access is required.
- Chromium profile remains owned/writable only by scraper UID/GID 1001:1001. It is never mounted into gateway.
- Neither application container has a hidden root requirement. Root is required only for the later host-directory preparation and approved Docker metadata/execution probes.

`chmod 777`, supplementary shared groups and Docker-socket access are prohibited.
