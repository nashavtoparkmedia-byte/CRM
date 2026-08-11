from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
DRIVER_MATCH = ROOT / "src/lib/DriverMatchService.ts"
YANDEX_LINK = ROOT / "src/lib/contacts/yandex-link.ts"
MONITORING_SYNC = ROOT / "src/app/api/monitoring/sync/route.ts"


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def test_driver_match_has_explicit_three_state_result():
    source = read(DRIVER_MATCH)
    assert "export type DriverMatchResult" in source
    assert "status: 'not_found'" in source
    assert "status: 'matched'" in source
    assert "status: 'ambiguous'" in source


def test_driver_match_phone_query_does_not_pick_limit_one():
    source = read(DRIVER_MATCH)
    phone_section = source.split("Phone search:", 1)[1].split("// 3. Name is diagnostic-only", 1)[0]
    assert "LIMIT 1" not in phone_section
    assert "uniqueById.length === 1" in phone_section
    assert "uniqueById.length > 1" in phone_section
    assert "phone_multiple_drivers" in phone_section


def test_driver_match_name_is_diagnostic_only():
    source = read(DRIVER_MATCH)
    name_section = source.split("// 3. Name is diagnostic-only", 1)[1].split("console.log(`[DriverMatch] NO MATCH", 1)[0]
    assert "// 3. Name is diagnostic-only" in source
    assert "driver_match_name_candidates_diagnostic" in name_section
    assert "return { status: 'matched'" not in name_section
    assert "return exactMatch" not in name_section
    assert "return drivers[0]" not in name_section


def test_link_chat_to_driver_only_delegates_a_matched_link_to_messaging_owner():
    source = read(DRIVER_MATCH)
    link_section = source.split("static async linkChatToDriver", 1)[1]
    assert "if (result.status === 'matched')" in link_section
    assert "linkMatchedDriver({ chatId, driverId: result.driver.id })" in link_section
    assert "MatchedDriverChatLinkCapability" in source
    assert "@/contracts/messaging/v1" not in source
    assert "@/modules/messaging/public/v1" not in source
    assert "prisma.chat" not in link_section
    assert "if (result.status === 'ambiguous')" in link_section
    assert "return false" in link_section
    assert "driver_match_existing_chat_link_conflict" in link_section


def test_yandex_link_ambiguous_does_not_write_contact_driver():
    source = read(YANDEX_LINK)
    ambiguous_section = source.split("if (drivers.length > 1)", 1)[1].split("const matched = drivers[0]", 1)[0]
    assert "action: 'ambiguous'" in ambiguous_section
    assert "logAmbiguousYandexLink" in ambiguous_section
    assert "prisma.contact.update" not in ambiguous_section
    assert "contact_driver_existing_link_conflict" in source
    conflict_section = source.split("contact_driver_existing_link_conflict", 1)[1].split("// 4. Связываем", 1)[0]
    assert "prisma.contact.update" not in conflict_section


def test_yandex_link_no_best_driver_auto_choice_remains():
    source = read(YANDEX_LINK)
    assert "const best = drivers[0]" not in source
    assert "action: wasLinked ? 'switched' : 'linked'" not in source
    assert "drivers.sort(" not in source


def test_yandex_link_contact_phone_owner_query_is_not_find_first():
    source = read(YANDEX_LINK)
    owner_section = source.split("// 2. Find all active phone owners", 1)[1].split("if (drivers.length > 1)", 1)[0]
    assert "contactPhone.findMany" in owner_section
    assert "contactPhone.findFirst" not in owner_section
    assert "contactPhonesByContactId.size === 0" in owner_section
    assert "contactPhonesByContactId.size > 1" in owner_section
    assert "contact_phone_owner_ambiguous" in source
    assert "isArchived" in owner_section


def test_monitoring_sync_existing_contact_checks_other_phone_owners_before_attach():
    source = read(MONITORING_SYNC)
    scenario1 = source.split("Contact already linked to this yandexDriverId", 1)[1].split("No Contact by yandexDriverId", 1)[0]
    assert "findActivePhoneOwners(normalizedE164)" in scenario1
    assert "owner.contactId !== existing.id" in scenario1
    assert "ambiguous_phone_owner" in scenario1
    assert "monitoring_sync_contact_phone_owner_conflict" in scenario1
    conflict_section = scenario1.split("if (otherOwners.length > 0)", 1)[1].split("if (currentYandexPhone", 1)[0]
    assert "prisma.contactPhone.create" not in conflict_section
    assert "prisma.contact.update" not in conflict_section

if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_"):
            fn()
    print("driver_matching_safety_source_test.py: PASS")
