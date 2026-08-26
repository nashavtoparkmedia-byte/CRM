#!/bin/sh
set -eu

PROJECT_ROOT=$(CDPATH='' cd -- "$(dirname -- "$0")/../.." && pwd -P)
REPO_ROOT=$(CDPATH='' cd -- "$PROJECT_ROOT/../../../../../.." && pwd -P)
PROFILE_ID='crm-08b9145945b2-gravity-source-v1'
INSTALLED_PROFILE="/usr/local/share/yoko-privileged-runtime/profiles/$PROFILE_ID"
INSTALLED_PROFILE_RUNTIME="/usr/local/libexec/yoko-privileged-runtime/$PROFILE_ID.py"
OUTPUT="$PROJECT_ROOT/dist/predecessor-observability-v1"
PACKAGE_NAME='yoko-privileged-runtime_2.0.0-10_predecessor-observability-v1_all.deb'
PACKAGE_PATH="$OUTPUT/$PACKAGE_NAME"
EPOCH=1786492800

OLD_POLICY_SHA256='8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0'
ROLLBACK_DEB_SHA256='6865eab377dda757d101259e7321268998b45ea8b27f6003de0cf7e191a9b54e'
PREVIOUS_RUNTIME_SHA256='544e6d5ace56ab737475ad316e17f6ac12a15ed7706c7f25f1bf97639c2ab7bc'
PREVIOUS_CORE_SHA256='0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa'
PREVIOUS_OBSERVER_SHA256='b870bb3cf1ad35cabd1c58c189232af5c01d683687ffca1d55a86ceb397afa59'
PREVIOUS_SUDOERS_SHA256='3022dcfc323706da81e760255dd1ab43f9b8662ee699aa8b58fbe6e714cc69d7'
PREVIOUS_INSTALL_MANIFEST_SHA256='93ce5ed5dfe77b5f094e04523a4c71641d3a3621dcb0fbf98061e716e34c0db5'
PREVIOUS_PROFILE_MANIFEST_SHA256='0c948717cf6665cf443e37d2d742dfb99beb3961485506cfbb6cc6a4cd6eeb82'

hash_is() {
    path=$1
    expected=$2
    [ -f "$path" ] && [ ! -L "$path" ] \
        && [ "$(/usr/bin/sha256sum "$path" | /usr/bin/cut -d ' ' -f 1)" = "$expected" ]
}

if [ "$(/usr/bin/git -C "$REPO_ROOT" branch --show-current)" != 'codex/external-rereview-remediation-20260813' ]; then
    echo 'interim package must be built from the exact repair branch' >&2
    exit 78
fi
if [ -n "$(/usr/bin/git -C "$REPO_ROOT" status --porcelain=v1 --untracked-files=all)" ]; then
    echo 'interim package source tree must be a clean exact commit' >&2
    exit 78
fi
SOURCE_COMMIT=$(/usr/bin/git -C "$REPO_ROOT" rev-parse HEAD)
if ! printf '%s' "$SOURCE_COMMIT" | /usr/bin/grep -Eq '^[0-9a-f]{40}$'; then
    echo 'invalid source commit identity' >&2
    exit 78
fi

if [ "$(/usr/bin/dpkg-query -W -f='${Status} ${Version}\n' yoko-privileged-runtime 2>/dev/null)" != 'install ok installed 2.0.0-10' ]; then
    echo 'installed Runtime package identity mismatch' >&2
    exit 78
fi
hash_is /usr/local/sbin/yoko-privileged-runtime "$PREVIOUS_RUNTIME_SHA256"
hash_is /usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py "$PREVIOUS_CORE_SHA256"
hash_is /usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py "$PREVIOUS_OBSERVER_SHA256"
hash_is /usr/local/share/yoko-privileged-runtime/policy.v2.json "$OLD_POLICY_SHA256"
hash_is /usr/local/share/yoko-privileged-runtime/install-manifest.v1.json "$PREVIOUS_INSTALL_MANIFEST_SHA256"
hash_is "$INSTALLED_PROFILE/manifest.v1.json" "$PREVIOUS_PROFILE_MANIFEST_SHA256"
if [ "$(/usr/bin/sudo -n /usr/local/sbin/yoko-privileged-runtime version | /usr/bin/python3 -I -c 'import json,sys; v=json.load(sys.stdin); assert v["ok"] is True; print(v["evidence"]["activation_profile"])')" != "$PROFILE_ID" ]; then
    echo 'installed Runtime profile identity mismatch' >&2
    exit 78
