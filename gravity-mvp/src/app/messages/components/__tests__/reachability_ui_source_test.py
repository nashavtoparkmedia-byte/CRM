#!/usr/bin/env python3
from pathlib import Path
import re

components_dir = Path(__file__).resolve().parents[1]


def read_component(name: str) -> str:
    return (components_dir / name).read_text()


def assert_match(pattern: str, text: str) -> None:
    assert re.search(pattern, text, re.S), f"missing pattern: {pattern}"


def assert_no_match(pattern: str, text: str) -> None:
    assert not re.search(pattern, text, re.S), f"forbidden pattern found: {pattern}"


def test_contact_profile_no_connection_is_not_not_found() -> None:
    src = read_component("ContactProfileDrawer.tsx")

    assert_match(r"label: 'есть'", src)
    assert_match(r"label: 'нет'", src)
    assert_match(r"label: 'проверяем'", src)
    assert_match(r"label: 'нет связи'", src)
    assert_match(r"Канал проверен: аккаунт у провайдера не найден", src)
    assert_match(r"CRM сейчас не может проверить канал\. Это не ответ провайдера и не означает, что аккаунта нет", src)
    assert_match(r"live\?\.status === 'checking' && live\.retryable === false", src)
    assert_match(r"const reachabilityKey = \(phoneId: string, channel: string\)", src)
    assert_match(r"const runCheck = \(phoneId: string, phone: string, channel:", src)
    assert_match(r"body: JSON\.stringify\(\{ phone, channel \}\)", src)
    assert_match(r"for \(const phone of contact\.phones\)", src)
    assert_no_match(r"retryTimers", src)
    assert_no_match(r"reachable === false[\s\S]{0,120}нет связи", src)


def test_top_tabs_are_crm_presence_not_green_account_status() -> None:
    src = read_component("ChatChannelTabs.tsx")

    assert_match(r"hasCrmChannel", src)
    assert_match(r"provider-account confirmation", src)
    assert_match(r'bg-gray-300" title="канал есть в CRM"', src)
    assert_no_match(r"showGreenDot", src)
    assert_no_match(r"showRedBlocked", src)
    assert_no_match(r'title="канал активен"', src)
    assert_no_match(r'bg-emerald-500" title="канал', src)


def test_new_chat_picker_is_crm_presence_not_reachability() -> None:
    src = read_component("NewChatPopover.tsx")

    assert_match(r"Channel selection shows CRM channel presence only, not provider account reachability", src)
    assert_match(r"наличие канала в CRM", src)
    assert_match(r"Канал есть в CRM", src)
    assert_match(r"Канала пока нет в CRM", src)
    assert_match(r"Это не проверка аккаунта у провайдера", src)
    assert_no_match(r'title="аккаунт подтверждён"', src)
    assert_no_match(r'title="аккаунт не найден"', src)
    assert_no_match(r'bg-emerald-500" />подтверждён', src)


def test_new_chat_reachability_copy_has_four_states() -> None:
    src = read_component("NewChatPopover.tsx")

    assert_match(r"есть: аккаунт найден", src)
    assert_match(r"нет: \{reachability\.error \|\| 'канал проверен, аккаунт не найден'\}", src)
    assert_match(r"проверяем: проверка аккаунта еще идет", src)
    assert_match(r"нет связи: CRM сейчас не может проверить канал\. Это не значит, что аккаунта нет", src)
    assert_match(r"reachability\?\.status === 'checking' && reachability\.retryable === false", src)


if __name__ == "__main__":
    tests = [
        test_contact_profile_no_connection_is_not_not_found,
        test_top_tabs_are_crm_presence_not_green_account_status,
        test_new_chat_picker_is_crm_presence_not_reachability,
        test_new_chat_reachability_copy_has_four_states,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)}/{len(tests)} PASS")
