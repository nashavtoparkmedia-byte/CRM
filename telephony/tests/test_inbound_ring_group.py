#!/usr/bin/env python3
from pathlib import Path
import hashlib
import json
import re
import subprocess
import xml.etree.ElementTree as ET


TELEPHONY = Path(__file__).resolve().parents[1]
REPO = TELEPHONY.parent


def actions(path: Path) -> list[ET.Element]:
    root = ET.parse(path).getroot()
    return list(root.iter("action"))


def test_inbound_bridge_rings_all_extensions_in_parallel() -> None:
    dialplan = TELEPHONY / "conf/dialplan/default/02_megafon_inbound.xml"
    bridge = next(action for action in actions(dialplan) if action.get("application") == "bridge")
    dial_string = bridge.get("data", "")

    for extension in ("101", "102", "103"):
        assert f"${{sofia_contact(internal/{extension}@${{domain_name}})}}" in dial_string
    assert dial_string.count(":_:") == 2

    settings = {
        action.get("data")
        for action in actions(dialplan)
        if action.get("application") == "set"
    }
    assert "ignore_early_media=true" in settings
    assert "fail_on_single_reject=false" in settings
    assert "call_timeout=30" in settings


def test_internal_profile_keeps_multiple_live_browser_contacts() -> None:
    profile = ET.parse(TELEPHONY / "conf/sip_profiles/internal.xml").getroot()
    params = {
        param.get("name"): param.get("value")
        for param in profile.iter("param")
    }

    assert params["multiple-registrations"] == "contact"
    assert int(params["max-registrations-per-extension"]) >= 3
    assert params["tcp-unreg-on-socket-close"] == "true"
    assert params["unregister-on-options-fail"] == "true"
    assert "max-reg-count" not in params


def test_deployment_sources_include_extension_103() -> None:
    dockerfile = (TELEPHONY / "Dockerfile").read_text(encoding="utf-8")
    wsl_setup = (TELEPHONY / "wsl-setup-fs.sh").read_text(encoding="utf-8")

    assert "directory/default/103.xml" in dockerfile
    assert "directory/default/103.xml" in wsl_setup


def test_manual_fs_config_matches_production_ring_group() -> None:
    manual = REPO / "tools/fs-config/02_megafon_inbound.xml"
    bridge = next(action for action in actions(manual) if action.get("application") == "bridge")
    dial_string = bridge.get("data", "")

    assert "internal/101" in dial_string
    assert "internal/102" in dial_string
    assert "internal/103" in dial_string
    assert dial_string.count(":_:") == 2


# --- Megafon trunk credential: never committed, fails closed -----------------
# The trunk password that used to be committed here is compromised and must be
# rotated. These checks never print a credential value: assertion messages carry
# only paths and names.

TRUNK_REFERENCE = "$${megafon_password}"
TRUNK_EXEC_SET = "megafon_password=sh -c 'echo ${MEGAFON_SIP_PASSWORD}'"
GUARD_OPEN = "COPY --chmod=0755 <<'FREESWITCH_TRUNK_GUARD' /usr/local/bin/crm-freeswitch-trunk-guard"
GUARD_CLOSE = "FREESWITCH_TRUNK_GUARD"
GUARD_HANDOFF = 'exec /docker-entrypoint.sh "$@"'
VARIABLE_REFERENCE = re.compile(r"\$\$\{[A-Za-z0-9_]+\}")


def dockerfile_text() -> str:
    return (TELEPHONY / "Dockerfile").read_text(encoding="utf-8")


def trunk_guard_script() -> str:
    lines = dockerfile_text().splitlines()
    start = lines.index(GUARD_OPEN) + 1
    end = lines.index(GUARD_CLOSE, start)
    return "\n".join(lines[start:end]) + "\n"


