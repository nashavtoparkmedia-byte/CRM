#!/usr/bin/env python3
from pathlib import Path
import re


SRC = Path(__file__).resolve().parents[3]


def read(relative: str) -> str:
    return (SRC / relative).read_text(encoding="utf-8")


def test_global_stream_creates_alert_without_a_sip_session() -> None:
    context = read("lib/sip/SipContext.tsx")

    incoming_branch = re.search(
        r"if \(data\.type === 'incoming'\) \{(?P<body>.*?)\n\s*\}",
        context,
        re.S,
    )
    assert incoming_branch, "missing incoming SSE branch"
    assert "setIncomingAlert(data.data)" in incoming_branch.group("body")
    assert "incomingCall &&" not in incoming_branch.group("body")
    assert "setIncomingAlert(prev => prev?.callId === data.data.callId ? null : prev)" in context


def test_ringtone_uses_one_unlockable_audio_context() -> None:
    audio = read("lib/sip/callAlertAudio.ts")

    assert "let audioContext: AudioContext | null = null" in audio
    assert "await ctx.resume()" in audio
    assert "audioContext.state === 'running' ? 'ready' : 'needs-interaction'" in audio
    assert "export async function startIncomingRingtone" in audio
    assert "ctx.close()" not in audio, "shared unlocked context must survive between calls"


def test_popup_rings_for_global_alert_and_offers_chrome_unlock() -> None:
    popup = read("components/sip/IncomingCallPopup.tsx")
    toolbar = read("components/sip/CallToolbar.tsx")

    assert "const attentionCall = incomingCall ?? incomingAlert" in popup
    assert "startIncomingRingtone()" in popup
    assert "Chrome заблокировал звук — включить" in popup
    assert "Включить звук" in toolbar
    assert "callAlertAudioStatus === 'needs-interaction'" in toolbar


def test_outbound_channel_create_does_not_broadcast_incoming_alert() -> None:
    esl = read("lib/freeswitch/EslClient.ts")

    guarded_broadcast = re.search(
        r"if \(direction === 'inbound'\) \{\s*broadcastCall\(\{\s*type: 'incoming'",
        esl,
        re.S,
    )
    assert guarded_broadcast, "incoming attention event must be inbound-only"


if __name__ == "__main__":
    tests = [
        test_global_stream_creates_alert_without_a_sip_session,
        test_ringtone_uses_one_unlockable_audio_context,
        test_popup_rings_for_global_alert_and_offers_chrome_unlock,
        test_outbound_channel_create_does_not_broadcast_incoming_alert,
    ]
    for test in tests:
        test()
        print(f"PASS {test.__name__}")
    print(f"{len(tests)}/{len(tests)} PASS")
