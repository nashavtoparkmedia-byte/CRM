from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'index.js'
source = SRC.read_text(encoding='utf-8')


def test_ui_text_success_without_provider_id_is_not_delivered():
    # A UI action without a provider id is not a delivery: the compose box also
    # clears for text typed while the socket is down (2026-10-02 19:25:58).
    assert "function uiTextDeliveredResult(" not in source
    assert "kind: 'ui_send_action'" not in source
    helper = source[source.index('function textSendHttpAnswer('):source.index("app.post('/send-message'")]
    requested = helper[helper.index("case 'requested':"):helper.index("case 'not_dispatched':")]
    assert "deliveryConfirmed: false," in requested
    assert "externalId: null," in requested


def test_ui_text_success_without_provider_id_does_not_return_null():
    assert "UI fallback sent chatId=${chatId} without provider id`)\n        return null" not in source
    assert "Direct UI sent chatId=${chatId} route=${directUiRouteId} without provider id`)\n      return null" not in source


def test_send_message_endpoint_answers_from_the_decided_outcome():
    assert "result = await enqueueSend(() => sendText(" in source
    assert "const answer = textSendHttpAnswer(result, { chatId: digits, providerAccountId })" in source
    assert "return res.status(answer.status).json(answer.body)" in source
    assert "normalizeTextSendResult" not in source


def test_send_requested_is_not_used_for_ui_fallback_success():
    old = (
        "res.json({ success: true, chatId: returnChatId, externalId: maxMsgId || null, "
        "deliveryConfirmed: isRealMaxMessageId(maxMsgId), deliveryStatus: isRealMaxMessageId(maxMsgId) ? 'delivered' : 'send_requested' })"
    )
    assert old not in source
