#!/bin/sh
# Build the same-version 2.0.0-21 interim package that installs predecessor
# observation v2.  Run as the unprivileged builder (codexbot); installs nothing.
set -eu
umask 022

PROJECT_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
HERE="$PROJECT_ROOT/packaging/predecessor-observability-v2"
REPO_ROOT=$(/usr/bin/git -C "$PROJECT_ROOT" rev-parse --show-toplevel)
BRANCH='codex/predecessor-observability-v2-10318827'
PROFILE_ID='crm-ba90ed4b6717-gravity-max-source-v1'
VERSION='2.0.0-21'
INSTALLED_PROFILE="/usr/local/share/yoko-privileged-runtime/profiles/$PROFILE_ID"
INSTALLED_PROFILE_RUNTIME="/usr/local/libexec/yoko-privileged-runtime/$PROFILE_ID.py"
OUTPUT="$PROJECT_ROOT/dist/predecessor-observability-v2"
PACKAGE_NAME="yoko-privileged-runtime_${VERSION}_all.deb"
EPOCH=1790899200

# Exact installed 2.0.0-21 (DEB 17b97c40...) identities.
ROLLBACK_DEB_SHA256='17b97c4048fb8cce2ab5d43aff23e7542397678c8abd7c8b8790cca26db2f35a'
OLD_RUNTIME_SHA256='e4c327c3b397ffeac8c47f5b7ddb6b2a7b4e0cbcdd5e737560a615724468b1f0'
OLD_OBSERVER_SHA256='b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084'
OLD_INSTALL_MANIFEST_SHA256='a96ca3929174692056a5550acc970f1f5bd987f4d429e91078994d2f58a10bd3'
CORE_SHA256='0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa'
POLICY_SHA256='8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0'
SUDOERS_SHA256='3022dcfc323706da81e760255dd1ab43f9b8662ee699aa8b58fbe6e714cc69d7'
PROFILE_RUNTIME_SHA256='334603195d4cdfc70513637e29d6b73c57c7050a6bd331402cc0696cee27fa10'
PROFILE_MANIFEST_SHA256='743e22164a8101a2a1d049b1581cf39da0b36c200b9303dab0af29b0480cec2a'
PROFILE_JSON_SHA256='97dd62ea7fba53a3d7c382b723bf131b63a3dc091688de1bf4882471d4c65274'
SEALED_INPUTS_SHA256='fd87a49e428f0099372edd3e37cef3bd8a7cb7731c615e83ed22e033b702745a'
# The one new control.
NEW_OBSERVER_SHA256='047a6d9717db1378825b6d69916dbc6ad601fa703df5ca3114799c6d0e997533'
CONTROL_SHA256='33bb0361a12314fe42cb8575c7e502a304cb9ba2d64644c2809b31251fea8c8d'
POSTINST_SHA256='fb0945ca51dcb6d6a96890569a3a1be26f9242d1c1e01cd3707b75696a182456'

hash_is() {
    [ -f "$1" ] && [ ! -L "$1" ] \
        && [ "$(/usr/bin/sha256sum "$1" | /usr/bin/cut -d ' ' -f 1)" = "$2" ]
}
require() {
    if ! hash_is "$1" "$2"; then
        echo "identity mismatch: $1" >&2
        exit 78
    fi
}

