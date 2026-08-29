from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / 'src/lib/MessageService.ts'
source = SRC.read_text(encoding='utf-8')


def test_message_service_accepts_delivered_status_without_external_id_for_ui_resolve_send():
    expected = "maxDeliveryStatus === 'delivered'"
    assert source.count(expected) >= 2


def test_message_service_preserves_send_requested_when_not_confirmed():
    assert "status: maxDeliveryConfirmed ? 'delivered' : (maxDeliveryStatus || 'send_requested')" in source
    assert "deliveryStatus = maxDeliveryConfirmed ? 'delivered' : 'sent'" in source
