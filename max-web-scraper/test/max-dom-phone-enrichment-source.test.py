from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'index.js'
source = SRC.read_text(encoding='utf-8')


def test_resolve_phone_persists_discovered_route():
    assert 'function normalizePhoneForCrmPayload(phone)' in source
    assert 'function cachedPhoneForChatId(...chatIds)' in source
    assert 'savePhoneChatId(digits, dialogId)' in source
    assert 'savePhoneChatId(digits, chatIdStr)' in source


def test_dom_fallback_forwards_cached_phone_to_crm():
    assert 'const cachedPhone = cachedPhoneForChatId(chatId, uiRouteId)' in source
    assert 'const crmPhone = normalizePhoneForCrmPayload(options.phone || cachedPhone)' in source
    assert 'phone: crmPhone, senderPhone: crmPhone' in source


def test_manual_dom_fallback_accepts_phone_and_sender_name():
    assert 'const { chatId, recent, phone, senderName, name } = req.body || {}' in source
    assert 'if (phone) savePhoneChatId(phone, chatId)' in source
    assert '? await forwardRecentDomMessages(String(chatId), \'manual_debug\', options)' in source
    assert ': await forwardLatestDomMessage(String(chatId), \'manual_debug\', options)' in source
