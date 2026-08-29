#!/bin/bash
set -Eeuo pipefail
umask 077

readonly PROFILE_ID='@PROFILE_ID@'
readonly EXPECTED_HOST='jvxthcorvm'
EXPECTED_DIR=$(/bin/pwd -P)
readonly EXPECTED_DIR
readonly NEW_DEB='yoko-privileged-runtime_2.0.0-14_all.deb'
readonly MIN_PRE_DPKG_FREE_BYTES='5368709120'
readonly OLD_DEB='yoko-privileged-runtime_2.0.0-13_all.deb'
readonly OLD_DEB_SHA='db5a91ea3192c541defa00fe432904357ff9d900be6dc8e13a5a024dddc1fa48'
readonly OLD_PROFILE_ID='crm-d4575d20f91e-gravity-source-v1'
readonly OLD_RUNTIME_SHA='4b9a661bba3d6575a7ab2a8c05964cc02fcc51f075328e2a864a409dcd1735eb'
readonly OLD_CORE_SHA='0f97bafbfe5b430fa7994119b1fc76fead4bdbee26766c730d9e399551ebdffa'
readonly OLD_OBSERVER_SHA='b5ea36c50e12b0fe6c171896258ddfc00a9d2666778735cae6a9b2a8df6d4084'
readonly OLD_PROFILE_RUNTIME_SHA='71322ca7b67b21ef1073ee7b521f7637b7d9a5a7ac0ce0d0485f1201432b6d76'
readonly OLD_PROFILE_MANIFEST_SHA='42b946b9a16126123726d80c71a7eb07f8d6345a464448fc40968cb55dc4f2ff'
readonly OLD_POLICY_SHA='8727373b0c6ec79c9abf82f1aaaa58abc2bae67e96aa96a602ac419f308db0e0'
readonly OLD_INSTALL_MANIFEST_SHA='8595d63f569d7367ae69647db8c2eabc19bb7beb6b214c7c5f73650bd6c55bd6'
readonly EXPECTED_AUDIT_RECORDS='43'
readonly EXPECTED_AUDIT_DIGEST='7d00ca9a0081858f1137939298e71ace33a36c6d436984f478284ccc6a1b3d9e'
readonly OLD_SUDOERS_SHA='3022dcfc323706da81e760255dd1ab43f9b8662ee699aa8b58fbe6e714cc69d7'
readonly OLD_REGISTRY_SHA='8ea5c3b7113e1dd2ad5a74b82a1fb0bf56643fd59774dccf37e8aa9eb67bd057'
readonly BOOTSTRAP_STORE='/var/lib/yoko-privileged-runtime/activation-bootstraps'
readonly OLD_DEB_SOURCE="$EXPECTED_DIR/$OLD_DEB"
readonly OLD_DEB_STORE="$BOOTSTRAP_STORE/$OLD_DEB_SHA"
readonly OLD_DEB_STORED="$OLD_DEB_STORE/$OLD_DEB"
readonly INSTALL_LOG='/var/lib/yoko-privileged-runtime/activation-bootstrap-install.log'
readonly BOOTSTRAP_GUARD='/var/lib/yoko-privileged-runtime/activation-bootstrap-installing.v1'

new_attempted=0
rollback_ok=false
guard_owned=0
previous_tmp=''

marker_failed() {
    printf '%s\n' "{\"schema\":\"yoko.crm.owner-bootstrap-result.v1\",\"ok\":false,\"marker\":\"YOKO_ACTIVATION_BOOTSTRAP_FAILED\",\"rollback_restored\":$rollback_ok,\"production_mutation\":false}"
    printf '%s\n' 'YOKO_ACTIVATION_BOOTSTRAP_FAILED'
}

