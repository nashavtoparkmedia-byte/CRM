#!/usr/bin/env python3
from pathlib import Path
import bz2
import gzip
import hashlib
import io
import json
import lzma
import re
import subprocess
import tarfile
import xml.etree.ElementTree as ET
import zipfile


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


PREPROCESS_TAG = re.compile(r"<X-PRE-PROCESS\b([^>]*)>", re.I)
PREPROCESS_COMMENT = re.compile(r"<!--#\s*([A-Za-z-]+)\s+\"?([^=\s\"]+)=([^\"]*?)\"?\s*-->")
ATTRIBUTE = re.compile(r"([A-Za-z][\w-]*)\s*=\s*(?:\"([^\"]*)\"|'([^']*)')")


def test_raw_preprocessor_directives_define_no_literal_credential() -> None:
    # FreeSWITCH's preprocessor works on raw lines, so directives inside XML comments and the
    # <!--#set name=value--> form still run; ElementTree cannot see either.
    offenders = []
    megafon = []
    for path in telephony_config_sources():
        rel = str(path.relative_to(REPO))
        text = path.read_text(encoding="utf-8")
        directives = []
        for match in PREPROCESS_TAG.finditer(text):
            attributes = {key.lower(): double if double is not None and double != "" or single == "" else single
                          for key, double, single in ATTRIBUTE.findall(match.group(1))}
            key, _, value = (attributes.get("data") or "").partition("=")
            directives.append((attributes.get("cmd"), key, value))
        for match in PREPROCESS_COMMENT.finditer(text):
            directives.append((match.group(1).lower(), match.group(2), match.group(3)))
        for cmd, key, value in directives:
            if key.lower() == "megafon_password":
                megafon.append((rel, cmd, value))
            if SECRET_NAME.search(key) and key not in NON_CREDENTIAL_GLOBALS:
                if cmd != "exec-set" or not ENV_EXEC_SET.fullmatch(value):
                    offenders.append(f"{rel} {cmd} {key}")
    assert offenders == [], f"preprocessor directives with literal credentials: {offenders}"
    assert megafon == [("telephony/conf/vars.xml", "exec-set", "sh -c 'echo ${MEGAFON_SIP_PASSWORD}'")], \
        "megafon_password must be defined exactly once across every preprocessor form"


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


