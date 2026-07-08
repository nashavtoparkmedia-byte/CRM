from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'index.js'
source = SRC.read_text(encoding='utf-8')
ui_start = source.index('async function sendTextViaUi')
ui_end = source.index('function waitForUiSendAck', ui_start)
ui_block = source[ui_start:ui_end]


def test_ui_send_sets_and_clears_in_progress_flag_with_finally():
    assert 'uiSendInProgress = true' in ui_block
    assert 'finally {\n    uiSendInProgress = false\n  }' in ui_block


def test_dom_fallback_skips_while_ui_send_in_progress():
    assert "if (uiSendInProgress) return { skipped: 'ui_send_in_progress' }" in source
    assert 'if (uiSendInProgress) return\n    const chatId = latestRecentOp128ChatId()' in source
    assert "if (uiSendInProgress) return\n            forwardRecentDomMessages(chatIdStr, 'empty_op71_after_op128')" in source
