from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'index.js'
source = SRC.read_text(encoding='utf-8')


def test_ui_text_success_without_provider_id_is_delivered():
    assert "function uiTextDeliveredResult(source = 'ui_text_no_provider_id')" in source
    assert "return uiTextDeliveredResult('ui_fallback_no_provider_id')" in source
    assert "return uiTextDeliveredResult('direct_ui_no_provider_id')" in source


def test_ui_text_success_without_provider_id_does_not_return_null():
    assert "UI fallback sent chatId=${chatId} without provider id`)\n        return null" not in source
    assert "Direct UI sent chatId=${chatId} route=${directUiRouteId} without provider id`)\n      return null" not in source


def test_send_message_endpoint_uses_normalized_text_result():
    assert "const sendResult = normalizeTextSendResult(await enqueueSend(() => sendText(" in source
    assert "const maxMsgId = sendResult.externalId || sendResult.maxMessageId || null" in source
    assert "deliveryStatus: sendResult.deliveryStatus" in source
    assert "deliveryConfirmed: sendResult.deliveryConfirmed" in source


def test_send_requested_is_not_used_for_ui_fallback_success():
    old = (
        "res.json({ success: true, chatId: returnChatId, externalId: maxMsgId || null, "
        "deliveryConfirmed: isRealMaxMessageId(maxMsgId), deliveryStatus: isRealMaxMessageId(maxMsgId) ? 'delivered' : 'send_requested' })"
    )
    assert old not in source