fi
if [ "$(/usr/bin/sudo -n /usr/local/sbin/yoko-privileged-runtime recovery-status \
    | /usr/bin/python3 -I -c 'import json,sys; v=json.load(sys.stdin); assert v["ok"] is True; print(v["evidence"]["identity"]["/etc/sudoers.d/92-yoko-privileged-runtime"])')" != "$PREVIOUS_SUDOERS_SHA256" ]; then
    echo 'installed Runtime sudoers identity mismatch' >&2
    exit 78
fi

for specification in \
    "profile.v1.json:0c6ba7ea34b083c2eef38255ac5c5e48eb566ec3024ac2a457bbb587a769565b" \
    "source.tar.gz:e611c0192fd3592ce99410df002a3918ce849dfab5c9c1b4955b02f136f830b9" \
    "gravity-image.docker.tar:f5693b1e7a450dc4a6323980df9a7affeb0e662cd8e11cd5a729dd09fa93854e" \
    "sealed-inputs.v1.json:0d9233005d3a9c1094819ac9a20966b3d62197cee4227b1c6e0c8a25ffc679cd" \
    "migration.sql:433b0d503f054ed6a8161a059e2650d5e401829dabe8c9d992a1d1763eef0016"; do
    name=${specification%%:*}
    identity=${specification#*:}
    hash_is "$INSTALLED_PROFILE/$name" "$identity"
done
hash_is "$INSTALLED_PROFILE_RUNTIME" 'e3a3142e6bc098a15dd62b75bf7c090a148ad64b4fe45d3d82499c2667de072f'
hash_is "$PROJECT_ROOT/src/yoko-privileged-runtime-core.py" '0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa'
hash_is "$PROJECT_ROOT/src/predecessor-observability-v1.py" 'b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084'
hash_is "$PROJECT_ROOT/src/policy.v2.base.json" "$OLD_POLICY_SHA256"
hash_is "$PROJECT_ROOT/packaging/92-yoko-privileged-runtime" '3022dcfc323706da81e760255dd1ab43f9b8662ee699aa8b58fbe6e714cc69d7'

/usr/sbin/visudo -cf "$PROJECT_ROOT/packaging/92-yoko-privileged-runtime" >/dev/null
/usr/bin/python3 -I -c 'import pathlib,sys; [compile(pathlib.Path(path).read_bytes(),path,"exec") for path in sys.argv[1:]]' \
    "$PROJECT_ROOT/src/yoko-privileged-runtime-core.py" \
    "$PROJECT_ROOT/src/predecessor-observability-v1.py"

WORK=$(/usr/bin/mktemp -d "$PROJECT_ROOT/.predecessor-observability-build.XXXXXX")
cleanup() {
    case "$WORK" in
        "$PROJECT_ROOT"/.predecessor-observability-build.*)
            /usr/bin/find "$WORK" -depth -type f -exec /usr/bin/unlink {} \;
            /usr/bin/find "$WORK" -depth -type l -exec /usr/bin/unlink {} \;
            /usr/bin/find "$WORK" -depth -type d -exec /usr/bin/rmdir {} \;
            ;;
        *) exit 1 ;;
    esac
}
trap cleanup EXIT HUP INT TERM

STAGE="$WORK/root"
PROFILE="$STAGE/usr/local/share/yoko-privileged-runtime/profiles/$PROFILE_ID"
LIBEXEC="$STAGE/usr/local/libexec/yoko-privileged-runtime"
/usr/bin/install -d -m 0755 \
    "$STAGE/DEBIAN" "$STAGE/etc/sudoers.d" "$STAGE/usr/local/sbin" \
    "$STAGE/usr/local/libexec" "$LIBEXEC" \
    "$STAGE/usr/local/share/yoko-privileged-runtime" \
    "$STAGE/usr/local/share/yoko-privileged-runtime/profiles" "$PROFILE"