[ "$(/usr/bin/id -u)" != 0 ] || { echo 'build as the unprivileged builder, not root' >&2; exit 78; }
[ "$(/usr/bin/git -C "$REPO_ROOT" branch --show-current)" = "$BRANCH" ] || { echo 'interim package must be built from the exact observer branch' >&2; exit 78; }
[ -z "$(/usr/bin/git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ] || { echo 'interim package source tree must be a clean exact commit' >&2; exit 78; }
SOURCE_COMMIT=$(/usr/bin/git -C "$REPO_ROOT" rev-parse HEAD)
SOURCE_TREE=$(/usr/bin/git -C "$REPO_ROOT" rev-parse 'HEAD^{tree}')

[ "$(/usr/bin/dpkg-query -W -f='${Status} ${Version}\n' yoko-privileged-runtime 2>/dev/null)" = "install ok installed $VERSION" ] \
    || { echo 'installed Runtime package identity mismatch' >&2; exit 78; }
require /usr/local/sbin/yoko-privileged-runtime "$OLD_RUNTIME_SHA256"
require /usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py "$CORE_SHA256"
require /usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py "$OLD_OBSERVER_SHA256"
require /usr/local/share/yoko-privileged-runtime/policy.v2.json "$POLICY_SHA256"
require /usr/local/share/yoko-privileged-runtime/install-manifest.v1.json "$OLD_INSTALL_MANIFEST_SHA256"
require "$INSTALLED_PROFILE_RUNTIME" "$PROFILE_RUNTIME_SHA256"
require "$INSTALLED_PROFILE/manifest.v1.json" "$PROFILE_MANIFEST_SHA256"
require "$INSTALLED_PROFILE/profile.v1.json" "$PROFILE_JSON_SHA256"
require "$INSTALLED_PROFILE/sealed-inputs.v1.json" "$SEALED_INPUTS_SHA256"
# The sudoers leaf is root-only; the installed Runtime reports its identity.
[ "$(/usr/bin/sudo -n /usr/local/sbin/yoko-privileged-runtime recovery-status \
    | /usr/bin/python3 -I -c 'import json,sys; v=json.load(sys.stdin); assert v["ok"] is True; print(v["evidence"]["identity"]["/etc/sudoers.d/92-yoko-privileged-runtime"])')" = "$SUDOERS_SHA256" ] \
    || { echo 'installed Runtime sudoers identity mismatch' >&2; exit 78; }
[ "$(/usr/bin/sudo -n /usr/local/sbin/yoko-privileged-runtime version \
    | /usr/bin/python3 -I -c 'import json,sys; v=json.load(sys.stdin); assert v["ok"] is True; e=v["evidence"]; print(e["package_version"], e["activation_profile"])')" = "$VERSION $PROFILE_ID" ] \
    || { echo 'installed Runtime profile identity mismatch' >&2; exit 78; }

require "$PROJECT_ROOT/src/predecessor-observability-v1.py" "$NEW_OBSERVER_SHA256"
require "$PROJECT_ROOT/src/yoko-privileged-runtime-core.py" "$CORE_SHA256"
require "$PROJECT_ROOT/src/policy.v2.base.json" "$POLICY_SHA256"
require "$PROJECT_ROOT/packaging/92-yoko-privileged-runtime" "$SUDOERS_SHA256"
require "$HERE/control" "$CONTROL_SHA256"
require "$HERE/postinst" "$POSTINST_SHA256"
/usr/bin/python3 -I -c 'import pathlib,sys; [compile(pathlib.Path(path).read_bytes(),path,"exec") for path in sys.argv[1:]]' \
    "$PROJECT_ROOT/src/predecessor-observability-v1.py"

WORK=$(/usr/bin/mktemp -d "$PROJECT_ROOT/.package-build.observer-v2.XXXXXX")
cleanup() {
    case "$WORK" in
        "$PROJECT_ROOT"/.package-build.observer-v2.*)
            /usr/bin/chmod -R u+w "$WORK" 2>/dev/null || true
            /usr/bin/find "$WORK" -depth \( -type f -o -type l \) -exec /usr/bin/unlink {} \;
            /usr/bin/find "$WORK" -depth -type d -exec /usr/bin/rmdir {} \;
            ;;
        *) exit 1 ;;
    esac
}
trap cleanup EXIT HUP INT TERM

STAGE="$WORK/root"
SHARE="$STAGE/usr/local/share/yoko-privileged-runtime"
PROFILE="$SHARE/profiles/$PROFILE_ID"
LIBEXEC="$STAGE/usr/local/libexec/yoko-privileged-runtime"
/usr/bin/install -d -m 0755 "$STAGE/DEBIAN" "$STAGE/etc/sudoers.d" "$STAGE/usr/local/sbin" \
    "$STAGE/usr/local/libexec" "$LIBEXEC" "$SHARE" "$SHARE/profiles" "$PROFILE"
