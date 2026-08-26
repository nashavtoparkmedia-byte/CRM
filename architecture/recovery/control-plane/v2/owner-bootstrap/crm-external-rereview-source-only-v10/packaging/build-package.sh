#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
DIST="$PROJECT_ROOT/dist"
PACKAGE="yoko-privileged-runtime_2.0.0-10_all.deb"
EPOCH=1786492800
PROFILE_ID=$(/usr/bin/python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1],encoding="ascii"))["profile_id"])' "$PROJECT_ROOT/src/profile.v1.json")

/usr/bin/python3 -I "$PROJECT_ROOT/packaging/verify-sealed-inputs.py" --phase package >/dev/null
if /usr/bin/grep -R -n --exclude='*.pyc' --exclude-dir='__pycache__' '@[A-Z0-9_][A-Z0-9_]*@' "$PROJECT_ROOT/src" | /usr/bin/grep -v '@OVERLAY_MANIFEST_SHA256@' >/dev/null; then
    echo 'unsealed release placeholders remain' >&2
    exit 1
fi

for file in \
    "$PROJECT_ROOT/src/yoko-privileged-runtime" \
    "$PROJECT_ROOT/src/yoko-privileged-runtime-core.py" \
    "$PROJECT_ROOT/src/predecessor-observability-v1.py" \
    "$PROJECT_ROOT/src/crm-activation-profile.py" \
    "$PROJECT_ROOT/src/policy.v2.base.json" \
    "$PROJECT_ROOT/src/profile.v1.json" \
    "$PROJECT_ROOT/inputs/source.tar.gz" \
    "$PROJECT_ROOT/inputs/gravity-image.docker.tar" \
    "$PROJECT_ROOT/inputs/sealed-inputs.v1.json" \
    "$PROJECT_ROOT/inputs/migration.sql" \
    "$PROJECT_ROOT/packaging/92-yoko-privileged-runtime" \
    "$PROJECT_ROOT/packaging/control" \
    "$PROJECT_ROOT/packaging/postinst"; do
    if [ ! -f "$file" ] || [ -L "$file" ]; then
        echo 'unsafe package build input' >&2
        exit 1
    fi
done

/usr/bin/python3 -I -m py_compile "$PROJECT_ROOT/src/yoko-privileged-runtime" "$PROJECT_ROOT/src/yoko-privileged-runtime-core.py" "$PROJECT_ROOT/src/predecessor-observability-v1.py" "$PROJECT_ROOT/src/crm-activation-profile.py"
/usr/sbin/visudo -cf "$PROJECT_ROOT/packaging/92-yoko-privileged-runtime" >/dev/null
/usr/bin/python3 -I -c 'import json,sys; json.load(open(sys.argv[1],encoding="ascii")); json.load(open(sys.argv[2],encoding="ascii"))' "$PROJECT_ROOT/src/policy.v2.base.json" "$PROJECT_ROOT/src/profile.v1.json"

WORK=$(/usr/bin/mktemp -d "$PROJECT_ROOT/.package-build.XXXXXX")
cleanup() {
    case "$WORK" in
        "$PROJECT_ROOT"/.package-build.*) /usr/bin/rm -rf -- "$WORK" ;;
        *) exit 1 ;;
    esac
}
trap cleanup EXIT HUP INT TERM