/usr/bin/install -m 0644 "$PROJECT_ROOT/packaging/predecessor-observability-v1/control" "$STAGE/DEBIAN/control"
/usr/bin/install -m 0444 "$PROJECT_ROOT/src/yoko-privileged-runtime-core.py" "$LIBEXEC/core-2.0.0.py"
/usr/bin/install -m 0444 "$PROJECT_ROOT/src/predecessor-observability-v1.py" "$LIBEXEC/predecessor-observability-v1.py"
/usr/bin/install -m 0444 "$INSTALLED_PROFILE_RUNTIME" "$LIBEXEC/$PROFILE_ID.py"
/usr/bin/install -m 0444 "$PROJECT_ROOT/src/policy.v2.base.json" "$STAGE/usr/local/share/yoko-privileged-runtime/policy.v2.json"
/usr/bin/install -m 0440 "$PROJECT_ROOT/packaging/92-yoko-privileged-runtime" "$STAGE/etc/sudoers.d/92-yoko-privileged-runtime"
for name in profile.v1.json source.tar.gz gravity-image.docker.tar sealed-inputs.v1.json migration.sql; do
    /usr/bin/install -m 0444 "$INSTALLED_PROFILE/$name" "$PROFILE/$name"
done

/usr/bin/python3 -I - "$PROFILE/manifest.v1.json" "$LIBEXEC/core-2.0.0.py" "$LIBEXEC/$PROFILE_ID.py" "$PROFILE/profile.v1.json" "$PROFILE/source.tar.gz" "$PROFILE/gravity-image.docker.tar" "$PROFILE/sealed-inputs.v1.json" "$PROFILE/migration.sql" <<'PY'
import hashlib,json,pathlib,sys
destination=pathlib.Path(sys.argv[1])
files={}
for raw in sys.argv[2:]:
    path=pathlib.Path(raw)
    installed='/usr/' + str(path).split('/usr/',1)[1]
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        while chunk:=stream.read(8*1024*1024): digest.update(chunk)
    files[installed]={'sha256':digest.hexdigest(),'mode':'0444'}