/usr/bin/install -m 0644 "$HERE/control" "$STAGE/DEBIAN/control"
/usr/bin/install -m 0755 "$HERE/postinst" "$STAGE/DEBIAN/postinst"
/usr/bin/install -m 0440 "$PROJECT_ROOT/packaging/92-yoko-privileged-runtime" "$STAGE/etc/sudoers.d/92-yoko-privileged-runtime"
/usr/bin/install -m 0444 "$PROJECT_ROOT/src/yoko-privileged-runtime-core.py" "$LIBEXEC/core-2.0.0.py"
/usr/bin/install -m 0444 "$PROJECT_ROOT/src/predecessor-observability-v1.py" "$LIBEXEC/predecessor-observability-v1.py"
/usr/bin/install -m 0444 "$INSTALLED_PROFILE_RUNTIME" "$LIBEXEC/$PROFILE_ID.py"
/usr/bin/install -m 0444 "$PROJECT_ROOT/src/policy.v2.base.json" "$SHARE/policy.v2.json"
for name in manifest.v1.json profile.v1.json sealed-inputs.v1.json; do
    /usr/bin/install -m 0444 "$INSTALLED_PROFILE/$name" "$PROFILE/$name"
done

# Wrapper: the installed bytes with exactly the observer pin replaced.
/usr/bin/python3 -I - /usr/local/sbin/yoko-privileged-runtime "$STAGE/usr/local/sbin/yoko-privileged-runtime" "$OLD_OBSERVER_SHA256" "$NEW_OBSERVER_SHA256" <<'PY'
import pathlib,sys
source,destination,old,new=sys.argv[1:]
before=pathlib.Path(source).read_bytes()
old_line=('PREDECESSOR_OBSERVABILITY_SHA256 = "%s"\n'%old).encode('ascii')
new_line=('PREDECESSOR_OBSERVABILITY_SHA256 = "%s"\n'%new).encode('ascii')
if before.count(old_line)!=1 or before.count(old.encode('ascii'))!=1: raise SystemExit('wrapper observer pin is not unique')
after=before.replace(old_line,new_line)
changed=[(a,b) for a,b in zip(before.split(b'\n'),after.split(b'\n')) if a!=b]
if len(before.split(b'\n'))!=len(after.split(b'\n')) or changed!=[(old_line.rstrip(b'\n'),new_line.rstrip(b'\n'))]: raise SystemExit('wrapper delta is not exactly the observer pin')
pathlib.Path(destination).write_bytes(after)
PY
/usr/bin/chmod 0755 "$STAGE/usr/local/sbin/yoko-privileged-runtime"
RUNTIME_SHA256=$(/usr/bin/sha256sum "$STAGE/usr/local/sbin/yoko-privileged-runtime" | /usr/bin/cut -d ' ' -f 1)

# Install manifest: the installed record with exactly two digests moved.
/usr/bin/python3 -I - /usr/local/share/yoko-privileged-runtime/install-manifest.v1.json "$SHARE/install-manifest.v1.json" "$RUNTIME_SHA256" "$NEW_OBSERVER_SHA256" <<'PY'
import json,pathlib,sys
source,destination,runtime,observer=sys.argv[1:]
raw=pathlib.Path(source).read_bytes()
value=json.loads(raw)
render=lambda item:(json.dumps(item,sort_keys=True,separators=(',',':'))+'\n').encode('ascii')
if render(value)!=raw: raise SystemExit('installed install manifest is not in canonical form')
files=value['files']
files['/usr/local/sbin/yoko-privileged-runtime']['sha256']=runtime
files['/usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py']['sha256']=observer
pathlib.Path(destination).write_bytes(render(value))
PY
/usr/bin/chmod 0444 "$SHARE/install-manifest.v1.json"
INSTALL_MANIFEST_SHA256=$(/usr/bin/sha256sum "$SHARE/install-manifest.v1.json" | /usr/bin/cut -d ' ' -f 1)

