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


def test_send_message_never_types_into_a_phone_lookup():
    # A phone number names a person, not a MAX conversation. Reaching it meant
    # searching the MAX UI and typing the message into whatever opened - an
    # unproven route. /send-message refuses it before anything is typed.
    handler = source[source.index("app.post('/send-message'"):source.index("// Поставить/снять emoji-реакцию")]
    assert 'resolvePhoneLive(' not in handler
    assert "if (!digits || (digits.length >= 10 && digits.length <= 11)) {" in handler
    assert "{ outcome: 'refused', code: 'MAX_ROUTE_UNRESOLVED', reason: digits ? 'phone_target' : 'invalid_target' }" in handler
    refused = handler.index("code: 'MAX_ROUTE_UNRESOLVED'")
    assert refused < handler.index('enqueueSend('), 'a phone target must be refused before the send queue'


def test_text_send_answers_come_only_from_the_decided_outcome():
    helper = _text_send_answer_helper()
    # delivered only with a correlated provider id; a request without MAX's answer
    # is send_requested with no id; every failure carries its contract code.
    assert helper.count("deliveryStatus: 'delivered',") == 1
    assert "case 'accepted':" in helper
    assert "deliveryStatus: 'send_requested'," in helper
    assert "code: 'MAX_SEND_UNCONFIRMED'," in helper
    assert "code: 'MAX_SEND_NOT_DISPATCHED'," in helper
    assert "code: 'MAX_SEND_OUTCOME_UNKNOWN'," in helper
    assert "code: 'MAX_SEND_REJECTED'," in helper


def test_a_send_is_claimed_only_when_the_typed_text_left_the_compose_box():
    # Pressing Enter is not proof MAX accepted the text. Without a cleared compose
    # box the message was never submitted, so no send may be reported.
    assert 'evaluatePhoneResolutionUiSend({' in source
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


def test_an_unknown_outcome_is_never_reported_as_success():
    helper = _text_send_answer_helper()
    unknown = helper.index("code: 'MAX_SEND_OUTCOME_UNKNOWN',")
    default = helper.index('default:')
    assert default < unknown, 'an unrecognised outcome must fall to unknown, never to success'
    assert 'success: false,' in helper[default:unknown]


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
    collect = poll.index('echoCandidates.add(cId)')
    bind = poll.index("boundChatIdSource = 'op128_self_echo'")
    assert sender_check < collect and text_check < collect, 'both guards must precede collection'
    assert collect < bind, 'a candidate is collected before anything is bound'


def test_echo_target_must_be_a_conversation_we_do_not_already_know():
    # A first send to an unknown phone creates a new chat. An id already in the cache
    # belongs to some other thread, so binding it would cross two conversations.
    assert 'if (chatCache.has(cId)) continue' in source


def test_ambiguous_echo_candidates_bind_nothing():
    # Two candidates mean we cannot tell which chat received the message, and guessing
    # is exactly what this path exists to avoid.
    assert 'if (echoCandidates.size === 1) {' in source
    assert 'else if (echoCandidates.size > 1) {' in source
    ambiguous = source.index('else if (echoCandidates.size > 1) {')
    nxt = source.index('}', source.index('break', ambiguous))
    assert 'boundChatId =' not in source[ambiguous:nxt]


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
    assert "[Send] refused target ${digits ? maskPhoneForLog(digits) : 'none'}" in source


def test_unreadable_compose_is_never_scored_as_a_cleared_box():
    # A detached element reads as empty; empty must not be mistaken for submitted.
    assert "await composeEl.textContent().catch(() => null)" in source
    assert "composeTextAfterSubmit === null" in source
    assert "confirmationSource: 'compose_unreadable'" in source


def test_send_button_is_clicked_only_when_the_exact_text_remains():
    # A partially cleared box means MAX is mid-accept; clicking again duplicates.
    assert "normalizeUiSendText(afterEnterText) === normalizeUiSendText(messageToSend)" in source
    assert "afterEnterText !== null" in source


def test_binding_failure_after_a_proven_submit_does_not_unwind_to_not_found():
    # Once submitted the message is out; a binding failure must degrade, not 404.
    assert 'catch (bindError)' in source
    guard = source.index('catch (bindError)')
    terminal = source.index('messageSent: true', guard)
    assert 'boundChatId = null' in source[guard:terminal]


def test_compose_submit_is_judged_by_the_wire_not_the_box():
    # An emptied compose box is what MAX Web also shows for text typed while its
    # socket was down. The box only decides between "not dispatched" (it still
    # holds the exact text) and "unknown"; it never proves a send.
    block = source[source.index('async function submitTextThroughCompose'):source.index('async function submitReplyThroughPage')]
    assert 'isUiTextSubmitObserved' not in block
    assert 'inspectWithoutRequest: async () => {' in block
    assert 'return { composeRetainedText: retained }' in block
    assert "const sent = !String(afterText || '').trim()" not in source


def _text_send_answer_helper():
    return source[source.index('function textSendHttpAnswer('):source.index("app.post('/send-message'")]


def _json_responses(branch):
    """Each `res.json({ ... })` object literal in `branch`, by brace matching."""
    found = []
    at = 0
    while True:
        start = branch.find('res.json({', at)
        if start < 0:
            return found
        open_at = branch.index('{', start)
        depth = 0
        for i in range(open_at, len(branch)):
            if branch[i] == '{':
                depth += 1
            elif branch[i] == '}':
                depth -= 1
                if depth == 0:
                    found.append(branch[open_at:i + 1])
                    at = i + 1
                    break


def test_no_ui_action_is_minted_as_a_delivery_proof():
    # The compose box clearing was recorded as delivered for a message that never
    # left the page (2026-10-02 19:25:58). No UI action is a delivery proof.
    assert 'function uiTextDeliveredResult(' not in source
    assert "kind: 'ui_send_action'" not in source
    import re
    assert not re.search(r'\bactionConfirmed: true', source)


def test_every_text_send_answer_echoes_the_live_account():
    # Gravity's MAX transport rejects a send result that does not echo the exact
    # live account (MAX_PROVIDER_ACCOUNT_PROOF_MISMATCH).
    helper = _text_send_answer_helper()
    base = helper[helper.index('const base = {'):helper.index('switch (result?.outcome)')]
    assert 'providerAccountId,' in base
    assert helper.count('...base,') == 6
    handler = source[source.index("app.post('/send-message'"):source.index("// Поставить/снять emoji-реакцию")]
    assert 'const providerAccountId = requireLiveMaxProviderAccount(req, res)' in handler