old_identity() {
    test "$(/usr/bin/dpkg-query -W -f='${db:Status-Abbrev} ${Version}' yoko-privileged-runtime 2>/dev/null)" = 'ii  2.0.0-13' || return 1
    test "$(/usr/bin/sha256sum /usr/local/sbin/yoko-privileged-runtime | /usr/bin/cut -d ' ' -f 1)" = "$OLD_RUNTIME_SHA" || return 1
    test "$(/usr/bin/sha256sum /usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py | /usr/bin/cut -d ' ' -f 1)" = "$OLD_CORE_SHA" || return 1
    test "$(/usr/bin/sha256sum /usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py | /usr/bin/cut -d ' ' -f 1)" = "$OLD_OBSERVER_SHA" || return 1
    test "$(/usr/bin/sha256sum "/usr/local/libexec/yoko-privileged-runtime/$OLD_PROFILE_ID.py" | /usr/bin/cut -d ' ' -f 1)" = "$OLD_PROFILE_RUNTIME_SHA" || return 1
    test "$(/usr/bin/sha256sum "/usr/local/share/yoko-privileged-runtime/profiles/$OLD_PROFILE_ID/manifest.v1.json" | /usr/bin/cut -d ' ' -f 1)" = "$OLD_PROFILE_MANIFEST_SHA" || return 1
    test "$(/usr/bin/sha256sum /usr/local/share/yoko-privileged-runtime/policy.v2.json | /usr/bin/cut -d ' ' -f 1)" = "$OLD_POLICY_SHA" || return 1
    test "$(/usr/bin/sha256sum /usr/local/share/yoko-privileged-runtime/install-manifest.v1.json | /usr/bin/cut -d ' ' -f 1)" = "$OLD_INSTALL_MANIFEST_SHA" || return 1
    test "$(/usr/bin/sha256sum /etc/sudoers.d/92-yoko-privileged-runtime | /usr/bin/cut -d ' ' -f 1)" = "$OLD_SUDOERS_SHA" || return 1
    self_check=$(/usr/sbin/runuser -u codexbot -- /usr/bin/sudo -n /usr/local/sbin/yoko-privileged-runtime self-check) || return 1
    /usr/bin/python3 -I -c 'import json,sys; v=json.load(sys.stdin); e=v.get("evidence",{}); expected_installed={"/etc/sudoers.d/92-yoko-privileged-runtime":sys.argv[8],"/usr/local/libexec/yoko-privileged-runtime/core-2.0.0.py":sys.argv[3],"/usr/local/libexec/yoko-privileged-runtime/predecessor-observability-v1.py":sys.argv[4],"/usr/local/sbin/yoko-privileged-runtime":sys.argv[2],"/usr/local/share/yoko-privileged-runtime/policy.v2.json":sys.argv[7]}; valid=v.get("ok") is True and e.get("runtime_version")=="2.0.0" and e.get("package_version")=="2.0.0-13" and e.get("activation_profile_id")==sys.argv[1] and e.get("profile_argument_shape")=="ZERO_ARGUMENT_ONLY" and e.get("activation_profile_manifest_sha256")==sys.argv[6] and e.get("predecessor_observability_sha256")==sys.argv[4] and e.get("registry_sha256")==sys.argv[9] and e.get("installed_identity")==expected_installed and e.get("generic_command_execution") is False and e.get("arbitrary_paths") is False and e.get("docker_socket_delegated") is False; raise SystemExit(0 if valid else 1)' "$OLD_PROFILE_ID" "$OLD_RUNTIME_SHA" "$OLD_CORE_SHA" "$OLD_OBSERVER_SHA" "$OLD_PROFILE_RUNTIME_SHA" "$OLD_PROFILE_MANIFEST_SHA" "$OLD_POLICY_SHA" "$OLD_SUDOERS_SHA" "$OLD_REGISTRY_SHA" <<<"$self_check" || return 1
    capabilities_exact "$OLD_PROFILE_ID" || return 1
}

capabilities_exact() {
    expected_profile=$1
    capabilities=$(/usr/sbin/runuser -u codexbot -- /usr/bin/sudo -n /usr/local/sbin/yoko-privileged-runtime capabilities) || return 1
    /usr/bin/python3 -I -c 'import json,sys; v=json.load(sys.stdin); e=v.get("evidence",{}); resources=e.get("resources",{}); valid=v.get("ok") is True and e.get("activation_profile_id")==sys.argv[1] and e.get("enabled_activation_profiles")==["database-status","release-preflight","release-activate","rollback"] and e.get("enabled_read_only_profiles")==["predecessor-observe"] and set(e.get("disabled_profiles",[]))=={"config-activation","database-migration"} and e.get("generic_command_execution") is False and e.get("arbitrary_paths") is False and e.get("arbitrary_package_install") is False and isinstance(resources,dict) and all(isinstance(r,dict) and "service-restart" not in r.get("operations",[]) for r in resources.values()); raise SystemExit(0 if valid else 1)' "$expected_profile" <<<"$capabilities" || return 1
}