# Frozen, digest-sealed owner-bootstrap evidence recorded before this change. Their source snapshots and
# packages embed telephony/conf/vars.xml and megafon.xml with the compromised value. They are listed by
# exact digest so that any other carrier, or any change to one of these, fails the check. Removing them
# is an Owner decision; rotating the password is what makes them harmless.
SEALED_COMPROMISED_CARRIERS = {
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-7aea2823-gravity-outbox-recovery-v1/bundle/payload/yoko-privileged-runtime_2.0.0-7_all.deb": "ababe50bcb0d3597786b1c77118867b1d700a5629bb2719892ce5ae4927a4738",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-7aea2823-gravity-outbox-recovery-v1/bundle/payload/yoko-privileged-runtime_2.0.0-8_all.deb": "c342889473f29d37cab47a8b6a88f21aa165d646a910b65dcee9b1a0a62d0289",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-7aea2823-gravity-outbox-recovery-v1/dist/yoko-crm-activation-recovery-7aea2823-v3.tar": "b9a5d5f250e9d2a96ef4199200f1f6db52bdbe5fb9c23d74c45d2cce4bc63df7",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-7aea2823-gravity-outbox-recovery-v1/dist/yoko-privileged-runtime_2.0.0-8_all.deb": "c342889473f29d37cab47a8b6a88f21aa165d646a910b65dcee9b1a0a62d0289",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-7aea2823-gravity-outbox-recovery-v1/inputs/source.tar.gz": "be616b7d528bc111717d237bcd745a8b106302897e702be4b8af1b8643cba26d",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-7aea2823-gravity-outbox-recovery-v1/inputs/yoko-privileged-runtime_2.0.0-7_all.deb": "ababe50bcb0d3597786b1c77118867b1d700a5629bb2719892ce5ae4927a4738",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-7aea2823-gravity-outbox-stabilization-v2/bundle/payload/yoko-privileged-runtime_2.0.0-8_all.deb": "c342889473f29d37cab47a8b6a88f21aa165d646a910b65dcee9b1a0a62d0289",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-7aea2823-gravity-outbox-stabilization-v2/bundle/payload/yoko-privileged-runtime_2.0.0-9_all.deb": "0c259741b4b58992acb830806e42db79ec87730f1b568a21e2879483d739be83",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-7aea2823-gravity-outbox-stabilization-v2/dist/yoko-crm-activation-stabilization-7aea2823-v4.tar": "c7823d66ebabc57df7da4bb54c40ee8d78a05964cb7ac7f63bcf04941f7fc048",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-7aea2823-gravity-outbox-stabilization-v2/dist/yoko-privileged-runtime_2.0.0-9_all.deb": "0c259741b4b58992acb830806e42db79ec87730f1b568a21e2879483d739be83",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-7aea2823-gravity-outbox-stabilization-v2/inputs/source.tar.gz": "be616b7d528bc111717d237bcd745a8b106302897e702be4b8af1b8643cba26d",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-7aea2823-gravity-outbox-stabilization-v2/inputs/yoko-privileged-runtime_2.0.0-8_all.deb": "c342889473f29d37cab47a8b6a88f21aa165d646a910b65dcee9b1a0a62d0289",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-af9646f5-gravity-outbox-v1-ledger-reconciliation/bundle/payload/yoko-privileged-runtime_2.0.0-6_all.deb": "597f58d813f7a0f3631b9d1778588db880c00e7df97d92a51cef385f8f4d8ba0",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-af9646f5-gravity-outbox-v1-ledger-reconciliation/bundle/payload/yoko-privileged-runtime_2.0.0-7_all.deb": "ababe50bcb0d3597786b1c77118867b1d700a5629bb2719892ce5ae4927a4738",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-af9646f5-gravity-outbox-v1-ledger-reconciliation/dist/yoko-crm-ledger-reconciliation-bootstrap-af9646f5-v2.tar": "db571de22ad7fe9110bd339992c4caec58598b311c547b9543bd560db5dcc29d",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-af9646f5-gravity-outbox-v1-ledger-reconciliation/dist/yoko-privileged-runtime_2.0.0-7_all.deb": "ababe50bcb0d3597786b1c77118867b1d700a5629bb2719892ce5ae4927a4738",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-af9646f5-gravity-outbox-v1-ledger-reconciliation/inputs/source.tar.gz": "c43d6e6ea0735b7a5dad9117822df24b7ec0133685c69b8c13b50effc7c9f808",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-af9646f5-gravity-outbox-v1-ledger-reconciliation/inputs/yoko-privileged-runtime_2.0.0-6_all.deb": "597f58d813f7a0f3631b9d1778588db880c00e7df97d92a51cef385f8f4d8ba0",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-af9646f5-gravity-outbox-v1/bundle/payload/yoko-privileged-runtime_2.0.0-6_all.deb": "597f58d813f7a0f3631b9d1778588db880c00e7df97d92a51cef385f8f4d8ba0",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-af9646f5-gravity-outbox-v1/dist/yoko-crm-activation-bootstrap-af9646f5-v1.tar": "88a30f4fdf74c1f86d47f47c31edec824a887c172a69585c45eddceb85fb755e",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-af9646f5-gravity-outbox-v1/dist/yoko-privileged-runtime_2.0.0-6_all.deb": "597f58d813f7a0f3631b9d1778588db880c00e7df97d92a51cef385f8f4d8ba0",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-af9646f5-gravity-outbox-v1/evidence/rejected-d4c91a5e/yoko-crm-activation-bootstrap-af9646f5-v1.REJECTED.d4c91a5e.tar": "d4c91a5ee2d05850b6e1d6360e9ac2d359ce7c428391d3246f0a037132bf081d",
    "architecture/recovery/control-plane/v2/owner-bootstrap/crm-af9646f5-gravity-outbox-v1/inputs/source.tar.gz": "c43d6e6ea0735b7a5dad9117822df24b7ec0133685c69b8c13b50effc7c9f808",
}
ARCHIVE_MEMBER_LIMIT = 256 * 1024 * 1024


def _expanded(data: bytes) -> bytes | None:
    for magic, decompress in ((b"\x1f\x8b", gzip.decompress), (b"\xfd7zXZ", lzma.decompress), (b"BZh", bz2.decompress)):
        if data.startswith(magic):
            try:
                return decompress(data)
            except Exception:
                return None
    return None