# Staged contract: self-check, capabilities and argument rejection in test-root mode.
/usr/bin/install -d -m 0755 "$STAGE/usr/sbin" "$STAGE/var" "$STAGE/var/lib"
/usr/bin/install -m 0755 "$HERE/test-visudo.sh" "$STAGE/usr/sbin/visudo"
for verb in self-check capabilities; do
    if ! PYTHONDONTWRITEBYTECODE=1 YOKO_PRIVILEGED_RUNTIME_TEST_ROOT="$STAGE" "$STAGE/usr/local/sbin/yoko-privileged-runtime" "$verb" > "$WORK/$verb.json"; then
        /usr/bin/python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1])); print(json.dumps({"ok":v.get("ok"),"errors":v.get("errors")}),file=sys.stderr)' "$WORK/$verb.json"
        exit 78
    fi
done
/usr/bin/python3 -I - "$WORK/self-check.json" "$WORK/capabilities.json" "$NEW_OBSERVER_SHA256" "$PROFILE_ID" "$VERSION" <<'PY'
import json,sys
check,capabilities,observer,profile,version=sys.argv[1:]
v=json.load(open(check)); e=v['evidence']
if not (v['ok'] is True and e['predecessor_observability_sha256']==observer and e['activation_profile_id']==profile and e['package_version']==version and e['coordinated_pair']==['gravity-mvp','max-web-scraper']):
    raise SystemExit('staged Runtime self-check failed')
c=json.load(open(capabilities)); f=c['evidence']
if not (c['ok'] is True and f['enabled_read_only_profiles']==['predecessor-observe'] and f['enabled_activation_profiles']==['database-status','release-preflight','release-activate','rollback'] and f['activation_profile_id']==profile):
    raise SystemExit('staged Runtime capabilities failed')
PY
if PYTHONDONTWRITEBYTECODE=1 YOKO_PRIVILEGED_RUNTIME_TEST_ROOT="$STAGE" "$STAGE/usr/local/sbin/yoko-privileged-runtime" predecessor-observe unexpected >/dev/null 2>&1; then
    echo 'staged Runtime accepted observation arguments' >&2
    exit 78
fi
/usr/bin/unlink "$STAGE/usr/sbin/visudo"
/usr/bin/rmdir "$STAGE/usr/sbin"
/usr/bin/find "$STAGE/var" -depth -type f -exec /usr/bin/unlink {} \;
/usr/bin/find "$STAGE/var" -depth -type d -exec /usr/bin/rmdir {} \;
/usr/bin/find "$STAGE" -name __pycache__ -type d -prune -exec /usr/bin/rm -r {} \;

/usr/bin/find "$STAGE" -print0 | /usr/bin/xargs -0 /usr/bin/touch -h -d "@$EPOCH"
SOURCE_DATE_EPOCH=$EPOCH /usr/bin/dpkg-deb --root-owner-group --build -Zgzip -z9 "$STAGE" "$WORK/a.deb" >/dev/null
SOURCE_DATE_EPOCH=$EPOCH /usr/bin/dpkg-deb --root-owner-group --build -Zgzip -z9 "$STAGE" "$WORK/b.deb" >/dev/null
/usr/bin/cmp "$WORK/a.deb" "$WORK/b.deb"
[ "$(/usr/bin/dpkg-deb -f "$WORK/a.deb" Package) $(/usr/bin/dpkg-deb -f "$WORK/a.deb" Version) $(/usr/bin/dpkg-deb -f "$WORK/a.deb" Architecture)" = "yoko-privileged-runtime $VERSION all" ] \
    || { echo 'interim package metadata mismatch' >&2; exit 78; }

/usr/bin/python3 -I - "$STAGE" "$WORK/expected-data.json" "$PROFILE_ID" <<'PY'
import hashlib,json,pathlib,stat,sys
root=pathlib.Path(sys.argv[1]); output=pathlib.Path(sys.argv[2]); profile=sys.argv[3]; records={}
for path in sorted(root.rglob('*')):
    if 'DEBIAN' in path.relative_to(root).parts or not path.is_file(): continue
    records['./'+path.relative_to(root).as_posix()]={'sha256':hashlib.sha256(path.read_bytes()).hexdigest(),'mode':format(stat.S_IMODE(path.stat().st_mode),'04o')}