new_identity() {
    test "$(/usr/bin/dpkg-query -W -f='${db:Status-Abbrev} ${Version}' yoko-privileged-runtime 2>/dev/null)" = 'ii  2.0.0-14' || return 1
    self_check=$(/usr/sbin/runuser -u codexbot -- /usr/bin/sudo -n /usr/local/sbin/yoko-privileged-runtime self-check) || return 1
    /usr/bin/python3 -I -c 'import json,sys; v=json.load(sys.stdin); e=v.get("evidence",{}); raise SystemExit(0 if v.get("ok") is True and e.get("package_version")=="2.0.0-14" and e.get("activation_profile_id")==sys.argv[1] and e.get("profile_argument_shape")=="ZERO_ARGUMENT_ONLY" else 1)' "$PROFILE_ID" <<<"$self_check" || return 1
    capabilities_exact "$PROFILE_ID" || return 1
}

audit_exact() {
    audit=$(/usr/sbin/runuser -u codexbot -- /usr/bin/sudo -n /usr/local/sbin/yoko-privileged-runtime audit-status) || return 1
    /usr/bin/python3 -I -c 'import json,sys; v=json.load(sys.stdin); e=v.get("evidence",{}); raise SystemExit(0 if v.get("ok") is True and e.get("state")=="VALID" and e.get("record_count")==int(sys.argv[2]) and e.get("last_digest")==sys.argv[1] else 1)' "$EXPECTED_AUDIT_DIGEST" "$EXPECTED_AUDIT_RECORDS" <<<"$audit" || return 1
}

provenance_identity() {
    /usr/bin/python3 -I -c '
import hashlib,json,re,sys
v=json.load(sys.stdin)
expected=[]
if not isinstance(v,dict) or v.get("ok") is not True or not isinstance(v.get("evidence"),dict): raise SystemExit("provenance envelope")
e=v["evidence"]
if e.get("complete") is not True or e.get("failures")!=expected: raise SystemExit("provenance failure set drift")
records=e.get("records")
semantic=e.get("semantic")
if not isinstance(records,list) or not isinstance(semantic,dict) or semantic.get("schema")!="yoko.ai-calls.production-semantic-identity.v1" or not isinstance(semantic.get("records"),list) or not re.fullmatch(r"[0-9a-f]{64}",str(semantic.get("fingerprint_sha256",""))): raise SystemExit("provenance shape")
names=[]
for record in records:
    if not isinstance(record,dict) or not isinstance(record.get("semantic"),dict): raise SystemExit("provenance record shape")
    name=record.get("name")
    if not isinstance(name,str) or not name or not re.fullmatch(r"[A-Za-z0-9_.-]{1,256}",name): raise SystemExit("provenance name")
    if not re.fullmatch(r"[0-9a-f]{64}",str(record.get("container_id",""))) or not re.fullmatch(r"sha256:[0-9a-f]{64}",str(record.get("image_id",""))): raise SystemExit("provenance identity")
    if not isinstance(record.get("status"),str) or not isinstance(record.get("started_at"),str) or isinstance(record.get("restart_count"),bool) or not isinstance(record.get("restart_count"),int) or record["restart_count"]<0: raise SystemExit("provenance runtime shape")
    if record["semantic"].get("name")!=name or record["semantic"].get("image_id")!=record["image_id"]: raise SystemExit("provenance semantic cross-bind")
    names.append(name)
if len(names)!=len(set(names)): raise SystemExit("provenance duplicate record")
expected_semantic=sorted((record["semantic"] for record in records),key=lambda item:item["name"])
if semantic["records"]!=expected_semantic: raise SystemExit("provenance semantic record drift")
canonical=lambda value:json.dumps(value,separators=(",",":"),sort_keys=True).encode("ascii")
semantic_sha256=hashlib.sha256(canonical({"records":expected_semantic,"schema":"yoko.ai-calls.production-semantic-identity.v1"})).hexdigest()
if semantic["fingerprint_sha256"]!=semantic_sha256: raise SystemExit("provenance semantic fingerprint drift")
runtime=sorted((record["name"],record["container_id"],record["image_id"],record["status"],record["started_at"],record["restart_count"]) for record in records)
identity={"failures_sha256":hashlib.sha256(canonical(expected)).hexdigest(),"semantic_sha256":semantic_sha256,"containers_sha256":hashlib.sha256(canonical(runtime)).hexdigest()}
print(json.dumps(identity,separators=(",",":"),sort_keys=True))
'
}

