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


def test_telephony_config_has_no_literal_sip_passwords() -> None:
    offenders = []
    sources = sorted((TELEPHONY / "conf").rglob("*.xml")) + sorted((REPO / "tools/fs-config").glob("*.xml"))
    for path in sources:
        text = path.read_text(encoding="utf-8")
        rel = path.relative_to(REPO)
        for value in re.findall(r'<param\s+name="password"\s+value="([^"]*)"', text):
            if not VARIABLE_REFERENCE.fullmatch(value):
                offenders.append(f"{rel} param password")
        for cmd, key in re.findall(r'<X-PRE-PROCESS\s+cmd="([^"]+)"\s+data="([A-Za-z0-9_]*password[A-Za-z0-9_]*)=', text, re.I):
            if key != "default_password" and cmd != "exec-set":
                offenders.append(f"{rel} X-PRE-PROCESS {key}")
    assert offenders == [], f"literal SIP credentials in tracked telephony config: {offenders}"


def test_freeswitch_image_refuses_missing_or_placeholder_trunk_password() -> None:
    text = dockerfile_text()
    entrypoints = [line for line in text.splitlines() if line.startswith("ENTRYPOINT")]
    assert entrypoints == ['ENTRYPOINT ["/usr/local/bin/crm-freeswitch-trunk-guard"]']
    assert text.index(GUARD_OPEN) < text.index(entrypoints[0])
    script = trunk_guard_script()
    assert "set -x" not in script
    rejected = [None, "", "__FILL_LATER__", "__from_megafon_personal_cabinet__", "replace-with-megafon-sip-login",
                "changeme101", "short7x", "has space1", 'quo"te1234', "star*12345", "-nabcdefgh", "dollar$1234",
                "amp&12345", "lt<123456", "colon:12345", "SPIKE-REDACTED-value"]
    for index, candidate in enumerate(rejected):
        result = run_trunk_guard(candidate)
        assert result.returncode == 64, f"rejected case #{index} must exit 64"
        assert result.stdout == "", f"rejected case #{index} must print nothing on stdout"
        if candidate:
            assert candidate not in result.stderr, f"rejected case #{index} must not echo the value"
    for index, candidate in enumerate(["dummyIsolated0001", "q9Zx/+Kf=Lm2@a%b,c.d~e-f_g"]):
        assert run_trunk_guard(candidate).returncode == 0, f"accepted case #{index} must pass"


def test_env_example_placeholder_fails_closed() -> None:
    example = (REPO / ".env.production.example").read_text(encoding="utf-8")
    values = [line.split("=", 1)[1] for line in example.splitlines() if line.startswith("MEGAFON_SIP_PASSWORD=")]
    assert len(values) == 1
    assert run_trunk_guard(values[0]).returncode == 64, "the example placeholder must not start FreeSWITCH"


def test_production_compose_requires_trunk_password() -> None:
    compose = (REPO / "deploy/docker-compose.production.yml").read_text(encoding="utf-8")
    assert "MEGAFON_SIP_PASSWORD: ${MEGAFON_SIP_PASSWORD:?" in compose


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


def test_dockerfile_pins_images_and_preserves_telephony_config() -> None:
    text = dockerfile_text()
    assert ":latest" not in text, "release images must be pinned by digest"
    for base in re.findall(r'^ARG (?:FREESWITCH_RUNTIME|DEBIAN_BUILDER)="([^"]+)"', text, re.M):
        assert re.fullmatch(r"[a-z0-9./-]+@sha256:[0-9a-f]{64}", base), f"unpinned base image arg: {base.split('@')[0]}"
    for relative in ORIGINAL_CONFIG_COPIES + ["conf/dialplan/default/99_audio_fork_test.xml"]:
        target = "/usr/share/freeswitch/conf/vanilla/" + relative.removeprefix("conf/")
        assert f"COPY ./{relative} {target}" in text, f"missing COPY for {relative}"
    assert '<load module="mod_audio_fork" critical="true"/>' in text
    assert "COPY --from=builder /out/mod_audio_fork.so /usr/lib/freeswitch/mod/mod_audio_fork.so" in text
    for arg in ("MOD_AUDIO_FORK_SO_SHA256", "MODULES_CONF_SHA256"):
        value = re.search(rf'^ARG {arg}="([^"]*)"', text, re.M).group(1)
        assert re.fullmatch(r"[0-9a-f]{64}", value), f"{arg} must be pinned"


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
        test_dockerfile_pins_images_and_preserves_telephony_config,
        test_vendored_mod_audio_fork_matches_provenance_and_dockerfile_pins,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)}/{len(tests)} PASS")
