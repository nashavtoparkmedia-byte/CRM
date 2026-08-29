#!/usr/bin/env python3
from pathlib import Path
import re

service = Path(__file__).resolve().parents[1] / "WhatsAppService.ts"
src = service.read_text()


def assert_match(pattern: str) -> None:
    assert re.search(pattern, src, re.S), f"missing pattern: {pattern}"


def assert_no_match(pattern: str) -> None:
    assert not re.search(pattern, src, re.S), f"forbidden pattern found: {pattern}"


def test_runtime_ready_client_is_preferred_over_db_status() -> None:
    assert_match(r"function getLiveReachabilityConnectionId\(\): string \| null")
    assert_match(r"registry\.getAllEntries\(\)\s*\.filter\(e => e\.channel === 'whatsapp' && e\.state === 'ready'\)")
    assert_match(r"const client = clients\.get\(entry\.connectionId\)\s*if \(client\?\.info\) return entry\.connectionId")
    assert_match(r"connId = getLiveReachabilityConnectionId\(\)")
    assert_match(r"DB status can lag behind runtime")


def test_provider_result_still_comes_only_from_is_registered_user() -> None:
    assert_match(r"client\.isRegisteredUser\(`\$\{digits\}@c\.us`\)")
    assert_match(r"if \(result\) \{\s*return \{ reachable: true, confirmed: true \}")
    assert_match(r"return \{ reachable: false, error: 'Номер не зарегистрирован в WhatsApp' \}")
    assert_no_match(r"return \{ reachable: true, confirmed: true \}[\s\S]{0,300}no_ready_connection")


if __name__ == "__main__":
    tests = [
        test_runtime_ready_client_is_preferred_over_db_status,
        test_provider_result_still_comes_only_from_is_registered_user,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)}/{len(tests)} PASS")