rollback_previous() {
    /usr/bin/dpkg --install "$OLD_DEB_STORED" >>"$INSTALL_LOG" 2>&1 || return 1
    old_identity || return 1
    audit_exact || return 1
    old_store_exact || return 1
    restored=$(/usr/sbin/runuser -u codexbot -- /usr/bin/sudo -n /usr/local/sbin/yoko-privileged-runtime docker-provenance) || return 1
    restored_provenance_identity=$(provenance_identity <<<"$restored") || return 1
    test -n "$pre_provenance_identity" || return 1
    test "$restored_provenance_identity" = "$pre_provenance_identity" || return 1
}

guard_exact() {
    test -f "$BOOTSTRAP_GUARD" || return 1
    test ! -L "$BOOTSTRAP_GUARD" || return 1
    test "$(/usr/bin/stat -c '%u:%g:%a:%h:%s' "$BOOTSTRAP_GUARD")" = '0:0:400:1:0' || return 1
}

clear_guard() {
    if [ "$guard_owned" -eq 1 ]; then
        guard_exact || return 1
        /usr/bin/unlink "$BOOTSTRAP_GUARD" || return 1
        guard_owned=0
    fi
}

cleanup_previous_tmp() {
    if [ -n "$previous_tmp" ] && [ -e "$previous_tmp" ]; then
        [[ "$previous_tmp" =~ ^/var/lib/yoko-privileged-runtime/activation-bootstraps/\.previous-[0-9a-f]{64}\.[A-Za-z0-9]{8}$ ]] || return 1
        test -d "$previous_tmp" || return 1
        test ! -L "$previous_tmp" || return 1
        unexpected=$(/usr/bin/find "$previous_tmp" -mindepth 1 -maxdepth 1 ! -name "$OLD_DEB" -print -quit)
        test -z "$unexpected" || return 1
        if [ -e "$previous_tmp/$OLD_DEB" ]; then
            test -f "$previous_tmp/$OLD_DEB" || return 1
            test ! -L "$previous_tmp/$OLD_DEB" || return 1
            /usr/bin/unlink "$previous_tmp/$OLD_DEB" || return 1
        fi
        /usr/bin/rmdir "$previous_tmp" || return 1
    fi
    previous_tmp=''
}

on_exit() {
    rc=$?
    trap - EXIT
    if [ "$rc" -ne 0 ]; then
        cleanup_previous_tmp || true
        if [ "$new_attempted" -eq 1 ]; then
            if rollback_previous; then
                rollback_ok=true
                clear_guard || rollback_ok=false
            fi
        fi
        marker_failed
    fi
    exit "$rc"
}
trap on_exit EXIT

test "$#" -eq 0
test "$(/usr/bin/id -u)" = '0'
test "$(/usr/bin/id -ru)" = '0'
[[ "$EXPECTED_DIR" =~ ^/root/yoko-crm-bootstrap-stage\.[A-Za-z0-9]{6,}/payload$ ]]
test "$(/usr/bin/readlink -f -- "$0")" = "$EXPECTED_DIR/install.sh"
test "$(/bin/hostname)" = "$EXPECTED_HOST"

