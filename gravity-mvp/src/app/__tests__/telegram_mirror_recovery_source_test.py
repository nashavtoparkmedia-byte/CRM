#!/usr/bin/env python3
from pathlib import Path
import re


SRC = Path(__file__).resolve().parents[2]
REPO = SRC.parents[1]


def test_telegram_uses_private_http_connect_proxy() -> None:
    actions = (SRC / "app/tg-actions.ts").read_text(encoding="utf-8")
    socket = (SRC / "lib/telegram/TelegramHttpConnectSocket.ts").read_text(encoding="utf-8")
    compose = (REPO / "deploy/docker-compose.production.yml").read_text(encoding="utf-8")

    assert "networkSocket: TelegramHttpConnectSocket as any" in actions
    assert "CONNECT ${target} HTTP/1.1" in socket
    assert "TG_HTTP_PROXY_HOST: 172.19.0.1" in compose
    assert 'TG_HTTP_PROXY_PORT: "10810"' in compose


def test_catchup_replays_read_inbound_and_outbound_messages() -> None:
    actions = (SRC / "app/tg-actions.ts").read_text(encoding="utf-8")
    catchup = re.search(
        r"async function catchUpMissedMessages.*?\n}\n\n/\*\*",
        actions,
        re.S,
    )
    assert catchup
    body = catchup.group(0)
    assert "processOutboundMirrorMessage" in body
    assert "processInboundTelegramMessage" in body
    assert "dialog.unreadCount > 0" not in body


def test_external_outbound_can_create_a_new_crm_chat() -> None:
    actions = (SRC / "app/tg-actions.ts").read_text(encoding="utf-8")
    mirror = re.search(
        r"async function processOutboundMirrorMessage.*?\n}\n\nasync function catchUpMissedMessages",
        actions,
        re.S,
    )
    assert mirror
    body = mirror.group(0)
    assert "if (!chat) return" not in body
    assert "AUTO-CREATED outbound chat" in body
    assert "ContactService.ensureChatLinked" in body


def test_external_outbound_media_is_persisted_and_backfilled() -> None:
    actions = (SRC / "app/tg-actions.ts").read_text(encoding="utf-8")
    assert "ensureOutboundTelegramAttachment(message, existing.id" in actions
    assert "ensureOutboundTelegramAttachment(message, saved.id" in actions
    assert "const dataUrl = `data:${mimeType};base64,${buffer.toString('base64')}`" in actions
    attachment = re.search(
        r"async function ensureOutboundTelegramAttachment.*?\n}\n\nasync function catchUpMissedMessages",
        actions,
        re.S,
    )
    assert attachment
    body = attachment.group(0)
    assert "url: dataUrl" in body
    assert "data: buffer" not in body


if __name__ == "__main__":
    tests = [
        test_telegram_uses_private_http_connect_proxy,
        test_catchup_replays_read_inbound_and_outbound_messages,
        test_external_outbound_can_create_a_new_crm_chat,
        test_external_outbound_media_is_persisted_and_backfilled,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)}/{len(tests)} PASS")
