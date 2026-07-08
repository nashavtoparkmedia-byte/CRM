from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'index.js'
source = SRC.read_text(encoding='utf-8')


def test_known_chats_writer_is_shared():
    assert 'function rememberKnownChatId(chatId)' in source
    assert "path.join(__dirname, 'known_chats.json')" in source
    assert '!known.map(String).includes(normalized)' in source


def test_incoming_uses_shared_known_chat_writer():
    assert '// Запоминаем chatId для catch-up при рестарте\n  rememberKnownChatId(payload.chatId)' in source


def test_successful_outbound_adds_chat_to_restart_catchup():
    assert 'rememberKnownChatId(returnChatId)' in source
    assert 'if (uiChatId) rememberKnownChatId(uiChatId)' in source


def test_dom_recovery_adds_chat_to_restart_catchup():
    assert 'rememberKnownChatId(chatId)\n  const result = await forwardToWebhook({' in source