/usr/bin/python3 -I - "$EXPECTED_DIR" "$PROFILE_ID" <<'PY'
import hashlib,json,os,pathlib,stat,sys
root=pathlib.Path(sys.argv[1])
expected={"install.sh":0o500,"payload-manifest.json":0o400,"yoko-privileged-runtime_2.0.0-14_all.deb":0o400,"yoko-privileged-runtime_2.0.0-13_all.deb":0o400,"review/human-manifest.md":0o400,"review/package-manifest.json":0o400,"review/installation-procedure.md":0o400,"review/rollback-analysis.md":0o400}
observed={str(item.relative_to(root)) for item in root.rglob('*') if item.is_file()}
observed_dirs={str(item.relative_to(root)) for item in root.rglob('*') if item.is_dir()}
if observed != set(expected) or observed_dirs != {"review"}: raise SystemExit('payload file set mismatch')
review=(root/'review').lstat()
if (root/'review').is_symlink() or not stat.S_ISDIR(review.st_mode) or review.st_uid!=0 or review.st_gid!=0 or stat.S_IMODE(review.st_mode)!=0o500: raise SystemExit('unsafe payload directory')
manifest=json.loads((root/'payload-manifest.json').read_text(encoding='ascii'))
if set(manifest)!={"schema","profile_id","new_package","previous_package","files"}: raise SystemExit('manifest keys')
if manifest["schema"]!='yoko.crm.owner-bootstrap-payload.v1' or manifest["profile_id"]!=sys.argv[2]: raise SystemExit('manifest identity')
if manifest["new_package"]!={"name":"yoko-privileged-runtime","version":"2.0.0-14","architecture":"all"}: raise SystemExit('manifest successor identity')
if manifest["previous_package"]!={"name":"yoko-privileged-runtime","version":"2.0.0-13","profile_id":"crm-d4575d20f91e-gravity-source-v1","source_commit":"d4575d20f91e0029fdcce9669b42478bd8e34e1f","sha256":"db5a91ea3192c541defa00fe432904357ff9d900be6dc8e13a5a024dddc1fa48","payload_path":"yoko-privileged-runtime_2.0.0-13_all.deb","store_path":"/var/lib/yoko-privileged-runtime/activation-bootstraps/db5a91ea3192c541defa00fe432904357ff9d900be6dc8e13a5a024dddc1fa48/yoko-privileged-runtime_2.0.0-13_all.deb"}: raise SystemExit('manifest predecessor identity')
if set(manifest["files"]) != set(expected)-{"payload-manifest.json"}: raise SystemExit('manifest files')
for name,mode in expected.items():
    path=root/name
    value=path.lstat()
    if path.is_symlink() or not stat.S_ISREG(value.st_mode) or value.st_uid!=0 or value.st_gid!=0 or stat.S_IMODE(value.st_mode)!=mode or value.st_nlink!=1: raise SystemExit('unsafe payload file')
    if name in manifest["files"]:
        digest=hashlib.sha256(path.read_bytes()).hexdigest()
        if digest != manifest["files"][name]["sha256"] or manifest["files"][name]["mode"] != format(mode,'04o'): raise SystemExit('payload digest mismatch')
PY

test "$(/usr/bin/dpkg-deb -f "$EXPECTED_DIR/$NEW_DEB" Package)" = 'yoko-privileged-runtime'
test "$(/usr/bin/dpkg-deb -f "$EXPECTED_DIR/$NEW_DEB" Version)" = '2.0.0-14'
test "$(/usr/bin/dpkg-deb -f "$EXPECTED_DIR/$NEW_DEB" Architecture)" = 'all'
test -f "$OLD_DEB_SOURCE"
test ! -L "$OLD_DEB_SOURCE"
test "$(/usr/bin/stat -c '%u:%g:%a:%h' "$OLD_DEB_SOURCE")" = '0:0:400:1'
test "$(/usr/bin/sha256sum "$OLD_DEB_SOURCE" | /usr/bin/cut -d ' ' -f 1)" = "$OLD_DEB_SHA"
test "$(/usr/bin/dpkg-deb -f "$OLD_DEB_SOURCE" Package)" = 'yoko-privileged-runtime'
test "$(/usr/bin/dpkg-deb -f "$OLD_DEB_SOURCE" Version)" = '2.0.0-13'
test "$(/usr/bin/dpkg-deb -f "$OLD_DEB_SOURCE" Architecture)" = 'all'

