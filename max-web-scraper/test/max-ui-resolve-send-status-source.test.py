from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'index.js'
source = SRC.read_text(encoding='utf-8')


def test_ui_resolve_send_returns_delivered_status():
    needle = """return res.json({
            success: true,
            chatId: liveId,
            externalId: null,
            deliveryConfirmed: true,
            deliveryStatus: 'delivered',
            source: 'ui_resolve_send',
          })"""
    assert needle in source


def test_ui_resolve_send_no_longer_returns_send_requested():
    old = "return res.json({ success: true, chatId: liveId, externalId: null, deliveryConfirmed: false, deliveryStatus: 'send_requested' })"
    assert old not in source