value={'schema':'yoko.crm.activation-profile-install-manifest.v1','runtime_abi':'2.0.0','package_version':'2.0.0-10','profile_id':destination.parent.name,'files':files}
destination.write_text(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n',encoding='ascii')
PY
/usr/bin/chmod 0444 "$PROFILE/manifest.v1.json"
CORE_SHA256=$(/usr/bin/sha256sum "$LIBEXEC/core-2.0.0.py" | /usr/bin/cut -d ' ' -f 1)
OBSERVER_SHA256=$(/usr/bin/sha256sum "$LIBEXEC/predecessor-observability-v1.py" | /usr/bin/cut -d ' ' -f 1)
PROFILE_MANIFEST_SHA256=$(/usr/bin/sha256sum "$PROFILE/manifest.v1.json" | /usr/bin/cut -d ' ' -f 1)

/usr/bin/python3 -I - "$PROJECT_ROOT/templates/yoko-privileged-runtime.in" "$STAGE/usr/local/sbin/yoko-privileged-runtime" "$PROFILE_ID" "$CORE_SHA256" "$OBSERVER_SHA256" "$PROFILE_MANIFEST_SHA256" <<'PY'
import pathlib,sys
source,destination,profile,core,observer,manifest=sys.argv[1:]
value=pathlib.Path(source).read_text(encoding='ascii')
for key,replacement in {'PROFILE_ID':profile,'CORE_SHA256':core,'PREDECESSOR_OBSERVABILITY_SHA256':observer,'OVERLAY_MANIFEST_SHA256':manifest}.items():
    token='@'+key+'@'
    if token not in value: raise SystemExit('missing wrapper template token: '+token)
    value=value.replace(token,replacement)
if '@' in value: raise SystemExit('unresolved wrapper template token')
pathlib.Path(destination).write_text(value,encoding='ascii')
PY
/usr/bin/chmod 0755 "$STAGE/usr/local/sbin/yoko-privileged-runtime"

/usr/bin/python3 -I - "$PROJECT_ROOT/templates/postinst.in" "$STAGE/DEBIAN/postinst" "$PROFILE_ID" <<'PY'
import pathlib,sys
source,destination,profile=sys.argv[1:]
value=pathlib.Path(source).read_text(encoding='ascii').replace('@PROFILE_ID@',profile)
if '@PROFILE_ID@' in value: raise SystemExit('unresolved postinst token')
pathlib.Path(destination).write_text(value,encoding='ascii')
PY
/usr/bin/chmod 0755 "$STAGE/DEBIAN/postinst"

RUNTIME_SHA256=$(/usr/bin/sha256sum "$STAGE/usr/local/sbin/yoko-privileged-runtime" | /usr/bin/cut -d ' ' -f 1)
POLICY_SHA256=$(/usr/bin/sha256sum "$STAGE/usr/local/share/yoko-privileged-runtime/policy.v2.json" | /usr/bin/cut -d ' ' -f 1)
SUDOERS_SHA256=$(/usr/bin/sha256sum "$STAGE/etc/sudoers.d/92-yoko-privileged-runtime" | /usr/bin/cut -d ' ' -f 1)
/usr/bin/python3 -I - "$STAGE/usr/local/share/yoko-privileged-runtime/install-manifest.v1.json" "$RUNTIME_SHA256" "$CORE_SHA256" "$OBSERVER_SHA256" "$POLICY_SHA256" "$SUDOERS_SHA256" <<'PY'
import json,pathlib,sys
destination,runtime,core,observer,policy,sudoers=sys.argv[1:]
files={
 '/usr/local/sbin/yoko-privileged-runtime':{'sha256':runtime,'mode':'0755'},
 '/usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py':{'sha256':core,'mode':'0444'},
 '/usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py':{'sha256':observer,'mode':'0444'},
 '/usr/local/share/yoko-privileged-runtime/policy.v2.json':{'sha256':policy,'mode':'0444'},
 '/etc/sudoers.d/92-yoko-privileged-runtime':{'sha256':sudoers,'mode':'0440'},
}
value={'schema':'yoko.privileged-runtime.install-manifest.v1','runtime_version':'2.0.0','files':files}
pathlib.Path(destination).write_text(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n',encoding='ascii')
PY
/usr/bin/chmod 0444 "$STAGE/usr/local/share/yoko-privileged-runtime/install-manifest.v1.json"
INSTALL_MANIFEST_SHA256=$(/usr/bin/sha256sum "$STAGE/usr/local/share/yoko-privileged-runtime/install-manifest.v1.json" | /usr/bin/cut -d ' ' -f 1)

# Test-root mode resolves fixed executables inside the staged root. The stub
# validates the exact fixed argv; real visudo already validated the source
# sudoers file above. It is removed before the package data tar is built.
/usr/bin/install -d -m 0755 "$STAGE/usr/sbin"
/usr/bin/install -m 0755 "$PROJECT_ROOT/packaging/predecessor-observability-v1/test-visudo.sh" "$STAGE/usr/sbin/visudo"
/usr/bin/install -d -m 0755 "$STAGE/var" "$STAGE/var/lib"
if PYTHONDONTWRITEBYTECODE=1 YOKO_PRIVILEGED_RUNTIME_TEST_ROOT="$STAGE" "$STAGE/usr/local/sbin/yoko-privileged-runtime" self-check > "$WORK/self-check.json"; then
    :
else
    status=$?
    /usr/bin/python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1],encoding="ascii")); print(json.dumps({"ok":v.get("ok"),"errors":v.get("errors"),"warnings":v.get("warnings")},sort_keys=True),file=sys.stderr)' "$WORK/self-check.json"
    exit "$status"
fi
/usr/bin/python3 -I - "$WORK/self-check.json" <<'PY'
import json,pathlib,sys
v=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='ascii')); e=v['evidence']
if not (v['ok'] is True and e['predecessor_observability_sha256']=='b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084' and e['activation_profile_id']=='crm-08b9145945b2-gravity-source-v1'):
    raise SystemExit('staged Runtime self-check failed: '+json.dumps({'ok':v.get('ok'),'errors':v.get('errors'),'warnings':v.get('warnings'),'evidence_keys':sorted(e)},sort_keys=True))
PY
if PYTHONDONTWRITEBYTECODE=1 YOKO_PRIVILEGED_RUNTIME_TEST_ROOT="$STAGE" "$STAGE/usr/local/sbin/yoko-privileged-runtime" capabilities > "$WORK/capabilities.json"; then
    :