installed_version=$(/usr/bin/dpkg-query -W -f='${Version}' yoko-privileged-runtime 2>/dev/null || true)
new_sha=$(/usr/bin/sha256sum "$EXPECTED_DIR/$NEW_DEB" | /usr/bin/cut -d ' ' -f 1)
test "$new_sha" != "$OLD_DEB_SHA"
store="$BOOTSTRAP_STORE/$new_sha"
store_present=0
if [ -e "$BOOTSTRAP_STORE" ]; then
    test -d "$BOOTSTRAP_STORE"
    test ! -L "$BOOTSTRAP_STORE"
    test "$(/usr/bin/stat -c '%u:%g:%a' "$BOOTSTRAP_STORE")" = '0:0:700'
fi
if [ -e "$store" ]; then
    test -d "$store"
    test ! -L "$store"
    test "$(/usr/bin/stat -c '%u:%g:%a' "$store")" = '0:0:700'
    unexpected=$(/usr/bin/find "$store" -mindepth 1 -maxdepth 1 ! -name "$NEW_DEB" -print -quit)
    test -z "$unexpected"
    store_present=1
fi

stored_file_exact() {
    name=$1
    expected_sha=$2
    path="$store/$name"
    test -f "$path" || return 1
    test ! -L "$path" || return 1
    test "$(/usr/bin/stat -c '%u:%g:%a:%h' "$path")" = '0:0:400:1' || return 1
    test "$(/usr/bin/sha256sum "$path" | /usr/bin/cut -d ' ' -f 1)" = "$expected_sha" || return 1
}

old_store_exact() {
    test -d "$OLD_DEB_STORE" || return 1
    test ! -L "$OLD_DEB_STORE" || return 1
    test "$(/usr/bin/stat -c '%u:%g:%a' "$OLD_DEB_STORE")" = '0:0:700' || return 1
    test -z "$(/usr/bin/find "$OLD_DEB_STORE" -mindepth 1 -maxdepth 1 ! -name "$OLD_DEB" -print -quit)" || return 1
    test -f "$OLD_DEB_STORED" || return 1
    test ! -L "$OLD_DEB_STORED" || return 1
    test "$(/usr/bin/stat -c '%u:%g:%a:%h' "$OLD_DEB_STORED")" = '0:0:400:1' || return 1
    test "$(/usr/bin/sha256sum "$OLD_DEB_STORED" | /usr/bin/cut -d ' ' -f 1)" = "$OLD_DEB_SHA" || return 1
}

if [ "$installed_version" != '2.0.0-13' ] && [ "$installed_version" != '2.0.0-14' ]; then
    exit 1
fi
if new_identity; then
    if audit_exact && [ "$store_present" -eq 1 ] \
        && stored_file_exact "$NEW_DEB" "$new_sha" \
        && old_store_exact; then
        if [ -e "$BOOTSTRAP_GUARD" ]; then
            guard_exact
            guard_owned=1
            clear_guard
        fi
        trap - EXIT
        printf '%s\n' "{\"schema\":\"yoko.crm.owner-bootstrap-result.v1\",\"ok\":true,\"marker\":\"YOKO_ACTIVATION_BOOTSTRAP_OK\",\"status\":\"ALREADY_INSTALLED\",\"package_version\":\"2.0.0-14\",\"runtime_abi\":\"2.0.0\",\"profile_id\":\"$PROFILE_ID\",\"rollback_available\":true,\"production_mutation\":false}"
        printf '%s\n' 'YOKO_ACTIVATION_BOOTSTRAP_OK'
        exit 0
    fi
    # A valid successor whose audit/store changed after installation is not a
    # bootstrap retry. Never mutate it on a repeated one-time call.
    exit 1
fi
old_identity

pre=$(/usr/sbin/runuser -u codexbot -- /usr/bin/sudo -n /usr/local/sbin/yoko-privileged-runtime docker-provenance)
pre_provenance_identity=$(provenance_identity <<<"$pre")
audit_before=$(/usr/sbin/runuser -u codexbot -- /usr/bin/sudo -n /usr/local/sbin/yoko-privileged-runtime audit-status)
/usr/bin/python3 -I -c 'import json,sys; v=json.load(sys.stdin); e=v.get("evidence",{}); raise SystemExit(0 if v.get("ok") is True and e.get("state")=="VALID" and e.get("record_count")==int(sys.argv[2]) and e.get("last_digest")==sys.argv[1] else 1)' "$EXPECTED_AUDIT_DIGEST" "$EXPECTED_AUDIT_RECORDS" <<<"$audit_before"

