#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"

readonly IMAGE_TAG="yoko/freeswitch-media-dev:fs1.10.12-alchemilla-a25fb1fe"
readonly FREESWITCH_COMMIT="a88d069d6ffb74df797bcaf001f7e63181c07a09"
readonly FREESWITCH_SHA256="ca4932f5d5fb76040901df1eaba3c2d5fb71a500d81549c70f78a8f47c410094"
readonly MODULE_COMMIT="a25fb1fe530ec6a612d321ff04f70be69b1a257c"
readonly MODULE_SHA256="32aa5649c92b6795659cbbc2f53cd3a2d90337e807ce45c366ca7c81a0cf6f46"
readonly SBOM_GENERATOR="docker.io/docker/buildkit-syft-scanner@sha256:79e7b013cbec16bbb436f312819a49a4a57752b2270c1a9332ae1a10fcc82a68"
readonly MIN_BUILD_FREE_BYTES=12884901888
readonly MIN_FINAL_FREE_BYTES=8589934592

work_dir=""

log() {
  printf 'YOKO_FS_MEDIA_BUILD %s\n' "$*"
}

fail() {
  printf 'YOKO_FS_MEDIA_BUILD_ERROR %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || fail "required command not found: $1"
}

available_bytes() {
  df -B1 --output=avail "$SCRIPT_DIR" | awk 'NR == 2 { print $1 }'
}

check_sha256() {
  local expected="$1"
  local path="$2"
  local actual
  actual="$(sha256sum "$path" | awk '{ print $1 }')"
  [[ "$actual" == "$expected" ]] || fail "SHA-256 mismatch for $path: expected $expected, got $actual"
  log "checksum PASS $(basename -- "$path") $actual"
}

cleanup() {
  if [[ -n "$work_dir" && -d "$work_dir" ]]; then
    [[ "$work_dir" == /var/tmp/yoko-fs-media-build.* ]] \
      || fail "refusing to remove unexpected temporary path: $work_dir"
    rm -rf -- "$work_dir"
    log "removed temporary build context $work_dir"
  fi
}

trap cleanup EXIT

for command_name in awk curl df docker git python3 sha256sum timeout; do
  require_command "$command_name"
done

initial_free="$(available_bytes)"
log "free_before_build=$initial_free"
(( initial_free >= MIN_BUILD_FREE_BYTES )) || fail "at least $MIN_BUILD_FREE_BYTES bytes free are required"

work_dir="$(mktemp -d /var/tmp/yoko-fs-media-build.XXXXXX)"
context_dir="$work_dir/context"
module_repo="$work_dir/module-repo"
oci_archive="$work_dir/yoko-fs-media-dev.oci.tar"
metadata_file="$work_dir/build-metadata.json"
mkdir -p "$context_dir"

log "preparing narrow context $context_dir"
cp -a "$SCRIPT_DIR/apt" "$context_dir/apt"
cp -a "$SCRIPT_DIR/config" "$context_dir/config"
cp -a "$SCRIPT_DIR/fs-sdk-stubs" "$context_dir/fs-sdk-stubs"
cp -a "$SCRIPT_DIR/legal" "$context_dir/legal"
cp "$SCRIPT_DIR/Dockerfile.dev" "$context_dir/Dockerfile.dev"
cp "$SCRIPT_DIR/checksums.sha256" "$context_dir/checksums.sha256"
cp "$SCRIPT_DIR/freeswitch.pc" "$context_dir/freeswitch.pc"
cp "$SCRIPT_DIR/fs-sdk-modules.conf" "$context_dir/fs-sdk-modules.conf"
cp "$SCRIPT_DIR/provenance.json" "$context_dir/provenance.json"

log "fetching exact FreeSWITCH source commit $FREESWITCH_COMMIT"
curl \
  --fail \
  --location \
  --proto '=https' \
  --retry 3 \
  --show-error \
  --silent \
  "https://codeload.github.com/signalwire/freeswitch/tar.gz/$FREESWITCH_COMMIT" \
  --output "$context_dir/freeswitch-a88d069d.tar.gz"
check_sha256 "$FREESWITCH_SHA256" "$context_dir/freeswitch-a88d069d.tar.gz"

log "fetching exact module commit $MODULE_COMMIT"
git init --quiet "$module_repo"
git -C "$module_repo" remote add origin https://github.com/AlchemillaHQ/mod-audio-stream.git
git -C "$module_repo" fetch --quiet --depth 1 origin "$MODULE_COMMIT"
resolved_module_commit="$(git -C "$module_repo" rev-parse FETCH_HEAD)"
[[ "$resolved_module_commit" == "$MODULE_COMMIT" ]] || fail "module commit mismatch: $resolved_module_commit"
git -C "$module_repo" archive \
  --format=tar.gz \
  --prefix=mod-audio-stream/ \
  --output="$context_dir/mod-audio-stream-a25fb1fe.tar.gz" \
  "$MODULE_COMMIT"
check_sha256 "$MODULE_SHA256" "$context_dir/mod-audio-stream-a25fb1fe.tar.gz"

log "building pinned OCI image with BuildKit SBOM and SLSA provenance"
timeout --signal=TERM 30m docker buildx build \
  --progress=plain \
  --platform linux/amd64 \
  --file "$context_dir/Dockerfile.dev" \
  --tag "$IMAGE_TAG" \
  --attest "type=sbom,generator=$SBOM_GENERATOR" \
  --attest "type=provenance,mode=max" \
  --metadata-file "$metadata_file" \
  --output "type=oci,dest=$oci_archive" \
  "$context_dir"

if [[ -n "${YOKO_ATTESTATION_DIR:-}" ]]; then
  mkdir -p "$YOKO_ATTESTATION_DIR"
  python3 "$SCRIPT_DIR/capability/extract-oci-attestations.py" \
    "$oci_archive" \
    "$YOKO_ATTESTATION_DIR"
fi

log "loading exact OCI artifact into the local DEV image store"
docker image load --input "$oci_archive"
docker image inspect "$IMAGE_TAG" >/dev/null

final_free="$(available_bytes)"
log "free_after_build=$final_free"
(( final_free >= MIN_FINAL_FREE_BYTES )) || fail "final free space fell below $MIN_FINAL_FREE_BYTES bytes"

image_id="$(docker image inspect --format '{{.Id}}' "$IMAGE_TAG")"
image_size="$(docker image inspect --format '{{.Size}}' "$IMAGE_TAG")"
log "PASS image=$IMAGE_TAG id=$image_id size=$image_size"
