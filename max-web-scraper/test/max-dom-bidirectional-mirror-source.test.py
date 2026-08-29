from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
INDEX = (ROOT / 'index.js').read_text(encoding='utf-8')


def test_missing_protocol_anchor_requests_dom_recovery():
    assert 'const anchorHex = transport?._op71AnchorForLiveNotification?.(String(chatId)) || null' in INDEX
    assert 'const hasPendingLive = (transport?._pendingLiveMessageIds?.get(String(chatId)) || []).length > 0' in INDEX
    assert "scheduleAutomaticDomMirrorRecovery(String(chatId), 'missing_protocol_anchor')" in INDEX


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
    assert 'const crmOutboundDomGuard = rememberCrmOutboundText(message, chatId, uiChatId, phone)' in INDEX


def test_dom_profile_identity_can_enrich_phone_and_name():
    assert 'async function scrapeDomPeerIdentity(' in INDEX
    assert '/^(Номер телефона|Phone number)$/i.test(text)' in INDEX
    assert 'savePhoneChatId(peerIdentity.phone, chatId)' in INDEX
    assert "app.post('/debug/dom-identity'" in INDEX
