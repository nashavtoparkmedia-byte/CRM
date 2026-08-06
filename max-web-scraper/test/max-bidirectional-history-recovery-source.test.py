from pathlib import Path


INDEX = (Path(__file__).resolve().parents[1] / "index.js").read_text(encoding="utf-8")


def test_sergey_protocol_dialog_maps_to_browser_route():
    assert "'902136564252': '193432092'" in INDEX


def test_recent_bidirectional_history_is_recovered_once_per_persistent_session():
    assert "BIDIRECTIONAL_HISTORY_RECOVERY_FLAG = path.join(USER_DATA_DIR" in INDEX
    assert "async function runOneTimeBidirectionalHistoryRecovery()" in INDEX
    assert "initialSync.runIfNeeded('last_n_days', { sinceTs })" in INDEX
    assert "Date.now() - 7 * 24 * 60 * 60 * 1000" in INDEX
    assert "async function runBidirectionalHistoryRecoverySafely()" in INDEX
    assert INDEX.count("await runBidirectionalHistoryRecoverySafely()") == 2


def test_live_dom_recovery_includes_messages_sent_from_max_web():
    recovery = INDEX.split("function scheduleAutomaticDomMirrorRecovery(", 1)[1].split(
        "function cleanDomMessageText(", 1
    )[0]
    assert "includeOutgoing: true" in recovery


def test_mapped_dialog_recovers_visible_history_in_both_directions():
    assert "MAPPED_DOM_HISTORY_RECOVERY_FLAG = path.join(USER_DATA_DIR" in INDEX
    assert "forwardRecentDomMessages(chatId, 'startup_mapped_history_recovery'" in INDEX
    assert "includeOutgoing: true" in INDEX
    assert "includeOutgoingMedia: true" in INDEX
    assert INDEX.count("await runMappedDomHistoryRecoverySafely()") == 2


if __name__ == "__main__":
    tests = [
        test_sergey_protocol_dialog_maps_to_browser_route,
        test_recent_bidirectional_history_is_recovered_once_per_persistent_session,
        test_live_dom_recovery_includes_messages_sent_from_max_web,
        test_mapped_dialog_recovers_visible_history_in_both_directions,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)}/{len(tests)} PASS")
