#!/usr/bin/env python3
from pathlib import Path
import re


SRC = Path(__file__).resolve().parents[3]


def read(relative: str) -> str:
    return (SRC / relative).read_text(encoding="utf-8")


def test_browser_softphone_recovers_and_each_tab_has_its_own_contact() -> None:
    context = read("lib/sip/SipContext.tsx")
    popup = read("components/sip/IncomingCallPopup.tsx")
    toolbar = read("components/sip/CallToolbar.tsx")

    assert "reconnect(): Promise<void>" in context
    assert "scheduleReconnect" in context
    assert re.search(r"ua\.start\(\).*?_uaStarting = false", context, re.S)
    assert "window.addEventListener('focus', ensureRegistered)" in context
    assert "crm_user_id=([^;]*)" in context
    assert "sessionStorage.getItem(key)" in context
    assert "localStorage.getItem(key)" not in context
    assert "Подключить рабочее место" in popup
    assert "void reconnect()" in popup
    assert "status !== 'registered'" in toolbar


if __name__ == "__main__":
    test_browser_softphone_recovers_and_each_tab_has_its_own_contact()
    print("PASS test_browser_softphone_recovers_and_each_tab_has_its_own_contact")
    print("1/1 PASS")
