#!/usr/bin/env python3
from pathlib import Path
import re

src_root = Path(__file__).resolve().parents[4]
app_root = src_root / "app"
components = app_root / "messages" / "components"


def read(path: Path) -> str:
    return path.read_text()


def assert_match(pattern: str, text: str) -> None:
    assert re.search(pattern, text, re.S), f"missing pattern: {pattern}"


def assert_contains(needle: str, text: str) -> None:
    assert needle in text, f"missing text: {needle}"


def test_backend_exposes_canonical_summary() -> None:
    contact_route = read(app_root / "api" / "contacts" / "[id]" / "route.ts")
    message_service = read(src_root / "lib" / "MessageService.ts")
    helper = read(src_root / "lib" / "contactDisplay.ts")

    assert_contains("buildCanonicalContactSummary", contact_route)
    assert_contains("canonicalSummary", message_service)
    assert_contains("displayTitle", helper)
    assert_contains("currentMainDriverProfile", helper)
    assert_contains("providerIdentities", helper)
    assert_contains("channelCount", helper)
    assert_match(r"activeDriver\?\.fullName[\s\S]*contact\?\.displayName[\s\S]*providerName[\s\S]*primaryPhone", helper)
    assert_match(r"isTechnicalProviderName[\s\S]*MAX", helper)


def test_header_and_list_use_canonical_summary() -> None:
    header = read(components / "ChatHeader.tsx")
    chat_list = read(components / "ChatList.tsx")

    assert_contains("canonicalSummary", header)
    assert_contains("canonicalSummary", chat_list)
    assert_match(r"const title = canonicalSummary\?\.displayName \|\| detailed\.title", header)
    assert_contains("summary.primaryPhone ? `${summary.displayName} · ${summary.primaryPhone}` : summary.displayName", chat_list)


def test_profile_keeps_current_max_identity_linked() -> None:
    drawer = read(components / "ContactProfileDrawer.tsx")

    assert_contains("identityHasChat", drawer)
    assert_contains("label: 'связан'", drawer)
    assert_match(r"const allContactChannels = new Set\(contact\.identities\.map\(i => i\.channel\)\)", drawer)
    assert_match(r"new Set\(\[\.\.\.identities\.map\(i => i\.channel\), \.\.\.allContactChannels\]\)", drawer)
    assert_contains("getSegmentLabel(contact.driver.segment)", drawer)


def test_reactive_updates_refresh_contact_and_conversations() -> None:
    drawer = read(components / "ContactProfileDrawer.tsx")

    assert_match(r"setShowAddPhone\(false\); setNewPhoneInput\(''\)[\s\S]*?refetchContact\(\)[\s\S]*?refreshConversations\(\)", drawer)
    assert_match(r"method: 'DELETE'[\s\S]*?refetchContact\(\)[\s\S]*?refreshConversations\(\)", drawer)
    assert_match(r"JSON\.stringify\(\{ isPrimary: true \}\)[\s\S]*?refetchContact\(\)[\s\S]*?refreshConversations\(\)", drawer)


if __name__ == "__main__":
    tests = [
        test_backend_exposes_canonical_summary,
        test_header_and_list_use_canonical_summary,
        test_profile_keeps_current_max_identity_linked,
        test_reactive_updates_refresh_contact_and_conversations,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)}/{len(tests)} PASS")
