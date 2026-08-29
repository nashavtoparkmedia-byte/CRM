#!/usr/bin/env python3
from pathlib import Path
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


if __name__ == "__main__":
    tests = [
        test_inbound_bridge_rings_all_extensions_in_parallel,
        test_internal_profile_keeps_multiple_live_browser_contacts,
        test_deployment_sources_include_extension_103,
        test_manual_fs_config_matches_production_ring_group,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)}/{len(tests)} PASS")