def run_trunk_guard(password):
    script = trunk_guard_script()
    assert script.count(GUARD_HANDOFF) == 1
    env = {"PATH": "/usr/bin:/bin", "LC_ALL": "C"}
    if password is not None:
        env["MEGAFON_SIP_PASSWORD"] = password
    return subprocess.run(["sh", "-s"], input=script.replace(GUARD_HANDOFF, "exit 0"),
                          env=env, capture_output=True, text=True, timeout=10)


def test_megafon_gateway_password_is_env_backed_reference() -> None:
    megafon = TELEPHONY / "conf/sip_profiles/external/megafon.xml"
    gateway = ET.parse(megafon).getroot().find("gateway")
    passwords = [p.get("value") for p in gateway.findall("param") if p.get("name") == "password"]
    assert passwords == [TRUNK_REFERENCE], "megafon.xml gateway password must be the env-backed global"
    text = megafon.read_text(encoding="utf-8")
    assert text.count("$${") == 1, "megafon.xml must not carry $${...} tokens in comments (the preprocessor expands them)"
    assert "X-PRE-PROCESS" not in text


def test_trunk_password_global_comes_from_env_without_fallback() -> None:
    vars_xml = (TELEPHONY / "conf/vars.xml").read_text(encoding="utf-8")
    entries = re.findall(r'<X-PRE-PROCESS\s+cmd="([^"]+)"\s+data="(megafon_password=[^"]*)"', vars_xml)
    assert len(entries) == 1, "exactly one megafon_password global"
    cmd, data = entries[0]
    assert cmd == "exec-set", "megafon_password must come from the container environment"
    assert data == TRUNK_EXEC_SET, "megafon_password must read MEGAFON_SIP_PASSWORD with no fallback"


SECRET_NAME = re.compile(r"pass|secret", re.I)
# vm-password is the 3-digit voicemail PIN of an extension, not a credential for the trunk or ESL.
NON_CREDENTIAL_PARAMS = {"vm-password"}
# default_password is FreeSWITCH's stock vanilla value; no directory user or gateway uses it.
NON_CREDENTIAL_GLOBALS = {"default_password"}
# Other credentials (manager extensions, ESL) are env-backed with a placeholder fallback; the trunk
# password has no fallback, which test_trunk_password_global_comes_from_env_without_fallback pins.
ENV_EXEC_SET = re.compile(r"sh -c 'echo \$\{[A-Z][A-Z0-9_]*(:-[^}']*)?\}'")


def telephony_config_sources() -> list[Path]:
    return sorted((TELEPHONY / "conf").rglob("*.xml")) + sorted((REPO / "tools/fs-config").glob("*.xml"))


def test_telephony_config_has_no_literal_sip_passwords() -> None:
    # Parsed, so attribute order, quoting style and extra attributes cannot hide a literal.
    offenders = []
    megafon_definitions = []
    for path in telephony_config_sources():
        rel = path.relative_to(REPO)
        for element in ET.parse(path).getroot().iter():
            name = element.get("name") or ""
            if SECRET_NAME.search(name) and name not in NON_CREDENTIAL_PARAMS:
                if not VARIABLE_REFERENCE.fullmatch(element.get("value") or ""):
                    offenders.append(f"{rel} <{element.tag} name={name}>")
            if element.tag == "X-PRE-PROCESS":
                key, _, value = (element.get("data") or "").partition("=")
                if key == "megafon_password":
                    megafon_definitions.append((str(rel), element.get("cmd"), value))
                if SECRET_NAME.search(key) and key not in NON_CREDENTIAL_GLOBALS:
                    if element.get("cmd") != "exec-set" or not ENV_EXEC_SET.fullmatch(value):
                        offenders.append(f"{rel} X-PRE-PROCESS {key}")
    assert offenders == [], f"literal credentials in tracked telephony config: {offenders}"
    assert megafon_definitions == [("telephony/conf/vars.xml", "exec-set", "sh -c 'echo ${MEGAFON_SIP_PASSWORD}'")], \
        "megafon_password must be defined exactly once, from the environment"


