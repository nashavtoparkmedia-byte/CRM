from pathlib import Path


INDEX = (Path(__file__).resolve().parents[1] / "index.js").read_text(encoding="utf-8")


def test_mapped_protocol_dialog_resolves_to_its_browser_route():
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


def test_no_one_time_backfill_is_pinned_to_a_specific_customer_chat():
    # A startup backfill that hard-codes one live chat id embeds production data in
    # the source tree; recovery must stay driven by runtime state instead.
    assert "startup_mapped_history_recovery" not in INDEX
    assert "MAPPED_DOM_HISTORY_RECOVERY_FLAG" not in INDEX