def _members(data: bytes):
    if data.startswith(b"!<arch>\n"):
        offset = 8
        while offset + 60 <= len(data):
            size = int(data[offset + 48:offset + 58].decode("ascii", "replace").strip() or 0)
            yield data[offset + 60:offset + 60 + size]
            offset += 60 + size + (size % 2)
    elif len(data) > 512 and data[257:262] == b"ustar":
        with tarfile.open(fileobj=io.BytesIO(data), mode="r:") as archive:
            for member in archive.getmembers():
                if member.isfile() and member.size <= ARCHIVE_MEMBER_LIMIT:
                    yield archive.extractfile(member).read()
    elif data.startswith(b"PK\x03\x04"):
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for name in archive.namelist():
                if archive.getinfo(name).file_size <= ARCHIVE_MEMBER_LIMIT:
                    yield archive.read(name)


def carries_compromised_trunk_password(data: bytes, depth: int = 0) -> bool:
    if find_compromised_trunk_password(data):
        return True
    if depth >= 4:
        return False
    expanded = _expanded(data)
    if expanded is not None:
        return carries_compromised_trunk_password(expanded, depth + 1)
    try:
        return any(carries_compromised_trunk_password(member, depth + 1) for member in _members(data))
    except (tarfile.TarError, zipfile.BadZipFile, ValueError):
        return False


def test_compromised_trunk_password_is_in_no_tracked_file() -> None:
    # Every tracked file is scanned, binaries included, and archives (gzip, xz, bzip2, tar, zip, deb)
    # are opened recursively.
    listed = subprocess.run(["git", "ls-files", "-z"], cwd=REPO, capture_output=True, check=True).stdout
    offenders = []
    for raw in filter(None, listed.split(b"\0")):
        relative = raw.decode("utf-8", "surrogateescape")
        path = REPO / relative
        if not path.is_file():
            continue
        data = path.read_bytes()
        if SEALED_COMPROMISED_CARRIERS.get(relative) == hashlib.sha256(data).hexdigest():
            continue
        if carries_compromised_trunk_password(data):
            offenders.append(relative)
    assert offenders == [], f"the compromised trunk password is committed in: {offenders}"


def test_sealed_carriers_are_exactly_the_known_evidence() -> None:
    for relative, digest in SEALED_COMPROMISED_CARRIERS.items():
        path = REPO / relative
        if path.is_file():
            assert hashlib.sha256(path.read_bytes()).hexdigest() == digest, f"sealed evidence changed: {relative}"


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
    assert not re.search(r"\|\|\s*(true|:|exit\s+0)\b|\bset\s+\+e\b|\bexit\s+0\b", text), "a masked exit status defeats fail-closed checks"
    compound = [line for line in text.splitlines() if line.startswith("RUN ") and (line.rstrip().endswith("\\") or ";" in line)]
    assert all(line.startswith("RUN set -eu;") for line in compound), "multi-command RUN steps must start with set -eu"
    position = {required: lines.index(required) for required in FAIL_CLOSED_LINES}
    order = [lines.index("COPY ./third_party/mod_audio_fork/fs-sdk/ /usr/src/mod_audio_fork/fs-sdk/"),
             position[FAIL_CLOSED_LINES[3]], position[FAIL_CLOSED_LINES[4]], position[FAIL_CLOSED_LINES[7]],
             position[FAIL_CLOSED_LINES[10]], position[FAIL_CLOSED_LINES[12]]]
    assert order == sorted(order), "vendored sources must be verified before patching, compiling and pinning the module"
    assert lines.index("FROM ${FREESWITCH_RUNTIME} AS final") < position[FAIL_CLOSED_LINES[14]], "the linkage gate must run in the final image"


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
        test_raw_preprocessor_directives_define_no_literal_credential,
        test_freeswitch_image_refuses_missing_or_placeholder_trunk_password,
        test_env_example_placeholder_fails_closed,
        test_production_compose_requires_trunk_password,
        test_image_bakes_no_trunk_credential,
        test_compromised_trunk_password_is_in_no_tracked_file,
        test_sealed_carriers_are_exactly_the_known_evidence,
        test_dockerfile_pins_images_and_preserves_telephony_config,
        test_dockerfile_keeps_every_fail_closed_check,
        test_vendored_module_is_the_archived_software_heritage_directory,
        test_vendored_mod_audio_fork_matches_provenance_and_dockerfile_pins,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)}/{len(tests)} PASS")
