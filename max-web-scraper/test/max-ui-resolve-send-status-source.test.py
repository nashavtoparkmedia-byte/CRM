from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
SRC = ROOT / 'index.js'
source = SRC.read_text(encoding='utf-8')


def test_send_bound_chat_id_comes_only_from_action_bound_signals():
    # Exactly two signals are tied to the send we just performed: the SPA navigating
    # to the new dialog, and MAX echoing back a message whose sender is our own user.
    assert "boundChatIdSource = 'ui_route_url'" in source
    assert "boundChatIdSource = 'op128_self_echo'" in source
    assert "if (!transport?._myUserId || String(sender) !== String(transport._myUserId)) continue" in source
    # Only those two assignments exist; nothing else may set the source.
    import re
    assert len(re.findall(r"boundChatIdSource = '", source)) == 2


def test_unbound_frames_never_define_the_send_target():
    poll = source.split('Waiting for a send signal bound to this action', 1)[1]
    poll = poll.split('return {', 1)[0]
    # Chat-list, common-chats, send-ack and history frames can describe any
    # conversation, so none of them may resolve this operation's target.
    for opcode in ('f.opcode === 48', 'f.opcode === 64', 'f.opcode === 65',
                   'f.opcode === 71', 'f.opcode === 72', 'f.opcode === 198'):
        assert opcode not in poll, opcode
    assert 'UI send confirmed by op:64' not in source
    # The no-send phone lookup may still resolve a chat id from any frame, but it
    # must never report a send it did not perform.
    assert 'messageSent: true' not in source.split('// Fall through to 6b write-button logic below', 1)[1]


def test_attempted_ui_send_is_terminal_even_without_a_bound_chat_id():
    assert 'uiSendAttempted: true' in source
    assert "const uiSendAttempted = Boolean(liveResult && typeof liveResult === 'object' && liveResult.uiSendAttempted === true)" in source
    attempted = source.index('if (uiSendAttempted) {')
    returned = source.index('return res.json({', attempted)
    protocol_send = source.index('const sendResult = normalizeTextSendResult', attempted)
    assert returned < protocol_send, 'an attempted UI send must return before the protocol send path'
    # The early return is unconditional inside the branch, so a missing chat id
    # can never fall through into a second send of the same message.
    branch = source[attempted:returned]
    assert 'return' not in branch


def test_ui_send_reports_send_requested_and_marks_unbound_results():
    assert "deliveryConfirmed: false," in source
    assert "deliveryStatus: 'send_requested'," in source
    assert "source: liveId ? 'ui_resolve_send' : 'ui_resolve_send_unconfirmed'," in source


def test_bound_chat_id_is_persisted_for_later_sends():
    attempted = source.index('if (uiSendAttempted) {')
    branch = source[attempted:source.index('return res.json({', attempted)]
    assert 'savePhoneChatId(digits, liveId)' in branch
    assert 'contactStore._map.set(liveId' in branch