else
    status=$?
    /usr/bin/python3 -I -c 'import json,sys; v=json.load(open(sys.argv[1],encoding="ascii")); print(json.dumps({"ok":v.get("ok"),"errors":v.get("errors"),"warnings":v.get("warnings")},sort_keys=True),file=sys.stderr)' "$WORK/capabilities.json"
    exit "$status"
fi
/usr/bin/python3 -I - "$WORK/capabilities.json" <<'PY'
import json,pathlib,sys
v=json.loads(pathlib.Path(sys.argv[1]).read_text(encoding='ascii')); e=v['evidence']
if not (v['ok'] is True and e['enabled_read_only_profiles']==['predecessor-observe']):
    raise SystemExit('staged Runtime capabilities failed')
PY
if PYTHONDONTWRITEBYTECODE=1 YOKO_PRIVILEGED_RUNTIME_TEST_ROOT="$STAGE" "$STAGE/usr/local/sbin/yoko-privileged-runtime" predecessor-observe unexpected >/dev/null 2>&1; then
    echo 'staged Runtime accepted observation arguments' >&2
    exit 78
fi
/usr/bin/unlink "$STAGE/usr/sbin/visudo"
/usr/bin/rmdir "$STAGE/usr/sbin"
/usr/bin/rmdir "$STAGE/var/lib/yoko-privileged-runtime/audit"
/usr/bin/rmdir "$STAGE/var/lib/yoko-privileged-runtime"
/usr/bin/rmdir "$STAGE/var/lib"
/usr/bin/rmdir "$STAGE/var"
if [ -d "$LIBEXEC/__pycache__" ]; then
    /usr/bin/find "$LIBEXEC/__pycache__" -maxdepth 1 -type f -name '*.pyc' -exec /usr/bin/unlink {} \;
    /usr/bin/rmdir "$LIBEXEC/__pycache__"
fi

/usr/bin/find "$STAGE" -print0 | /usr/bin/xargs -0 /usr/bin/touch -h -d "@$EPOCH"
SOURCE_DATE_EPOCH=$EPOCH /usr/bin/dpkg-deb --root-owner-group --build -Zgzip -z9 "$STAGE" "$WORK/a.deb" >/dev/null
SOURCE_DATE_EPOCH=$EPOCH /usr/bin/dpkg-deb --root-owner-group --build -Zgzip -z9 "$STAGE" "$WORK/b.deb" >/dev/null
/usr/bin/cmp "$WORK/a.deb" "$WORK/b.deb"
if [ "$(/usr/bin/dpkg-deb -f "$WORK/a.deb" Package)" != 'yoko-privileged-runtime' ] \
    || [ "$(/usr/bin/dpkg-deb -f "$WORK/a.deb" Version)" != '2.0.0-10' ] \
    || [ "$(/usr/bin/dpkg-deb -f "$WORK/a.deb" Architecture)" != 'all' ]; then
    echo 'interim package metadata mismatch' >&2
    exit 78
fi

/usr/bin/python3 -I - "$STAGE" "$WORK/expected-data.json" <<'PY'
import hashlib,json,pathlib,stat,sys
root=pathlib.Path(sys.argv[1]); output=pathlib.Path(sys.argv[2]); records={}
for path in sorted(root.rglob('*')):
    if 'DEBIAN' in path.relative_to(root).parts or not path.is_file(): continue
    digest=hashlib.sha256()
    with path.open('rb') as stream:
        while chunk:=stream.read(8*1024*1024): digest.update(chunk)
    records['./'+path.relative_to(root).as_posix()]={'sha256':digest.hexdigest(),'mode':format(stat.S_IMODE(path.stat().st_mode),'04o')}
profile='./usr/local/share/yoko-privileged-runtime/profiles/crm-08b9145945b2-gravity-source-v1/'
allowed={
 './etc/sudoers.d/92-yoko-privileged-runtime',
 './usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py',
 './usr/local/libexec/yoko-privileged-runtime/crm-08b9145945b2-gravity-source-v1.py',
 './usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py',
 './usr/local/sbin/yoko-privileged-runtime',
 './usr/local/share/yoko-privileged-runtime/install-manifest.v1.json',
 './usr/local/share/yoko-privileged-runtime/policy.v2.json',
 *(profile+name for name in ('gravity-image.docker.tar','manifest.v1.json','migration.sql','profile.v1.json','sealed-inputs.v1.json','source.tar.gz')),
}
if set(records) != allowed: raise SystemExit('staged package data allowlist mismatch')
output.write_text(json.dumps(records,sort_keys=True,separators=(',',':'))+'\n',encoding='ascii')
PY
/usr/bin/dpkg-deb --fsys-tarfile "$WORK/a.deb" \
    | /usr/bin/python3 -I "$PROJECT_ROOT/packaging/predecessor-observability-v1/audit-data-tar.py" "$WORK/expected-data.json"

