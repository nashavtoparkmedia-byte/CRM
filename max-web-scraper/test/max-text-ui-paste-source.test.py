from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'index.js'
source = SRC.read_text(encoding='utf-8')
start = source.index('async function sendTextViaUi')
end = source.index('function waitForUiSendAck', start)
block = source[start:end]
helper_start = source.index('async function fillEditableText')
helper_end = source.index('async function sendTextViaUi', helper_start)
helper = source[helper_start:helper_end]


def test_ui_text_send_uses_fill_or_insert_text_not_keyboard_type_for_multiline_text():
    assert 'fillEditableText(composeEl, text)' in block
    assert 'page.keyboard.type(text' not in block
    assert 'navigator.clipboard.writeText' not in block


def test_fill_editable_text_has_insert_text_and_dom_event_fallback():
    assert 'page.keyboard.insertText(text)' in helper
    assert "new InputEvent('input'" in helper


def test_ui_text_send_still_sends_once_after_text_insert():
    assert "page.keyboard.press('Enter')" in block