stage() {
    root=$1
    profile="$root/usr/local/share/yoko-privileged-runtime/profiles/$PROFILE_ID"
    libexec="$root/usr/local/libexec/yoko-privileged-runtime"
    /usr/bin/install -d -m 0755 "$root/DEBIAN" "$root/usr/local/sbin" "$root/usr/local/share/yoko-privileged-runtime" "$root/usr/local/share/yoko-privileged-runtime/profiles" "$profile" "$root/usr/local/libexec" "$libexec" "$root/etc/sudoers.d"
    /usr/bin/install -m 0644 "$PROJECT_ROOT/packaging/control" "$root/DEBIAN/control"
    /usr/bin/install -m 0755 "$PROJECT_ROOT/packaging/postinst" "$root/DEBIAN/postinst"
    /usr/bin/install -m 0444 "$PROJECT_ROOT/src/yoko-privileged-runtime-core.py" "$libexec/core-2.0.0.py"
    /usr/bin/install -m 0444 "$PROJECT_ROOT/src/predecessor-observability-v1.py" "$libexec/predecessor-observability-v1.py"
    /usr/bin/install -m 0444 "$PROJECT_ROOT/src/crm-activation-profile.py" "$libexec/$PROFILE_ID.py"
    /usr/bin/install -m 0444 "$PROJECT_ROOT/src/profile.v1.json" "$profile/profile.v1.json"
    /usr/bin/install -m 0444 "$PROJECT_ROOT/inputs/source.tar.gz" "$profile/source.tar.gz"
    /usr/bin/install -m 0444 "$PROJECT_ROOT/inputs/gravity-image.docker.tar" "$profile/gravity-image.docker.tar"
    /usr/bin/install -m 0444 "$PROJECT_ROOT/inputs/sealed-inputs.v1.json" "$profile/sealed-inputs.v1.json"
    /usr/bin/install -m 0444 "$PROJECT_ROOT/inputs/migration.sql" "$profile/migration.sql"

    /usr/bin/python3 -I - "$profile/manifest.v1.json" "$libexec/core-2.0.0.py" "$libexec/$PROFILE_ID.py" "$profile/profile.v1.json" "$profile/source.tar.gz" "$profile/gravity-image.docker.tar" "$profile/sealed-inputs.v1.json" "$profile/migration.sql" <<'PY'
import hashlib,json,pathlib,sys
destination=pathlib.Path(sys.argv[1])
files={}
for raw in sys.argv[2:]:
    path=pathlib.Path(raw)
    installed='/usr/' + str(path).split('/usr/',1)[1]
    files[installed]={"sha256":hashlib.sha256(path.read_bytes()).hexdigest(),"mode":"0444"}
value={"schema":"yoko.crm.activation-profile-install-manifest.v1","runtime_abi":"2.0.0","package_version":"2.0.0-10","profile_id":pathlib.Path(destination).parent.name,"files":files}
destination.write_text(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n',encoding='ascii')
PY
    /usr/bin/chmod 0444 "$profile/manifest.v1.json"
    overlay_sha=$(/usr/bin/sha256sum "$profile/manifest.v1.json" | /usr/bin/cut -d ' ' -f 1)
    /usr/bin/sed "s/@OVERLAY_MANIFEST_SHA256@/$overlay_sha/" "$PROJECT_ROOT/src/yoko-privileged-runtime" > "$root/usr/local/sbin/yoko-privileged-runtime"
    /usr/bin/chmod 0755 "$root/usr/local/sbin/yoko-privileged-runtime"
    if /usr/bin/grep -q '@OVERLAY_MANIFEST_SHA256@' "$root/usr/local/sbin/yoko-privileged-runtime"; then
        echo 'wrapper identity substitution failed' >&2
        exit 1
    fi
    /usr/bin/install -m 0444 "$PROJECT_ROOT/src/policy.v2.base.json" "$root/usr/local/share/yoko-privileged-runtime/policy.v2.json"
    /usr/bin/install -m 0440 "$PROJECT_ROOT/packaging/92-yoko-privileged-runtime" "$root/etc/sudoers.d/92-yoko-privileged-runtime"
    exe_sha=$(/usr/bin/sha256sum "$root/usr/local/sbin/yoko-privileged-runtime" | /usr/bin/cut -d ' ' -f 1)
    policy_sha=$(/usr/bin/sha256sum "$root/usr/local/share/yoko-privileged-runtime/policy.v2.json" | /usr/bin/cut -d ' ' -f 1)
    sudoers_sha=$(/usr/bin/sha256sum "$root/etc/sudoers.d/92-yoko-privileged-runtime" | /usr/bin/cut -d ' ' -f 1)
    core_sha=$(/usr/bin/sha256sum "$root/usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py" | /usr/bin/cut -d ' ' -f 1)
    observation_sha=$(/usr/bin/sha256sum "$root/usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py" | /usr/bin/cut -d ' ' -f 1)
    /usr/bin/python3 -I - "$root/usr/local/share/yoko-privileged-runtime/install-manifest.v1.json" "$exe_sha" "$core_sha" "$observation_sha" "$policy_sha" "$sudoers_sha" <<'PY'
import json,pathlib,sys
destination,executable,core,observation,policy,sudoers=sys.argv[1:]
value={"schema":"yoko.privileged-runtime.install-manifest.v1","runtime_version":"2.0.0","files":{"/usr/local/sbin/yoko-privileged-runtime":{"sha256":executable,"mode":"0755"},"/usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py":{"sha256":core,"mode":"0444"},"/usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py":{"sha256":observation,"mode":"0444"},"/usr/local/share/yoko-privileged-runtime/policy.v2.json":{"sha256":policy,"mode":"0444"},"/etc/sudoers.d/92-yoko-privileged-runtime":{"sha256":sudoers,"mode":"0440"}}}
pathlib.Path(destination).write_text(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n',encoding='ascii')
PY
    /usr/bin/chmod 0444 "$root/usr/local/share/yoko-privileged-runtime/install-manifest.v1.json"
    /usr/bin/find "$root" -print0 | /usr/bin/xargs -0 /usr/bin/touch -h -d "@$EPOCH"
}

stage "$WORK/a"
stage "$WORK/b"
SOURCE_DATE_EPOCH=$EPOCH /usr/bin/dpkg-deb --root-owner-group --build -Zgzip -z9 "$WORK/a" "$WORK/a.deb" >/dev/null
SOURCE_DATE_EPOCH=$EPOCH /usr/bin/dpkg-deb --root-owner-group --build -Zgzip -z9 "$WORK/b" "$WORK/b.deb" >/dev/null
/usr/bin/cmp "$WORK/a.deb" "$WORK/b.deb"
/usr/bin/install -m 0444 "$WORK/a.deb" "$DIST/$PACKAGE.new"
/usr/bin/mv -f "$DIST/$PACKAGE.new" "$DIST/$PACKAGE"
/usr/bin/sha256sum "$DIST/$PACKAGE" > "$DIST/$PACKAGE.sha256"
/usr/bin/python3 -I "$PROJECT_ROOT/packaging/verify-sealed-inputs.py" --phase package-output >/dev/null
