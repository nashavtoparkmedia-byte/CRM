#!/usr/bin/env bash
# Download and verify the pinned Gradle distribution named in
# gradle/wrapper/gradle-wrapper.properties, then exec it.
#
# The wrapper JAR is not committed, so this script is the entry point for
# building the shell. It fails closed on a checksum mismatch.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(dirname "$here")"
props="$root/gradle/wrapper/gradle-wrapper.properties"

url="$(sed -n 's/^distributionUrl=//p' "$props" | sed 's/\\//g')"
want="$(sed -n 's/^distributionSha256Sum=//p' "$props")"
version="$(basename "$url" | sed 's/^gradle-//; s/-bin\.zip$//')"

cache="${GRADLE_BOOTSTRAP_DIR:-$HOME/.gradle-bootstrap}"
home="$cache/gradle-$version"
mkdir -p "$cache"

if [ ! -x "$home/bin/gradle" ]; then
    zip="$cache/gradle-$version-bin.zip"
    echo "[bootstrap] downloading $url"
    curl -fsSL -o "$zip" "$url"
    got="$(sha256sum "$zip" | cut -d' ' -f1)"
    if [ "$got" != "$want" ]; then
        echo "[bootstrap] checksum mismatch for gradle-$version" >&2
        echo "[bootstrap]   expected $want" >&2
        echo "[bootstrap]   actual   $got" >&2
        rm -f "$zip"
        exit 1
    fi
    echo "[bootstrap] checksum ok, unpacking"
    rm -rf "$home"
    unzip -q "$zip" -d "$cache"
fi

exec "$home/bin/gradle" -p "$root" "$@"