def test_freeswitch_image_refuses_missing_or_placeholder_trunk_password() -> None:
    text = dockerfile_text()
    entrypoints = [line for line in text.splitlines() if line.startswith("ENTRYPOINT")]
    assert entrypoints == ['ENTRYPOINT ["/usr/local/bin/crm-freeswitch-trunk-guard"]']
    assert text.index(GUARD_OPEN) < text.index(entrypoints[0])
    script = trunk_guard_script()
    assert "set -x" not in script
    rejected = [None, "", "__FILL_LATER__", "__from_megafon_personal_cabinet__", "replace-with-megafon-sip-login",
                "changeme101", "short7x", "has space1", 'quo"te1234', "star*12345", "-nabcdefgh", "dollar$1234",
                "amp&12345", "lt<123456", "colon:12345", "SPIKE-REDACTED-value", "~/abcdefgh", "~abcdefgh1",
                "pct%41abcdef", "back\\slash12", "semi;colon1", "hash#123456"]
    for index, candidate in enumerate(rejected):
        result = run_trunk_guard(candidate)
        assert result.returncode == 64, f"rejected case #{index} must exit 64"
        assert result.stdout == "", f"rejected case #{index} must print nothing on stdout"
        if candidate:
            assert candidate not in result.stderr, f"rejected case #{index} must not echo the value"
    for index, candidate in enumerate(["dummyIsolated0001", "q9Zx/+Kf=Lm2@ab,c.d~e-f_g"]):
        assert run_trunk_guard(candidate).returncode == 0, f"accepted case #{index} must pass"


def test_env_example_placeholder_fails_closed() -> None:
    example = (REPO / ".env.production.example").read_text(encoding="utf-8")
    values = [line.split("=", 1)[1] for line in example.splitlines() if line.startswith("MEGAFON_SIP_PASSWORD=")]
    assert len(values) == 1
    assert run_trunk_guard(values[0]).returncode == 64, "the example placeholder must not start FreeSWITCH"


def test_production_compose_requires_trunk_password() -> None:
    compose = (REPO / "deploy/docker-compose.production.yml").read_text(encoding="utf-8")
    assert "MEGAFON_SIP_PASSWORD: ${MEGAFON_SIP_PASSWORD:?" in compose
    dev_compose = (TELEPHONY / "docker-compose.yml").read_text(encoding="utf-8")
    assert "MEGAFON_SIP_PASSWORD=${MEGAFON_SIP_PASSWORD:?" in dev_compose


def test_image_bakes_no_trunk_credential() -> None:
    offenders = [line for line in dockerfile_text().splitlines()
                 if re.match(r"\s*(ENV|ARG|LABEL)\b", line) and re.search(r"MEGAFON|megafon_password", line)]
    assert offenders == [], "the trunk credential must only reach the container at run time"


# The Megafon trunk password that was committed before this change is compromised. This check looks
# for it in every tracked text file without storing it: a 16-bit salted SHA-256 prefilter selects
# candidates and a salted scrypt digest confirms them. Messages carry paths only.
LEAK_SALT = b"yoko-crm-megafon-trunk-leak-denylist-v1"
LEAK_LENGTH = 8
LEAK_PREFILTER = "bef6"
LEAK_CONFIRM = "8151601e0964874d11b78ba978cdd98eac1c650e7eccb943f5d9e83577689cce"


def _leak_confirmed(window: bytes) -> bool:
    return hashlib.scrypt(window, salt=LEAK_SALT, n=2**15, r=8, p=1, maxmem=64 * 1024 * 1024, dklen=32).hex() == LEAK_CONFIRM


def find_compromised_trunk_password(data: bytes) -> bool:
    for match in re.finditer(rb"(?<![A-Za-z0-9])[A-Za-z0-9]{%d,%d}(?![A-Za-z0-9])" % (LEAK_LENGTH, LEAK_LENGTH + 16), data):
        run = match.group(0)
        for start in range(len(run) - LEAK_LENGTH + 1):
            window = run[start:start + LEAK_LENGTH]
            if hashlib.sha256(LEAK_SALT + window).hexdigest()[:4] == LEAK_PREFILTER and _leak_confirmed(window):
                return True
    return False