share='./usr/local/share/yoko-privileged-runtime/'
allowed={
 './etc/sudoers.d/92-yoko-privileged-runtime',
 './usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py',
 './usr/local/libexec/yoko-privileged-runtime/'+profile+'.py',
 './usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py',
 './usr/local/sbin/yoko-privileged-runtime',
 share+'install-manifest.v1.json', share+'policy.v2.json',
 *(share+'profiles/'+profile+'/'+name for name in ('manifest.v1.json','profile.v1.json','sealed-inputs.v1.json')),
}
if set(records)!=allowed: raise SystemExit('staged package data allowlist mismatch')
output.write_text(json.dumps(records,sort_keys=True,separators=(',',':'))+'\n',encoding='ascii')
PY
/usr/bin/dpkg-deb --fsys-tarfile "$WORK/a.deb" | /usr/bin/python3 -I "$HERE/audit-data-tar.py" "$WORK/expected-data.json"

/usr/bin/install -d -m 0755 "$PROJECT_ROOT/dist"
/usr/bin/install -d -m 0755 "$OUTPUT"
PACKAGE_PATH="$OUTPUT/$PACKAGE_NAME"
/usr/bin/chmod 0444 "$WORK/a.deb"
/usr/bin/mv -f "$WORK/a.deb" "$PACKAGE_PATH"
PACKAGE_SHA256=$(/usr/bin/sha256sum "$PACKAGE_PATH" | /usr/bin/cut -d ' ' -f 1)

INSTALLER="$OUTPUT/install-predecessor-observability-v2.sh"
/usr/bin/python3 -I - "$HERE/install-package.sh.in" "$WORK/installer" \
    "$PACKAGE_PATH" "$PACKAGE_SHA256" "$SOURCE_COMMIT" "$RUNTIME_SHA256" "$NEW_OBSERVER_SHA256" "$INSTALL_MANIFEST_SHA256" <<'PY'
import pathlib,sys
source,destination,package_path,package_sha,commit,runtime,observer,manifest=sys.argv[1:]
tokens={'PACKAGE_PATH':package_path,'PACKAGE_SHA256':package_sha,'SOURCE_COMMIT':commit,'NEW_RUNTIME_SHA256':runtime,'NEW_OBSERVER_SHA256':observer,'NEW_INSTALL_MANIFEST_SHA256':manifest}
value=pathlib.Path(source).read_text(encoding='ascii')
for key,replacement in tokens.items():
    token='@'+key+'@'
    if token not in value: raise SystemExit('missing installer token: '+token)
    value=value.replace(token,replacement)
import re
if re.search(r'@[A-Z0-9_]+@',value): raise SystemExit('unresolved installer token')
pathlib.Path(destination).write_text(value,encoding='ascii')
PY
/usr/bin/chmod 0555 "$WORK/installer"
/usr/bin/mv -f "$WORK/installer" "$INSTALLER"
INSTALLER_SHA256=$(/usr/bin/sha256sum "$INSTALLER" | /usr/bin/cut -d ' ' -f 1)
# Root runs a verified root-owned copy, never the file in this unprivileged tree.
OWNER_COMMAND="D=\$(/usr/bin/mktemp -d /root/yoko-observer-v2-install.XXXXXX) && /usr/bin/install -o root -g root -m 0500 '$INSTALLER' \"\$D/install.sh\" && /usr/bin/test \"\$(/usr/bin/sha256sum \"\$D/install.sh\" | /usr/bin/cut -d ' ' -f 1)\" = '$INSTALLER_SHA256' && /bin/sh \"\$D/install.sh\"; rc=\$?; /usr/bin/rm -rf -- \"\$D\"; exit \$rc"

