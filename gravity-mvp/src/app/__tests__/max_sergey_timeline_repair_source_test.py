from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
MIGRATION = ROOT / "prisma/migrations/20260806181500_repair_max_sergey_mirror_timeline/migration.sql"
SQL = MIGRATION.read_text(encoding="utf-8")


def test_real_provider_message_is_preserved_and_only_synthetic_duplicate_is_deleted():
    assert "d3019fd76b933767aa" not in SQL
    assert "DELETE FROM \"Message\"" in SQL
    assert "max-dom-902136564252-5f3b71b101734a85" in SQL


def test_recovered_messages_receive_original_chronology():
    assert SQL.count('UPDATE "Message" SET "sentAt"') == 8
    assert "2026-08-05 13:06:00+00" in SQL
    assert "2026-08-06 14:12:30+00" in SQL
    assert "lastMessageAt" in SQL


if __name__ == "__main__":
    tests = [
        test_real_provider_message_is_preserved_and_only_synthetic_duplicate_is_deleted,
        test_recovered_messages_receive_original_chronology,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)}/{len(tests)} PASS")