def test_compromised_trunk_password_is_in_no_tracked_file() -> None:
    listed = subprocess.run(["git", "ls-files", "-z"], cwd=REPO, capture_output=True, check=True).stdout
    offenders = []
    for raw in filter(None, listed.split(b"\0")):
        path = REPO / raw.decode("utf-8", "surrogateescape")
        if not path.is_file() or path.stat().st_size > 4_000_000:
            continue
        data = path.read_bytes()
        if b"\0" in data[:8000]:
            continue
        if find_compromised_trunk_password(data):
            offenders.append(str(path.relative_to(REPO)))
    assert offenders == [], f"the compromised trunk password is committed in: {offenders}"


# --- mod_audio_fork image: pinned, provenanced, fail closed -------------------

VENDOR = TELEPHONY / "third_party/mod_audio_fork"
ORIGINAL_CONFIG_COPIES = [
    "conf/vars.xml", "conf/sip_profiles/internal.xml", "conf/sip_profiles/external/megafon.xml",
    "conf/directory/default/101.xml", "conf/directory/default/102.xml", "conf/directory/default/103.xml",
    "conf/dialplan/default/02_megafon_inbound.xml", "conf/dialplan/default/03_user_outbound.xml",
    "conf/autoload_configs/event_socket.conf.xml", "conf/autoload_configs/acl.conf.xml",
    "conf/autoload_configs/logfile.conf.xml", "conf/dialplan/public/00_inbound_did.xml",
]


def heredoc(text: str, name: str) -> list[str]:
    lines = text.splitlines()
    start = next(i for i, line in enumerate(lines) if line.startswith("COPY <<'" + name + "'")) + 1
    return lines[start:lines.index(name, start)]