/usr/bin/python3 -I - "$WORK/package-manifest.json" "$SOURCE_COMMIT" "$SOURCE_TREE" "$PACKAGE_SHA256" "$INSTALLER_SHA256" "$RUNTIME_SHA256" "$NEW_OBSERVER_SHA256" "$INSTALL_MANIFEST_SHA256" "$ROLLBACK_DEB_SHA256" <<'PY'
import json,pathlib,sys
destination,commit,tree,package,installer,runtime,observer,manifest,rollback=sys.argv[1:]
store='/var/lib/yoko-privileged-runtime/activation-bootstraps/'
value={
 'schema':'yoko.crm.predecessor-observability-package.v2',
 'source':{'commit':commit,'tree':tree,'branch':'codex/predecessor-observability-v2-10318827'},
 'package':{'name':'yoko-privileged-runtime','version':'2.0.0-21','architecture':'all','sha256':package,
            'root_store_path':store+package+'/yoko-privileged-runtime_2.0.0-21_all.deb','deterministic_double_build':True},
 'installer':{'sha256':installer,'idempotent':True,'automatic_failure_rollback':True},
 'observer':{'install_slot':'/usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py','schema':'yoko.crm.predecessor-recreation-observation.v2','sha256':observer,
             'replaces_sha256':'b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084'},
 'changed_files':{
  '/usr/local/sbin/yoko-privileged-runtime':{'from':'e4c327c3b397ffeac8c47f5b7ddb6b2a7b4e0cbcdd5e737560a615724468b1f0','to':runtime},
  '/usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py':{'from':'b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084','to':observer},
  '/usr/local/share/yoko-privileged-runtime/install-manifest.v1.json':{'from':'a96ca3929174692056a5550acc970f1f5bd987f4d429e91078994d2f58a10bd3','to':manifest},
 },
 'preserved_files':{
  '/etc/sudoers.d/92-yoko-privileged-runtime':'3022dcfc323706da81e760255dd1ab43f9b8662ee699aa8b58fbe6e714cc69d7',
  '/usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py':'0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa',
  '/usr/local/libexec/yoko-privileged-runtime/crm-ba90ed4b6717-gravity-max-source-v1.py':'334603195d4cdfc70513637e29d6b73c57c7050a6bd331402cc0696cee27fa10',
  '/usr/local/share/yoko-privileged-runtime/policy.v2.json':'8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0',
  '/usr/local/share/yoko-privileged-runtime/profiles/crm-ba90ed4b6717-gravity-max-source-v1/manifest.v1.json':'743e22164a8101a2a1d049b1581cf39da0b36c200b9303dab0af29b0480cec2a',
  '/usr/local/share/yoko-privileged-runtime/profiles/crm-ba90ed4b6717-gravity-max-source-v1/profile.v1.json':'97dd62ea7fba53a3d7c382b723bf131b63a3dc091688de1bf4882471d4c65274',
  '/usr/local/share/yoko-privileged-runtime/profiles/crm-ba90ed4b6717-gravity-max-source-v1/sealed-inputs.v1.json':'fd87a49e428f0099372edd3e37cef3bd8a7cb7731c615e83ed22e033b702745a',
 },
 'privilege_delta':{'new_commands':[],'new_arguments':[],'sudoers_changed':False,'policy_changed':False,'core_changed':False,'activation_profile_changed':False,'production_mutation':False},
 'rollback':{'package_sha256':rollback,'package_path':store+rollback+'/yoko-privileged-runtime_2.0.0-21_all.deb','method':'exact prior package reinstall'},
}
pathlib.Path(destination).write_text(json.dumps(value,sort_keys=True,indent=1)+'\n',encoding='ascii')
PY
/usr/bin/chmod 0444 "$WORK/package-manifest.json"
/usr/bin/mv -f "$WORK/package-manifest.json" "$OUTPUT/package-manifest.json"
printf '%s\n' "$OWNER_COMMAND" > "$OUTPUT/OWNER_COMMAND.txt"
printf 'PACKAGE=%s\nPACKAGE_SHA256=%s\nINSTALLER=%s\nINSTALLER_SHA256=%s\nSOURCE_COMMIT=%s\nSOURCE_TREE=%s\nPACKAGE_MANIFEST_SHA256=%s\n' \
    "$PACKAGE_PATH" "$PACKAGE_SHA256" "$INSTALLER" "$INSTALLER_SHA256" "$SOURCE_COMMIT" "$SOURCE_TREE" \
    "$(/usr/bin/sha256sum "$OUTPUT/package-manifest.json" | /usr/bin/cut -d ' ' -f 1)"
