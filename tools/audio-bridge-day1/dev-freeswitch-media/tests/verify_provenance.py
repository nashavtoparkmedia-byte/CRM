from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]
CHECKS = 0


def check(condition: bool, message: str) -> None:
    global CHECKS
    CHECKS += 1
    if not condition:
        raise AssertionError(message)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def main() -> int:
    dockerfile = (ROOT / "Dockerfile.dev").read_text(encoding="utf-8")
    provenance = json.loads((ROOT / "provenance.json").read_text(encoding="utf-8"))
    checksums = (ROOT / "checksums.sha256").read_text(encoding="utf-8")
    modules = (ROOT / "config/autoload_configs/modules.conf.xml").read_text(encoding="utf-8")
    event_socket = (
        ROOT / "config/autoload_configs/event_socket.conf.xml"
    ).read_text(encoding="utf-8")
    dialplan = (ROOT / "config/dialplan/default.xml").read_text(encoding="utf-8")
    notice = (ROOT / "legal/NOTICE.txt").read_text(encoding="utf-8")
    license_text = (ROOT / "legal/AGPL-3.0.txt").read_text(encoding="utf-8")

    check(":latest" not in dockerfile, "mutable latest tag is forbidden")
    check("CMAKE_SKIP_RPATH=ON" in dockerfile, "module must not retain build RUNPATH")
    check(
        "safarov/freeswitch@sha256:b31c743f" in dockerfile,
        "runtime base must be pinned by digest",
    )
    check(
        "debian@sha256:63a496b5" in dockerfile,
        "builder base must be pinned by digest",
    )
    check(
        provenance["runtime"]["freeswitch_revision"]
        == "a88d069d6ffb74df797bcaf001f7e63181c07a09",
        "FreeSWITCH revision mismatch",
    )
    check(
        provenance["sources"][1]["commit"]
        == "a25fb1fe530ec6a612d321ff04f70be69b1a257c",
        "module revision mismatch",
    )
    check(
        provenance["sources"][0]["archive_sha256"]
        == "ca4932f5d5fb76040901df1eaba3c2d5fb71a500d81549c70f78a8f47c410094",
        "FreeSWITCH source checksum mismatch",
    )
    check(
        provenance["sources"][1]["archive_sha256"]
        == "32aa5649c92b6795659cbbc2f53cd3a2d90337e807ce45c366ca7c81a0cf6f46",
        "module source checksum mismatch",
    )
    provenance_hash = sha256(ROOT / "provenance.json")
    check(f"{provenance_hash}  provenance.json" in checksums, "provenance hash missing")
    check(
        f'ARG PROVENANCE_SHA256="{provenance_hash}"' in dockerfile,
        "provenance label argument mismatch",
    )
    check("AGPL-3.0-only" in dockerfile, "OCI license label missing")
    check("GNU AFFERO GENERAL PUBLIC LICENSE" in license_text, "full AGPL text missing")
    check("external distribution" in notice, "distribution restriction missing")
    check('<load module="mod_audio_stream"/>' in modules, "media module not loaded")
    check("mod_sofia" not in modules, "SIP module must not be loaded")
    check("mod_verto" not in modules, "external signaling module must not be loaded")
    check('listen-ip" value="127.0.0.1"' in event_socket, "ESL must be loopback-only")
    check("gateway" not in dialplan.lower(), "gateway must not be configured")
    check("STREAM_PLAYBACK=true" in dialplan, "playback mode must be explicit")
    check("RECORD_STEREO=true" in dialplan, "stereo proof recording must be enabled")
    check("tone_stream://%(6000,0,200)" in dialplan, "write-media clock is required")
    check(
        provenance["module_capability"]["playback_buffer_limit_seconds"] == 30,
        "playback queue bound must be documented",
    )
    check(
        provenance["module_capability"]["websocket_outbound_queue_max_frames"] == 1024,
        "WebSocket queue bound must be documented",
    )
    check(
        provenance["security"]["contains_production_credentials"] is False,
        "production credential declaration must be false",
    )
    check(
        provenance["security"]["contains_upstream_vanilla_configuration"] is False,
        "upstream vanilla configuration declaration must be false",
    )
    check(
        "RUN rm -rf -- /usr/share/freeswitch/conf/vanilla" in dockerfile,
        "upstream vanilla configuration must be removed",
    )
    check(
        'ENTRYPOINT ["/usr/bin/freeswitch"]' in dockerfile,
        "safe FreeSWITCH entrypoint must be explicit",
    )
    check(
        '"/usr/share/freeswitch/conf/yoko-media-dev"' in dockerfile,
        "default config must be the isolated DEV config",
    )
    check(
        provenance["security"]["default_configuration"]
        == "/usr/share/freeswitch/conf/yoko-media-dev",
        "default config provenance mismatch",
    )

    prohibited = re.compile(
        r"(DATABASE_URL|OPENAI_API_KEY|YANDEX_API_KEY|MEGAFON|155\.212\.130\.14|/opt/crm)",
        re.IGNORECASE,
    )
    scanned_files = [
        path
        for path in ROOT.rglob("*")
        if path.is_file()
        and path.name not in {"sbom.spdx.in-toto.json", "verify_provenance.py"}
    ]
    findings = [
        str(path.relative_to(ROOT))
        for path in scanned_files
        if prohibited.search(path.read_text(encoding="utf-8", errors="ignore"))
    ]
    check(not findings, f"prohibited production material found: {findings}")

    print(f"YOKO_PROVENANCE_TESTS PASS {CHECKS}/{CHECKS}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