def git_blob_id(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


def dockerfile_arg(text: str, name: str) -> str:
    values = re.findall(rf'^ARG {name}="([^"]*)"$', text, re.M)
    assert len(values) == 1, f"ARG {name} must be defined exactly once with a value"
    return values[0]


def test_dockerfile_pins_images_and_preserves_telephony_config() -> None:
    text = dockerfile_text()
    assert ":latest" not in text, "release images must be pinned by digest"
    froms = [line for line in text.splitlines() if line.startswith("FROM")]
    assert froms == ["FROM ${FREESWITCH_RUNTIME} AS runtime-base", "FROM ${DEBIAN_BUILDER} AS builder",
                     "FROM ${FREESWITCH_RUNTIME} AS final"], "every stage must start from a digest-pinned ARG"
    provenance = json.loads((VENDOR / "PROVENANCE.json").read_text(encoding="utf-8"))
    for arg, recorded in (("FREESWITCH_RUNTIME", provenance["images"]["runtime"]),
                          ("DEBIAN_BUILDER", provenance["images"]["builder"])):
        base = dockerfile_arg(text, arg)
        assert re.fullmatch(r"[a-z0-9./-]+@sha256:[0-9a-f]{64}", base), f"unpinned base image arg: {arg}"
        assert base == recorded, f"ARG {arg} must equal PROVENANCE.json images"
    assert dockerfile_arg(text, "DEBIAN_SNAPSHOT") == provenance["images"]["debian_snapshot"]
    for prefix, key in (("FREESWITCH", "freeswitch_source"), ("LWS", "libwebsockets")):
        dependency = provenance["build_dependencies"][key]
        for field in ("tag", "commit", "tree"):
            assert dockerfile_arg(text, f"{prefix}_{field.upper()}") == dependency[field], f"ARG {prefix}_{field.upper()} drift"
    for relative in ORIGINAL_CONFIG_COPIES + ["conf/dialplan/default/99_audio_fork_test.xml"]:
        target = "/usr/share/freeswitch/conf/vanilla/" + relative.removeprefix("conf/")
        assert f"COPY ./{relative} {target}" in text, f"missing COPY for {relative}"
    assert '<load module="mod_audio_fork" critical="true"/>' in text
    assert "COPY --from=builder /out/mod_audio_fork.so /usr/lib/freeswitch/mod/mod_audio_fork.so" in text
    for arg in ("MOD_AUDIO_FORK_SO_SHA256", "MODULES_CONF_SHA256"):
        value = re.search(rf'^ARG {arg}="([^"]*)"', text, re.M).group(1)
        assert re.fullmatch(r"[0-9a-f]{64}", value), f"{arg} must be pinned"


FAIL_CLOSED_LINES = [
    "printf 'deb [check-valid-until=no] http://snapshot.debian.org/archive/debian/%s bookworm main\\n' \"$DEBIAN_SNAPSHOT\" > /etc/apt/sources.list; \\",
    "test \"$(git -C \"$dir\" rev-parse 'FETCH_HEAD^{commit}')\" = \"$commit\"; \\",
    "test \"$(git -C \"$dir\" rev-parse 'FETCH_HEAD^{tree}')\" = \"$tree\"; \\",
    "RUN set -eu; cd /usr/src/mod_audio_fork; sha256sum --strict -c /usr/src/mod_audio_fork.sha256",
    "patch -p1 --forward --fuzz=0 --batch < ../patches/0001-uuid_audio_fork-start-null-argv-guards.patch; \\",
    "patch -p1 --forward --fuzz=0 --batch < ../patches/0002-playAudio-require-string-audioContentType.patch; \\",
    "patch -p1 --forward --fuzz=0 --batch < ../patches/0003-refuse-runtime-unload.patch; \\",
    "sha256sum --strict -c /usr/src/mod_audio_fork.patched.sha256; \\",
    "-Wl,--no-undefined -Wl,-z,defs -Wl,-z,now -Wl,-z,relro -Wl,--exclude-libs,ALL; \\",
    "nm -D --defined-only /out/mod_audio_fork.so | grep -q ' D mod_audio_fork_module_interface$'; \\",
    "test \"$actual_so\" = \"$MOD_AUDIO_FORK_SO_SHA256\"; \\",
    "test \"$actual_needed\" = \"$MOD_AUDIO_FORK_NEEDED\"; \\",
    "test \"$actual_conf\" = \"$MODULES_CONF_SHA256\"",
    "test \"$(sha256sum /usr/lib/freeswitch/mod/mod_audio_fork.so | cut -d' ' -f1)\" = \"$MOD_AUDIO_FORK_SO_SHA256\"; \\",
    "linkage=\"$(LD_TRACE_LOADED_OBJECTS=1 LD_WARN=yes LD_BIND_NOW=yes /lib64/ld-linux-x86-64.so.2 /usr/lib/freeswitch/mod/mod_audio_fork.so 2>&1)\"; \\",
    "if printf '%s\\n' \"$linkage\" | grep -Eq 'not found|undefined symbol'; then printf '%s\\n' \"$linkage\"; exit 1; fi",
]


def test_dockerfile_keeps_every_fail_closed_check() -> None:
    lines = [line.strip() for line in dockerfile_text().splitlines()]
    missing = [index for index, required in enumerate(FAIL_CLOSED_LINES) if required not in lines]
    assert missing == [], f"fail-closed build checks removed (FAIL_CLOSED_LINES indexes): {missing}"
    text = dockerfile_text()
    assert "|| true" not in text and "|| :" not in text, "a masked exit status defeats fail-closed checks"
    compound = [line for line in text.splitlines() if line.startswith("RUN ") and (line.rstrip().endswith("\\") or ";" in line)]
    assert all(line.startswith("RUN set -eu;") for line in compound), "multi-command RUN steps must start with set -eu"


def git_tree_id(entries: dict[str, bytes]) -> str:
    body = b"".join(b"100644 " + name.encode() + b"\0" + bytes.fromhex(git_blob_id(data))
                    for name, data in sorted(entries.items(), key=lambda item: item[0].encode()))
    return hashlib.sha1(b"tree %d\0" % len(body) + body).hexdigest()


def test_vendored_module_is_the_archived_software_heritage_directory() -> None:
    provenance = json.loads((VENDOR / "PROVENANCE.json").read_text(encoding="utf-8"))
    module_files = {path.name: path.read_bytes() for path in (VENDOR / "upstream").iterdir()
                    if path.is_file() and path.name != "LICENSE.drachtio-freeswitch-modules"}
    assert len(module_files) == 12
    # External anchors, independent of the hashes recorded in this repository.
    assert git_tree_id(module_files) == "057788a171657382b245c329fd8aaa31202f5f76"
    assert provenance["upstream"]["archive"]["module_directory"] == "swh:1:dir:057788a171657382b245c329fd8aaa31202f5f76"
    root_license = (VENDOR / "upstream/LICENSE.drachtio-freeswitch-modules").read_bytes()
    assert git_blob_id(root_license) == "9b7d7fd89664ad92898b3b00bb9409932a2335a5"


def test_vendored_mod_audio_fork_matches_provenance_and_dockerfile_pins() -> None:
    provenance = json.loads((VENDOR / "PROVENANCE.json").read_text(encoding="utf-8"))
    recorded = {entry["path"]: entry["sha256"] for entry in
                provenance["files"] + provenance["patches"] + provenance["fs_sdk_stubs"]}
    actual_paths = sorted(str(p.relative_to(VENDOR)) for p in VENDOR.rglob("*")
                          if p.is_file() and p.parent != VENDOR)
    assert sorted(recorded) == actual_paths, "PROVENANCE.json must list exactly the vendored build inputs"
    for relative, digest in recorded.items():
        assert hashlib.sha256((VENDOR / relative).read_bytes()).hexdigest() == digest, f"sha256 drift: {relative}"
    for entry in provenance["files"]:
        assert git_blob_id((VENDOR / entry["path"]).read_bytes()) == entry["git_blob"], f"archived blob id drift: {entry['path']}"
    pinned = dict(reversed(line.split("  ", 1)) for line in heredoc(dockerfile_text(), "VENDORED_SHA256"))
    assert pinned == recorded, "Dockerfile VENDORED_SHA256 must equal PROVENANCE.json"
    patched = dict(reversed(line.split("  ", 1)) for line in heredoc(dockerfile_text(), "PATCHED_SHA256"))
    assert patched == provenance["patched_sha256"], "Dockerfile PATCHED_SHA256 must equal PROVENANCE.json"
    text = dockerfile_text()
    for dependency in provenance["build_dependencies"].values():
        assert f'"{dependency["commit"]}"' in text and f'"{dependency["tree"]}"' in text


if __name__ == "__main__":
    tests = [
        test_inbound_bridge_rings_all_extensions_in_parallel,
        test_internal_profile_keeps_multiple_live_browser_contacts,
        test_deployment_sources_include_extension_103,
        test_manual_fs_config_matches_production_ring_group,
        test_megafon_gateway_password_is_env_backed_reference,
        test_trunk_password_global_comes_from_env_without_fallback,
        test_telephony_config_has_no_literal_sip_passwords,
        test_freeswitch_image_refuses_missing_or_placeholder_trunk_password,
        test_env_example_placeholder_fails_closed,
        test_production_compose_requires_trunk_password,
        test_image_bakes_no_trunk_credential,
        test_compromised_trunk_password_is_in_no_tracked_file,
        test_dockerfile_pins_images_and_preserves_telephony_config,
        test_dockerfile_keeps_every_fail_closed_check,
        test_vendored_module_is_the_archived_software_heritage_directory,
        test_vendored_mod_audio_fork_matches_provenance_and_dockerfile_pins,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)}/{len(tests)} PASS")
