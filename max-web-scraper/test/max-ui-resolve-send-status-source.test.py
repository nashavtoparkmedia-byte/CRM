from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'index.js'
source = SRC.read_text(encoding='utf-8')


def test_ui_resolve_send_returns_only_send_specific_confirmed_status():
    assert "deliveryConfirmed: uiDeliveryConfirmed" in source
    assert "deliveryStatus: uiDeliveryConfirmed ? 'delivered' : 'send_requested'" in source
    assert "source: uiDeliveryConfirmed ? 'ui_resolve_send' : 'ui_resolve_send_unconfirmed'" in source
    assert "const phoneUiOutcome = evaluatePhoneResolutionUiSend" in source
    assert "postActionFrames: postSendFrames" in source


def test_ui_resolve_send_does_not_accept_generic_frame_activity():
    assert "const sendFrameStartIndex = capturedFrames.length" in source
    assert "findCorrelatedUiTextSendEcho" not in source
    assert "exact_text_submit_route_changed" not in source
    assert "messageSent: true" not in source