/usr/bin/install -d -o root -g root -m 0700 "$BOOTSTRAP_STORE"
if [ -e "$OLD_DEB_STORE" ]; then
    old_store_exact
else
    previous_tmp=$(/usr/bin/mktemp -d "$BOOTSTRAP_STORE/.previous-$OLD_DEB_SHA.XXXXXXXX")
    /usr/bin/chmod 0700 "$previous_tmp"
    /usr/bin/install -o root -g root -m 0400 "$OLD_DEB_SOURCE" "$previous_tmp/$OLD_DEB"
    test "$(/usr/bin/sha256sum "$previous_tmp/$OLD_DEB" | /usr/bin/cut -d ' ' -f 1)" = "$OLD_DEB_SHA"
    /usr/bin/mv -T "$previous_tmp" "$OLD_DEB_STORE"
    previous_tmp=''
fi
old_store_exact
if [ "$store_present" -eq 0 ]; then
    /usr/bin/install -d -o root -g root -m 0700 "$store"
fi

reconcile_stored_file() {
    name=$1
    expected_sha=$2
    source=${3:-"$EXPECTED_DIR/$name"}
    path="$store/$name"
    if [ -e "$path" ]; then
        test -f "$path"
        test ! -L "$path"
        test "$(/usr/bin/stat -c '%u:%g:%a:%h' "$path")" = '0:0:400:1'
        if ! stored_file_exact "$name" "$expected_sha"; then
            /usr/bin/unlink "$path"
        fi
    fi
    if [ ! -e "$path" ]; then
        /usr/bin/install -o root -g root -m 0400 "$source" "$path"
    fi
    stored_file_exact "$name" "$expected_sha"
}

reconcile_stored_file "$NEW_DEB" "$new_sha"

available_blocks=$(/usr/bin/stat -f -c '%a' /)
available_block_size=$(/usr/bin/stat -f -c '%S' /)
available_bytes=$((available_blocks * available_block_size))
test "$available_bytes" -ge "$MIN_PRE_DPKG_FREE_BYTES"

/usr/bin/install -o root -g root -m 0600 /dev/null "$INSTALL_LOG"
/usr/bin/install -d -o root -g root -m 0700 /var/lib/yoko-privileged-runtime
if [ -e "$BOOTSTRAP_GUARD" ]; then
    guard_exact
else
    /usr/bin/install -o root -g root -m 0400 /dev/null "$BOOTSTRAP_GUARD"
fi
guard_owned=1
new_attempted=1
/usr/bin/dpkg --install "$store/$NEW_DEB" >>"$INSTALL_LOG" 2>&1

new_identity
audit_exact

post=$(/usr/sbin/runuser -u codexbot -- /usr/bin/sudo -n /usr/local/sbin/yoko-privileged-runtime docker-provenance)
post_provenance_identity=$(provenance_identity <<<"$post")
test "$pre_provenance_identity" = "$post_provenance_identity"
audit_after=$(/usr/sbin/runuser -u codexbot -- /usr/bin/sudo -n /usr/local/sbin/yoko-privileged-runtime audit-status)
/usr/bin/python3 -I -c 'import json,sys; v=json.load(sys.stdin); e=v.get("evidence",{}); raise SystemExit(0 if v.get("ok") is True and e.get("state")=="VALID" and e.get("record_count")==int(sys.argv[2]) and e.get("last_digest")==sys.argv[1] else 1)' "$EXPECTED_AUDIT_DIGEST" "$EXPECTED_AUDIT_RECORDS" <<<"$audit_after"

clear_guard
new_attempted=0
trap - EXIT
printf '%s\n' "{\"schema\":\"yoko.crm.owner-bootstrap-result.v1\",\"ok\":true,\"marker\":\"YOKO_ACTIVATION_BOOTSTRAP_OK\",\"status\":\"INSTALLED\",\"package_version\":\"2.0.0-14\",\"runtime_abi\":\"2.0.0\",\"profile_id\":\"$PROFILE_ID\",\"package_sha256\":\"$new_sha\",\"rollback_available\":true,\"production_mutation\":false}"
printf '%s\n' 'YOKO_ACTIVATION_BOOTSTRAP_OK'
