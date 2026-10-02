from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INDEX = (ROOT / 'index.js').read_text(encoding='utf-8')


def test_dom_recovery_is_requested_only_for_an_unpersisted_acknowledged_push():
    # DOM recovery used to start on a timer after EVERY op:128 and to yield to the
    # live path by time window - which is how "2" of 1,2,3,3,3,3,4 was skipped as
    # dom_live_window_filtered while the live path had dropped it. It now runs
    # only for a push the page acknowledged that the CRM has not stored, handed
    # that exact provider id, after the provider store could not supply it.
    call = "scheduleAutomaticDomMirrorRecovery(String(chatId), 'empty_op71_after_op128')"
    assert INDEX.count(call) == 1
    recover = INDEX.index('async function recoverUnpersistedLiveMessage(')
    at = INDEX.index(call)
    assert recover < at < INDEX.index('async function forwardIncomingMessage(')
    assert INDEX.rindex('registerPendingLiveTextIdForDomRecovery?.(chatId, messageId)', 0, at) > recover
    assert "scheduleAutomaticDomMirrorRecovery(String(chatId), 'missing_protocol_anchor')" not in INDEX
    raw = INDEX[INDEX.index('if (data.opcode === OP.INCOMING_MSG) {'):INDEX.index('// Логируем остальные неизвестные push-опкоды')]
    assert 'scheduleAutomaticDomMirrorRecovery' not in raw


def test_automatic_recovery_reads_only_fresh_dom_messages():
    assert 'function scheduleAutomaticDomMirrorRecovery(' in INDEX
    assert 'includeOutgoing: true' in INDEX
    assert 'freshOnly: true' in INDEX
    assert 'enrichPeer: true' in INDEX
    assert 'preSkipped.dom_stale_event_filtered' in INDEX


def test_outgoing_max_web_messages_are_mirrored_without_crm_echo_duplicates():
    assert 'function stableDomMirrorMessageId(' in INDEX
    assert 'return `max-mirror-${chatId}-${hash}`' in INDEX
    assert "source: isOutgoingCandidate ? 'max_web_mirror'" in INDEX
    assert 'isOutgoing: isOutgoingCandidate' in INDEX
    assert "skipped: 'crm_outbound_already_recorded'" in INDEX
    assert 'rememberCrmOutboundText(message, digits, uiChatId, phone)' in INDEX


def test_dom_profile_identity_can_enrich_phone_and_name():
    assert 'async function scrapeDomPeerIdentity(' in INDEX
    assert '/^(Номер телефона|Phone number)$/i.test(text)' in INDEX
    assert 'savePhoneChatId(peerIdentity.phone, chatId)' in INDEX
    assert "app.post('/debug/dom-identity'" in INDEX
