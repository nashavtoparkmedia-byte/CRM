#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd -P)
DIST="$PROJECT_ROOT/dist"
GENERATED="$PROJECT_ROOT/generated"
PACKAGE='yoko-privileged-runtime_2.0.0-15_all.deb'
PROFILE_ID='crm-6e3f094bf4b4-gravity-max-source-v1'
EPOCH=1788307200

for file in \
    "$PROJECT_ROOT/src/yoko-privileged-runtime-core.py" \
    "$PROJECT_ROOT/src/predecessor-observability-v1.py" \
    "$PROJECT_ROOT/src/policy.v2.base.json" \
    "$PROJECT_ROOT/templates/yoko-privileged-runtime.in" \
    "$PROJECT_ROOT/templates/crm-activation-profile.py.in" \
    "$PROJECT_ROOT/templates/postinst.in" \
    "$PROJECT_ROOT/packaging/92-yoko-privileged-runtime" \
    "$PROJECT_ROOT/packaging/control" \
    "$GENERATED/crm-activation-profile.py" \
    "$GENERATED/profile.v1.json" \
    "$GENERATED/sealed-inputs.v1.json"; do
    test -f "$file"
    test ! -L "$file"
done

test "$(/usr/bin/sha256sum "$PROJECT_ROOT/src/yoko-privileged-runtime-core.py" | /usr/bin/cut -d ' ' -f 1)" = '0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa'
test "$(/usr/bin/sha256sum "$PROJECT_ROOT/src/predecessor-observability-v1.py" | /usr/bin/cut -d ' ' -f 1)" = 'b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084'
test "$(/usr/bin/sha256sum "$PROJECT_ROOT/src/policy.v2.base.json" | /usr/bin/cut -d ' ' -f 1)" = '8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0'
test "$(/usr/bin/sha256sum "$PROJECT_ROOT/packaging/92-yoko-privileged-runtime" | /usr/bin/cut -d ' ' -f 1)" = '3022dcfc323706da81e760255dd1ab43f9b8662ee699aa8b58fbe6e714cc69d7'
/usr/bin/python3 -I -m py_compile "$GENERATED/crm-activation-profile.py" "$PROJECT_ROOT/templates/yoko-privileged-runtime.in" "$PROJECT_ROOT/src/yoko-privileged-runtime-core.py" "$PROJECT_ROOT/src/predecessor-observability-v1.py"
/usr/sbin/visudo -cf "$PROJECT_ROOT/packaging/92-yoko-privileged-runtime" >/dev/null
/usr/bin/python3 -I "$PROJECT_ROOT/packaging/verify-sealed-inputs.py" --phase package >/dev/null
/usr/bin/install -d -m 0755 "$DIST"

WORK=$(/usr/bin/mktemp -d "$PROJECT_ROOT/.package-build.XXXXXXXX")
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
    /usr/bin/install -m 0755 "$PROJECT_ROOT/templates/postinst.in" "$root/DEBIAN/postinst"
    /usr/bin/install -m 0444 "$PROJECT_ROOT/src/yoko-privileged-runtime-core.py" "$libexec/core-2.0.0.py"
    /usr/bin/install -m 0444 "$PROJECT_ROOT/src/predecessor-observability-v1.py" "$libexec/predecessor-observability-v1.py"
    /usr/bin/install -m 0444 "$GENERATED/crm-activation-profile.py" "$libexec/$PROFILE_ID.py"
    /usr/bin/install -m 0444 "$GENERATED/profile.v1.json" "$profile/profile.v1.json"
    /usr/bin/install -m 0444 "$GENERATED/sealed-inputs.v1.json" "$profile/sealed-inputs.v1.json"

    /usr/bin/python3 -I - "$profile/manifest.v1.json" "$libexec/core-2.0.0.py" "$libexec/$PROFILE_ID.py" "$profile/profile.v1.json" "$profile/sealed-inputs.v1.json" <<'PY'
import hashlib,json,pathlib,sys
destination=pathlib.Path(sys.argv[1])
files={}
for raw in sys.argv[2:]:
    path=pathlib.Path(raw)
    installed='/usr/' + str(path).split('/usr/',1)[1]
    files[installed]={"sha256":hashlib.sha256(path.read_bytes()).hexdigest(),"mode":"0444"}
value={"schema":"yoko.crm.activation-profile-install-manifest.v1","runtime_abi":"2.0.0","package_version":"2.0.0-15","profile_id":destination.parent.name,"files":files}
destination.write_text(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n',encoding='ascii')
PY
    /usr/bin/chmod 0444 "$profile/manifest.v1.json"
    manifest_sha=$(/usr/bin/sha256sum "$profile/manifest.v1.json" | /usr/bin/cut -d ' ' -f 1)
    /usr/bin/sed "s/@PROFILE_MANIFEST_SHA256@/$manifest_sha/" "$PROJECT_ROOT/templates/yoko-privileged-runtime.in" > "$root/usr/local/sbin/yoko-privileged-runtime"
    /usr/bin/chmod 0755 "$root/usr/local/sbin/yoko-privileged-runtime"
    ! /usr/bin/grep -q '@PROFILE_MANIFEST_SHA256@' "$root/usr/local/sbin/yoko-privileged-runtime"
    /usr/bin/install -m 0444 "$PROJECT_ROOT/src/policy.v2.base.json" "$root/usr/local/share/yoko-privileged-runtime/policy.v2.json"
    /usr/bin/install -m 0440 "$PROJECT_ROOT/packaging/92-yoko-privileged-runtime" "$root/etc/sudoers.d/92-yoko-privileged-runtime"

    exe_sha=$(/usr/bin/sha256sum "$root/usr/local/sbin/yoko-privileged-runtime" | /usr/bin/cut -d ' ' -f 1)
    core_sha=$(/usr/bin/sha256sum "$libexec/core-2.0.0.py" | /usr/bin/cut -d ' ' -f 1)
    observer_sha=$(/usr/bin/sha256sum "$libexec/predecessor-observability-v1.py" | /usr/bin/cut -d ' ' -f 1)
    policy_sha=$(/usr/bin/sha256sum "$root/usr/local/share/yoko-privileged-runtime/policy.v2.json" | /usr/bin/cut -d ' ' -f 1)
    sudoers_sha=$(/usr/bin/sha256sum "$root/etc/sudoers.d/92-yoko-privileged-runtime" | /usr/bin/cut -d ' ' -f 1)
    /usr/bin/python3 -I - "$root/usr/local/share/yoko-privileged-runtime/install-manifest.v1.json" "$exe_sha" "$core_sha" "$observer_sha" "$policy_sha" "$sudoers_sha" <<'PY'
import json,pathlib,sys
destination,executable,core,observer,policy,sudoers=sys.argv[1:]
value={"schema":"yoko.privileged-runtime.install-manifest.v1","runtime_version":"2.0.0","files":{"/usr/local/sbin/yoko-privileged-runtime":{"sha256":executable,"mode":"0755"},"/usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py":{"sha256":core,"mode":"0444"},"/usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py":{"sha256":observer,"mode":"0444"},"/usr/local/share/yoko-privileged-runtime/policy.v2.json":{"sha256":policy,"mode":"0444"},"/etc/sudoers.d/92-yoko-privileged-runtime":{"sha256":sudoers,"mode":"0440"}}}
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
