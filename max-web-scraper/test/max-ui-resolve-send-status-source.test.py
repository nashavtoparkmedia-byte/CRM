from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'index.js'
source = SRC.read_text(encoding='utf-8')


def test_ui_resolve_send_returns_only_send_specific_confirmed_status():
    assert "deliveryConfirmed: uiDeliveryConfirmed" in source
    assert "deliveryStatus: uiDeliveryConfirmed ? 'delivered' : 'send_requested'" in source
    assert "source: uiDeliveryConfirmed ? 'ui_resolve_send' : 'ui_resolve_send_unconfirmed'" in source
    assert "kind: 'ui_send_action'" in source
    assert "clientMessageId: clientMessageId ? String(clientMessageId) : null" in source


def test_ui_resolve_send_does_not_accept_generic_frame_activity():
    assert "const sendFrameStartIndex = capturedFrames.length" in source
    assert "findCorrelatedUiTextSendEcho(capturedFrames" in source
    assert "messageSent: true" not in source