/usr/bin/install -d -m 0700 "$OUTPUT"
/usr/bin/chmod 0444 "$WORK/a.deb"
/usr/bin/mv -f "$WORK/a.deb" "$PACKAGE_PATH"
PACKAGE_SHA256=$(/usr/bin/sha256sum "$PACKAGE_PATH" | /usr/bin/cut -d ' ' -f 1)
PROFILE_RUNTIME_SHA256=$(/usr/bin/sha256sum "$LIBEXEC/$PROFILE_ID.py" | /usr/bin/cut -d ' ' -f 1)

INSTALLER="$OUTPUT/install-predecessor-observability-v1.sh"
/usr/bin/python3 -I - "$PROJECT_ROOT/packaging/predecessor-observability-v1/install-package.sh.in" "$WORK/installer" \
    "$PACKAGE_PATH" "$PACKAGE_SHA256" "$SOURCE_COMMIT" "$RUNTIME_SHA256" "$CORE_SHA256" "$OBSERVER_SHA256" "$POLICY_SHA256" "$SUDOERS_SHA256" "$INSTALL_MANIFEST_SHA256" "$PROFILE_RUNTIME_SHA256" "$PROFILE_MANIFEST_SHA256" <<'PY'
import pathlib,sys
source,destination,package_path,package_sha,commit,runtime,core,observer,policy,sudoers,install_manifest,profile_runtime,profile_manifest=sys.argv[1:]
tokens={'PACKAGE_PATH':package_path,'PACKAGE_SHA256':package_sha,'SOURCE_COMMIT':commit,'NEW_RUNTIME_SHA256':runtime,'NEW_CORE_SHA256':core,'NEW_OBSERVER_SHA256':observer,'NEW_POLICY_SHA256':policy,'NEW_SUDOERS_SHA256':sudoers,'NEW_INSTALL_MANIFEST_SHA256':install_manifest,'NEW_PROFILE_RUNTIME_SHA256':profile_runtime,'NEW_PROFILE_MANIFEST_SHA256':profile_manifest}
value=pathlib.Path(source).read_text(encoding='ascii')
for key,replacement in tokens.items():
    token='@'+key+'@'
    if token not in value: raise SystemExit('missing installer token: '+token)
    value=value.replace(token,replacement)
if any('@'+key+'@' in value for key in tokens): raise SystemExit('unresolved installer token')
pathlib.Path(destination).write_text(value,encoding='ascii')
PY
/usr/bin/chmod 0500 "$WORK/installer"
/usr/bin/mv -f "$WORK/installer" "$INSTALLER"
INSTALLER_SHA256=$(/usr/bin/sha256sum "$INSTALLER" | /usr/bin/cut -d ' ' -f 1)
OWNER_COMMAND="/usr/bin/test \"\$(/usr/bin/sha256sum '$INSTALLER' | /usr/bin/cut -d ' ' -f 1)\" = '$INSTALLER_SHA256' && /usr/bin/sudo -n /bin/sh '$INSTALLER'"

