from pathlib import Path

ROOT = Path(__file__).resolve().parents[3]
SRC = ROOT / 'src/lib/MessageService.ts'
source = SRC.read_text(encoding='utf-8')


def test_message_service_accepts_only_max_owned_validated_delivery_outcomes():
    assert "const maxDeliveryConfirmed = maxRes.outcome === 'delivered'" in source
    assert "const maxDeliveryConfirmed = retryMaxRes.outcome === 'delivered'" in source
    assert "(maxRes as any)?.deliveryStatus" not in source
    assert "(retryMaxRes as any)?.deliveryStatus" not in source


def test_message_service_preserves_send_requested_when_not_confirmed():
    assert "status: maxDeliveryConfirmed ? 'delivered' : 'send_requested'" in source
    assert "deliveryStatus = maxDeliveryConfirmed ? 'delivered' : 'sent'" in source
