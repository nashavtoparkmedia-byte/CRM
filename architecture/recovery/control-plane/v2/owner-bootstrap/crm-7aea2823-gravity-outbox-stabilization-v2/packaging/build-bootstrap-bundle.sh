#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
PAYLOAD="$PROJECT_ROOT/bundle/payload"
OUTPUT="$PROJECT_ROOT/dist/yoko-crm-activation-stabilization-7aea2823-v4.tar"
EPOCH=1786492800

/usr/bin/python3 -I "$PROJECT_ROOT/packaging/finalize-payload.py"

expected='install.sh
payload-manifest.json
yoko-privileged-runtime_2.0.0-8_all.deb
yoko-privileged-runtime_2.0.0-9_all.deb'
actual=$(/usr/bin/find "$PAYLOAD" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | /usr/bin/sort)
test "$actual" = "$expected"
test "$(/usr/bin/find "$PAYLOAD" -mindepth 1 -maxdepth 1 -type d -printf '%f\n')" = 'review'
test ! -L "$PAYLOAD"
test "$(/usr/bin/stat -c '%a' "$PAYLOAD")" = '700'
test "$(/usr/bin/stat -c '%a' "$PAYLOAD/install.sh")" = '500'
for file in payload-manifest.json yoko-privileged-runtime_2.0.0-8_all.deb yoko-privileged-runtime_2.0.0-9_all.deb; do
    test ! -L "$PAYLOAD/$file"
    test "$(/usr/bin/stat -c '%a' "$PAYLOAD/$file")" = '400'
done
test ! -L "$PAYLOAD/review"
test "$(/usr/bin/stat -c '%a' "$PAYLOAD/review")" = '500'
test "$(/usr/bin/find "$PAYLOAD/review" -mindepth 1 -maxdepth 1 -type f -printf '%f\n' | /usr/bin/sort)" = 'human-manifest.md
installation-procedure.md
package-manifest.json
rollback-analysis.md'
for file in human-manifest.md installation-procedure.md package-manifest.json rollback-analysis.md; do
    test ! -L "$PAYLOAD/review/$file"
    test "$(/usr/bin/stat -c '%a' "$PAYLOAD/review/$file")" = '400'
done

WORK=$(/usr/bin/mktemp -d "$PROJECT_ROOT/.bundle-build.XXXXXX")
cleanup() {
    case "$WORK" in
        "$PROJECT_ROOT"/.bundle-build.*) /usr/bin/rm -rf -- "$WORK" ;;
        *) exit 1 ;;
    esac
}
trap cleanup EXIT HUP INT TERM

build() {
    destination=$1
    /usr/bin/tar --sort=name --mtime="@$EPOCH" --owner=0 --group=0 --numeric-owner --format=gnu -C "$PROJECT_ROOT/bundle" -cf "$destination" payload
}
build "$WORK/a.tar"
build "$WORK/b.tar"
/usr/bin/cmp "$WORK/a.tar" "$WORK/b.tar"
/usr/bin/install -m 0444 "$WORK/a.tar" "$OUTPUT.new"
/usr/bin/mv -f "$OUTPUT.new" "$OUTPUT"
/usr/bin/sha256sum "$OUTPUT" > "$OUTPUT.sha256"