/usr/bin/python3 -I - "$WORK/package-manifest.json" "$SOURCE_COMMIT" "$PACKAGE_PATH" "$PACKAGE_SHA256" "$INSTALLER" "$INSTALLER_SHA256" "$OWNER_COMMAND" "$RUNTIME_SHA256" "$CORE_SHA256" "$OBSERVER_SHA256" "$POLICY_SHA256" "$SUDOERS_SHA256" "$INSTALL_MANIFEST_SHA256" "$PROFILE_RUNTIME_SHA256" "$PROFILE_MANIFEST_SHA256" "$ROLLBACK_DEB_SHA256" <<'PY'
import json,pathlib,sys
(destination,commit,package_path,package_sha,installer,installer_sha,command,runtime,core,observer,policy,sudoers,install_manifest,profile_runtime,profile_manifest,rollback_sha)=sys.argv[1:]
value={
 'schema':'yoko.crm.predecessor-observability-package.v1','source_commit':commit,
 'package':{'path':package_path,'sha256':package_sha,'name':'yoko-privileged-runtime','version':'2.0.0-10','architecture':'all','deterministic_double_build':True},
 'installer':{'path':installer,'sha256':installer_sha,'owner_command':command,'idempotent':True,'automatic_failure_rollback':True},
 'installed_files':{
  '/usr/local/sbin/yoko-privileged-runtime':runtime,
  '/usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py':core,
  '/usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py':observer,
  '/usr/local/share/yoko-privileged-runtime/policy.v2.json':policy,
  '/etc/sudoers.d/92-yoko-privileged-runtime':sudoers,
  '/usr/local/share/yoko-privileged-runtime/install-manifest.v1.json':install_manifest,
  '/usr/local/libexec/yoko-privileged-runtime/crm-08b9145945b2-gravity-source-v1.py':profile_runtime,
  '/usr/local/share/yoko-privileged-runtime/profiles/crm-08b9145945b2-gravity-source-v1/manifest.v1.json':profile_manifest,
 },
 'preserved_profile_artifacts':{
  'profile.v1.json':'0c6ba7ea34b083c2eef38255ac5c5e48eb566ec3024ac2a457bbb587a769565b',
  'source.tar.gz':'e611c0192fd3592ce99410df002a3918ce849dfab5c9c1b4955b02f136f830b9',
  'gravity-image.docker.tar':'f5693b1e7a450dc4a6323980df9a7affeb0e662cd8e11cd5a729dd09fa93854e',
  'sealed-inputs.v1.json':'0d9233005d3a9c1094819ac9a20966b3d62197cee4227b1c6e0c8a25ffc679cd',
  'migration.sql':'433b0d503f054ed6a8161a059e2650d5e401829dabe8c9d992a1d1763eef0016',
 },
 'privilege_delta':{'command':'/usr/local/sbin/yoko-privileged-runtime predecessor-observe','arguments':'NONE','generic_docker':False,'shell':False,'arbitrary_paths':False,'docker_socket_delegated':False,'production_mutation':False},
 'rollback':{'package_path':'/var/lib/yoko-privileged-runtime/activation-bootstraps/6865eab377dda757d101259e7321268998b45ea8b27f6003de0cf7e191a9b54e/yoko-privileged-runtime_2.0.0-10_all.deb','sha256':rollback_sha,'method':'exact prior package reinstall'},
}
pathlib.Path(destination).write_text(json.dumps(value,sort_keys=True,separators=(',',':'))+'\n',encoding='ascii')
PY
/usr/bin/chmod 0400 "$WORK/package-manifest.json"
/usr/bin/mv -f "$WORK/package-manifest.json" "$OUTPUT/package-manifest.json"
printf '%s\n' "$PACKAGE_SHA256  $PACKAGE_NAME" > "$WORK/package.sha256"
printf '%s\n' "$INSTALLER_SHA256  $(/usr/bin/basename "$INSTALLER")" > "$WORK/installer.sha256"
printf '%s\n' "$OWNER_COMMAND" > "$WORK/OWNER_COMMAND.txt"
/usr/bin/chmod 0400 "$WORK/package.sha256" "$WORK/installer.sha256" "$WORK/OWNER_COMMAND.txt"
/usr/bin/mv -f "$WORK/package.sha256" "$OUTPUT/$PACKAGE_NAME.sha256"
/usr/bin/mv -f "$WORK/installer.sha256" "$OUTPUT/install-predecessor-observability-v1.sh.sha256"
/usr/bin/mv -f "$WORK/OWNER_COMMAND.txt" "$OUTPUT/OWNER_COMMAND.txt"

printf 'PACKAGE=%s\nPACKAGE_SHA256=%s\nINSTALLER=%s\nINSTALLER_SHA256=%s\nSOURCE_COMMIT=%s\n' \
    "$PACKAGE_PATH" "$PACKAGE_SHA256" "$INSTALLER" "$INSTALLER_SHA256" "$SOURCE_COMMIT"
