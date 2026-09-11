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
    # The echo scan must only see frames from this send. The capture buffer starts
    # filling when the phone-lookup dialog opens, so an earlier self echo from another
    # chat would otherwise bind the wrong conversation to this message.
    assert 'for (const f of capturedFrames.slice(sendFrameStartIndex)) {' in source
    assert 'const sendFrameStartIndex = capturedFrames.length' in source
    poll_start = source.index('Waiting for a send signal bound to this action')
    poll_end = source.index('await returnHome(); cleanup()', poll_start)
    poll = source[poll_start:poll_end]
    assert 'for (const f of capturedFrames)' not in poll, 'unscoped frame scan in the bound-signal poll'
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
    # The weak-guessing form production runs returns {chatId, messageSent:true} from
    # ten unbound sites. Exactly one site may report a send, and it is the proven one.
    assert source.count('messageSent: true') == 1
    proven = source.index('messageSent: true')
    assert source.rindex('submitObserved: true', 0, proven) > source.index('if (!uiOutcome.submitObserved) {')
    assert 'messageSent: true }' not in source


def _branch_body(text, header):
    """Return the body of the block introduced by `header`, by brace matching."""
    open_at = text.index('{', text.index(header))
    depth = 0
    for i in range(open_at, len(text)):
        if text[i] == '{':
            depth += 1
        elif text[i] == '}':
            depth -= 1
            if depth == 0:
                return text[open_at + 1:i]
    raise AssertionError('unbalanced braces after ' + header)


def test_attempted_ui_send_is_terminal_even_without_a_bound_chat_id():
    assert 'uiSendAttempted: true' in source
    assert "const uiSendAttempted = Boolean(liveResult && typeof liveResult === 'object' && liveResult.uiSendAttempted === true)" in source

    branch = _branch_body(source, 'if (uiSendAttempted) {')

    # Every exit from the branch is a return, so an attempted UI send can never fall
    # through into a second send of the same message, with or without a chat id.
    assert 'res.status(502)' in branch
    assert 'success: true,' in branch
    assert branch.count('return res.') == 2, branch.count('return res.')
    assert 'normalizeTextSendResult' not in branch

    # Both responses precede the protocol send path in the enclosing handler.
    attempted = source.index('if (uiSendAttempted) {')
    protocol_send = source.index('const sendResult = normalizeTextSendResult', attempted)
    assert source.index('return res.status(502)', attempted) < protocol_send
    assert source.index('return res.json({', attempted) < protocol_send


def test_ui_send_reports_send_requested_and_marks_unbound_results():
    assert "deliveryConfirmed: false," in source
    assert "deliveryStatus: 'send_requested'," in source
    assert "source: liveId ? 'ui_resolve_send' : 'ui_resolve_send_unconfirmed'," in source


def test_bound_chat_id_is_persisted_for_later_sends():
    attempted = source.index('if (uiSendAttempted) {')
    branch = source[attempted:source.index('return res.json({', attempted)]
    assert 'savePhoneChatId(digits, liveId)' in branch
    assert 'contactStore._map.set(liveId' in branch


def test_a_send_is_claimed_only_when_the_typed_text_left_the_compose_box():
    # Pressing Enter is not proof MAX accepted the text. Without a cleared compose
    # box the message was never submitted, so no send may be reported.
    assert 'const uiOutcome = evaluatePhoneResolutionUiSend({' in source
    assert 'beforeText: composeTextBeforeSubmit,' in source
    assert 'afterText: composeTextAfterSubmit,' in source
    assert 'expectedText: messageToSend,' in source
    assert 'if (!uiOutcome.submitObserved) {' in source
    assert 'submitObserved: false,' in source
    assert 'messageSent: false,' in source

    # The unproven-submit branch returns before the bound-signal poll can run.
    unproven = source.index('if (!uiOutcome.submitObserved) {')
    returned = source.index('return {', unproven)
    poll = source.index('Waiting for a send signal bound to this action')
    assert returned < poll, 'an unproven submit must return before binding a chat id'


def test_unproven_submit_is_reported_as_failure_not_as_success():
    attempted = source.index('if (uiSendAttempted) {')
    guard = source.index('if (liveResult.submitObserved !== true) {', attempted)
    ok_return = source.index("success: true,", attempted)
    assert guard < ok_return, 'the unproven-submit guard must precede any success response'
    branch = source[guard:source.index('}', source.index('res.status(502)', guard))]
    assert 'success: false,' in branch
    assert "deliveryStatus: 'failed'," in branch
    assert 'error:' in branch
    # Still terminal: it returns rather than falling through to a protocol send.
    protocol_send = source.index('const sendResult = normalizeTextSendResult', guard)
    assert source.index('res.status(502)', guard) < protocol_send


def test_self_echo_must_carry_this_requests_text():
    # Our own echo proves only that this account sent something. Without matching the
    # submitted body, a second outbound in flight binds its chat to this operation and
    # a wrong phone->chat mapping is persisted.
    assert 'if (normalizeUiSendText(fp.message.text) !== expectedSubmittedText) continue' in source
    assert 'const expectedSubmittedText = normalizeUiSendText(messageToSend)' in source
    assert 'function normalizeUiSendText(value) {' in source

    poll_start = source.index('Waiting for a send signal bound to this action')
    poll_end = source.index('await returnHome(); cleanup()', poll_start)
    poll = source[poll_start:poll_end]
    sender_check = poll.index('String(sender) !== String(transport._myUserId)')
    text_check = poll.index('!== expectedSubmittedText')
    bind = poll.index("boundChatIdSource = 'op128_self_echo'")
    assert sender_check < bind and text_check < bind, 'both guards must precede the binding'


def test_shared_page_is_claimed_for_the_whole_compose_and_bind_window():
    # `page` is process-wide and automatic DOM recovery navigates it to other chats,
    # which would make the route signal read an unrelated conversation.
    compose = source.index('if (composeEl) {')
    claim = source.index('uiSendInProgress = true', compose)
    poll = source.index('Waiting for a send signal bound to this action', compose)
    release = source.index('uiSendInProgress = false', compose)
    assert claim < poll < release, 'the guard must span typing and binding'
    assert '} finally {' in source[poll:release + 80]


def test_multiline_message_is_not_submitted_one_line_at_a_time():
    # keyboard.type() delivers an embedded newline as Enter, submitting the first line
    # and leaving the rest behind, which also defeats the submit proof.
    compose = source.index('if (composeEl) {')
    end = source.index('Waiting for a send signal bound to this action', compose)
    block = source[compose:end]
    assert 'await fillEditableText(composeEl, messageToSend)' in block
    assert 'page.keyboard.type(messageToSend' not in block


def test_new_send_log_lines_do_not_emit_the_raw_phone():
    assert 'function maskPhoneForLog(value)' in source
    for line in (
        '[Send] UI send for ${maskPhoneForLog(digits)} did not take effect',
        '[Send] UI-resolved: ${maskPhoneForLog(digits)}',
        '[Send] UI send attempted for ${maskPhoneForLog(digits)}',
    ):
        assert line in source, line
