'use strict'

const REAL_MAX_MESSAGE_ID_RE = /^d301[0-9a-f]{14}$/i

function normalizeReplyText(value) {
  return String(value || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n/g, '\n')
    .trim()
}

function timestampMs(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }
  const parsed = new Date(value).getTime()
  return Number.isFinite(parsed) ? parsed : null
}

function uiRouteIdFromProviderChatId(value) {
  return BigInt.asUintN(32, BigInt(String(value))).toString()
}

function providerIdFromDecimal(value) {
  let numeric = BigInt(String(value))
  if (numeric < 0n) numeric += 1n << 64n
  if (numeric < 0n || numeric >= (1n << 64n)) {
    throw new Error('MAX message id is outside uint64 range')
  }
  return `d3${numeric.toString(16).padStart(16, '0')}`
}

function providerDecimalFromId(value) {
  const providerId = String(value || '').toLowerCase()
  if (!REAL_MAX_MESSAGE_ID_RE.test(providerId)) {
    throw new Error('Reply requires real MAX provider message id')
  }
  return BigInt(`0x${providerId.slice(2)}`).toString()
}

function selectReplyTargetCandidate(candidates, context = {}, options = {}) {
  const expectedText = normalizeReplyText(context.text)
  if (!expectedText) return { providerMessageId: null, reason: 'missing_quoted_text' }

  const expectedTime = timestampMs(context.sentAt)
  const expectedDirection = context.direction === 'outbound'
    ? true
    : (context.direction === 'inbound' ? false : null)
  const maxDistanceMs = Number(options.maxDistanceMs) || 120_000
  const ambiguityMarginMs = Number(options.ambiguityMarginMs) || 150
  const excludedProviderMessageIds = new Set(
    Array.from(options.excludedProviderMessageIds || [], value => String(value).toLowerCase())
  )
  const seenIds = new Set()

  const matches = []
  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (normalizeReplyText(candidate?.text) !== expectedText) continue
    if (expectedDirection !== null && Boolean(candidate?.isOutgoing) !== expectedDirection) continue

    let providerMessageId
    try {
      providerMessageId = providerIdFromDecimal(candidate.id)
    } catch {
      continue
    }
    if (!REAL_MAX_MESSAGE_ID_RE.test(providerMessageId)
      || excludedProviderMessageIds.has(providerMessageId.toLowerCase())
      || seenIds.has(providerMessageId)) continue

    const candidateTime = timestampMs(candidate.timestamp)
    const distanceMs = expectedTime !== null && candidateTime !== null
      ? Math.abs(candidateTime - expectedTime)
      : null
    if (expectedTime !== null && (distanceMs === null || distanceMs > maxDistanceMs)) continue

    seenIds.add(providerMessageId)
    matches.push({ providerMessageId, candidateTime, distanceMs })
  }

  if (matches.length === 0) return { providerMessageId: null, reason: 'no_strict_match' }
  if (matches.length === 1) return { ...matches[0], reason: 'unique_strict_match' }
  if (expectedTime === null) return { providerMessageId: null, reason: 'ambiguous_without_timestamp' }

  matches.sort((left, right) =>
    (left.distanceMs - right.distanceMs) ||
    (left.candidateTime - right.candidateTime) ||
    left.providerMessageId.localeCompare(right.providerMessageId)
  )
  const best = matches[0]
  const second = matches[1]
  if (best.distanceMs === 0 || second.distanceMs - best.distanceMs >= ambiguityMarginMs) {
    return { ...best, reason: 'nearest_strict_match' }
  }
  return { providerMessageId: null, reason: 'ambiguous_strict_match' }
}

function selectInboundReplyCandidate(candidates, context = {}, options = {}) {
  const expectedBodyText = normalizeReplyText(context.bodyText)
  const expectedQuotedText = normalizeReplyText(context.quotedText)
  if (!expectedBodyText || !expectedQuotedText) {
    return { providerMessageId: null, reason: 'missing_reply_context' }
  }

  const receivedAt = timestampMs(context.receivedAt)
  const maxDistanceMs = Number(options.maxDistanceMs) || 120_000
  const ambiguityMarginMs = Number(options.ambiguityMarginMs) || 150
  const matches = []
  const seenIds = new Set()

  for (const candidate of Array.isArray(candidates) ? candidates : []) {
    if (Boolean(candidate?.isOutgoing)) continue
    if (normalizeReplyText(candidate?.text) !== expectedBodyText) continue
    if (normalizeReplyText(candidate?.quotedText) !== expectedQuotedText) continue
    if (!candidate?.replyToId) continue

    let providerMessageId
    let replyToExternalId
    try {
      providerMessageId = providerIdFromDecimal(candidate.id)
      replyToExternalId = providerIdFromDecimal(candidate.replyToId)
    } catch {
      continue
    }
    if (seenIds.has(providerMessageId)) continue

    const candidateTime = timestampMs(candidate.timestamp)
    const distanceMs = receivedAt !== null && candidateTime !== null
      ? Math.abs(candidateTime - receivedAt)
      : null
    if (receivedAt !== null && (distanceMs === null || distanceMs > maxDistanceMs)) continue

    seenIds.add(providerMessageId)
    matches.push({ providerMessageId, replyToExternalId, timestamp: candidateTime, distanceMs })
  }

  if (matches.length === 0) return { providerMessageId: null, reason: 'no_strict_reply_match' }
  if (matches.length === 1) {
    const { distanceMs, ...match } = matches[0]
    return { ...match, reason: 'unique_strict_reply_match' }
  }
  if (receivedAt === null) return { providerMessageId: null, reason: 'ambiguous_strict_reply_match' }

  matches.sort((left, right) =>
    (left.distanceMs - right.distanceMs) ||
    (left.timestamp - right.timestamp) ||
    left.providerMessageId.localeCompare(right.providerMessageId)
  )
  const best = matches[0]
  const second = matches[1]
  if ((best.distanceMs === 0 && second.distanceMs > 0) || second.distanceMs - best.distanceMs >= ambiguityMarginMs) {
    const { distanceMs, ...match } = best
    return { ...match, reason: 'nearest_strict_reply_match' }
  }
  return { providerMessageId: null, reason: 'ambiguous_strict_reply_match' }
}

class MaxWebReplyBridge {
  constructor(page) {
    this.page = page
  }

  async readProviderMessage(chatId, providerMessageId, options = {}) {
    if (!this.page) throw new Error('MAX Web page is not available')
    const expectedProviderMessageId = String(providerMessageId || '').toLowerCase()
    const providerMessageDecimal = providerDecimalFromId(expectedProviderMessageId)
    const rawUiRouteId = String(options.uiChatId || '').trim()
    const uiRouteId = /^\d{1,10}$/.test(rawUiRouteId)
      ? rawUiRouteId
      : uiRouteIdFromProviderChatId(chatId)
    const result = await this.page.evaluate(async args => {
      const findCoreModule = async () => {
        const cached = window.__crmMaxCoreModule
        if (cached?.store?.chats && cached?.store?.messages) return cached

        const describeModule = (module, url) => {
          const legacyStore = module?.Wa
          if (legacyStore?.chats && legacyStore?.messages) {
            return { module, url, store: legacyStore, storeExportKey: 'Wa', legacySendPrimitives: true }
          }
          const storeMatches = Object.entries(module || {}).filter(([, value]) => {
            try {
              return value !== null && typeof value === 'object' &&
                typeof value.chats?.getLazy === 'function' &&
                typeof value.messages?.get === 'function' &&
                value.profile != null
            } catch {
              return false
            }
          })
          if (storeMatches.length !== 1) return null
          const [storeExportKey, store] = storeMatches[0]
          return { module, url, store, storeExportKey, legacySendPrimitives: false }
        }

        const urls = new Set()
        for (const script of document.querySelectorAll('script[src]')) urls.add(script.src)
        for (const entry of performance.getEntriesByType('resource')) {
          if (entry?.name) urls.add(entry.name)
        }
        for (const url of urls) {
          if (!/\/_app\/immutable\/chunks\/[^/]+\.js(?:\?|$)/.test(url)) continue
          try {
            const module = await import(url)
            const descriptor = describeModule(module, url)
            if (descriptor) {
              window.__crmMaxCoreModule = descriptor
              return window.__crmMaxCoreModule
            }
          } catch {}
        }
        return null
      }

      try {
        const core = await findCoreModule()
        if (!core) return { ok: false, reason: 'max_web_core_not_found' }
        const requestedChatKey = BigInt(String(args.chatId))
        const uiRouteKey = BigInt(String(args.uiRouteId))
        const messageKey = BigInt(String(args.providerMessageDecimal))
        let routeMatches = Array.from(core.store.chats.values || []).filter(candidate => {
          try {
            return BigInt.asUintN(32, BigInt(candidate?.id)) === uiRouteKey
          } catch {
            return false
          }
        })
        if (routeMatches.length > 1) {
          return { ok: false, reason: 'max_web_chat_route_ambiguous' }
        }
        const chat = routeMatches.length === 1
          ? routeMatches[0]
          : await core.store.chats.getLazy(requestedChatKey)
        if (!chat) return { ok: false, reason: 'max_web_chat_not_loaded' }
        const chatKey = chat.id
        try {
          const normalizedChatKey = BigInt(chatKey)
          if ((normalizedChatKey !== requestedChatKey && normalizedChatKey !== uiRouteKey)
            || BigInt.asUintN(32, normalizedChatKey) !== uiRouteKey) {
            return { ok: false, reason: 'max_web_chat_route_mismatch' }
          }
        } catch {
          return { ok: false, reason: 'max_web_chat_route_mismatch' }
        }
        routeMatches = Array.from(core.store.chats.values || []).filter(candidate => {
          try {
            return BigInt.asUintN(32, BigInt(candidate?.id)) === uiRouteKey
          } catch {
            return false
          }
        })
        if (routeMatches.length > 1
          || (routeMatches.length === 1
            && ![requestedChatKey, uiRouteKey].includes(BigInt(routeMatches[0]?.id)))) {
          return { ok: false, reason: 'max_web_chat_route_ambiguous' }
        }
        const routeMatchCount = 1

        let message = Array.from(chat.messages || []).find(candidate => {
          try {
            return BigInt.asUintN(64, BigInt(candidate?.id)) === messageKey
          } catch {
            return false
          }
        })
        if (!message && core.store.messages?.get) {
          try { message = await core.store.messages.get(chatKey).getLazy(messageKey) } catch {}
        }
        if (!message) return { ok: false, reason: 'max_web_provider_message_not_loaded' }

        let replyToId = null
        try {
          if (message?.link?.id != null && BigInt(message.link.id) !== 0n) {
            replyToId = BigInt.asUintN(64, BigInt(message.link.id)).toString()
          }
        } catch {}
        return {
          ok: true,
          providerChatId: String(chatKey),
          routeMatchCount,
          message: {
            id: BigInt.asUintN(64, BigInt(message.id)).toString(),
            text: message.text?.plain || '',
            timestamp: Number(message.time) || null,
            isOutgoing: Boolean(message.isOut),
            replyToId,
          },
        }
      } catch (error) {
        return { ok: false, reason: String(error?.message || error) }
      }
    }, {
      chatId: String(chatId),
      uiRouteId,
      providerMessageDecimal,
    })

    if (!result?.ok) throw new Error(`MAX provider message lookup failed: ${result?.reason || 'unknown'}`)
    const resolvedProviderMessageId = providerIdFromDecimal(result.message?.id)
    if (resolvedProviderMessageId !== expectedProviderMessageId) {
      throw new Error('MAX provider message lookup failed: provider identity mismatch')
    }
    let replyToExternalId = null
    if (result.message?.replyToId) {
      try { replyToExternalId = providerIdFromDecimal(result.message.replyToId) } catch {}
    }
    return {
      providerMessageId: resolvedProviderMessageId,
      providerChatId: result.providerChatId || null,
      routeMatchCount: Number(result.routeMatchCount) || 0,
      text: normalizeReplyText(result.message?.text),
      exactText: typeof result.message?.text === 'string' ? result.message.text : '',
      timestamp: timestampMs(result.message?.timestamp),
      isOutgoing: Boolean(result.message?.isOutgoing),
      replyToExternalId,
    }
  }

  async readCandidates(chatId, context = {}, options = {}) {
    if (!this.page) throw new Error('MAX Web page is not available')
    const rawUiRouteId = String(options.uiChatId || '').trim()
    const uiRouteId = /^\d{1,10}$/.test(rawUiRouteId)
      ? rawUiRouteId
      : uiRouteIdFromProviderChatId(chatId)
    const result = await this.page.evaluate(async args => {
      const findCoreModule = async () => {
        const cached = window.__crmMaxCoreModule
        if (cached?.store?.chats && cached?.store?.messages) return cached

        const describeModule = (module, url) => {
          const legacyStore = module?.Wa
          if (legacyStore?.chats && legacyStore?.messages) {
            return { module, url, store: legacyStore, storeExportKey: 'Wa', legacySendPrimitives: true }
          }
          const storeMatches = Object.entries(module || {}).filter(([, value]) => {
            try {
              return value !== null && typeof value === 'object' &&
                typeof value.chats?.getLazy === 'function' &&
                typeof value.messages?.get === 'function' &&
                value.profile != null
            } catch {
              return false
            }
          })
          if (storeMatches.length !== 1) return null
          const [storeExportKey, store] = storeMatches[0]
          return { module, url, store, storeExportKey, legacySendPrimitives: false }
        }

        const urls = new Set()
        for (const script of document.querySelectorAll('script[src]')) urls.add(script.src)
        for (const entry of performance.getEntriesByType('resource')) {
          if (entry?.name) urls.add(entry.name)
        }
        for (const url of urls) {
          if (!/\/_app\/immutable\/chunks\/[^/]+\.js(?:\?|$)/.test(url)) continue
          try {
            const module = await import(url)
            const descriptor = describeModule(module, url)
            if (descriptor) {
              window.__crmMaxCoreModule = descriptor
              return window.__crmMaxCoreModule
            }
          } catch {}
        }
        return null
      }

      try {
        const core = await findCoreModule()
        if (!core) return { ok: false, reason: 'max_web_core_not_found', candidates: [] }
        const requestedChatKey = BigInt(String(args.chatId))
        const uiRouteKey = BigInt(String(args.uiRouteId))
        let routeMatches = Array.from(core.store.chats.values || []).filter(candidate => {
          try {
            return BigInt.asUintN(32, BigInt(candidate?.id)) === uiRouteKey
          } catch {
            return false
          }
        })
        if (routeMatches.length > 1) {
          return { ok: false, reason: 'max_web_chat_route_ambiguous', candidates: [] }
        }
        const chat = routeMatches.length === 1
          ? routeMatches[0]
          : await core.store.chats.getLazy(requestedChatKey)
        if (!chat) return { ok: false, reason: 'max_web_chat_not_loaded', candidates: [] }
        const chatKey = chat.id
        try {
          const normalizedChatKey = BigInt(chatKey)
          if ((normalizedChatKey !== requestedChatKey && normalizedChatKey !== uiRouteKey)
            || BigInt.asUintN(32, normalizedChatKey) !== uiRouteKey) {
            return { ok: false, reason: 'max_web_chat_route_mismatch', candidates: [] }
          }
        } catch {
          return { ok: false, reason: 'max_web_chat_route_mismatch', candidates: [] }
        }
        routeMatches = Array.from(core.store.chats.values || []).filter(candidate => {
          try {
            return BigInt.asUintN(32, BigInt(candidate?.id)) === uiRouteKey
          } catch {
            return false
          }
        })
        if (routeMatches.length > 1
          || (routeMatches.length === 1
            && ![requestedChatKey, uiRouteKey].includes(BigInt(routeMatches[0]?.id)))) {
          return { ok: false, reason: 'max_web_chat_route_ambiguous', candidates: [] }
        }
        const routeMatchCount = 1

        let historyFrom = null
        try { historyFrom = chat.lastMessage?.time ?? null } catch {}
        if (historyFrom == null && Number.isFinite(args.sentAt)) historyFrom = args.sentAt
        if (historyFrom != null && core.storeExportKey === 'Wa' && typeof core.module.ro === 'function') {
          await core.module.ro({ chat, from: historyFrom })
        }

        const providerMessages = core.store.messages?.get
          ? Array.from(core.store.messages.get(chatKey).values || [])
          : []
        const messagesById = new Map()
        for (const message of [
          ...Array.from(chat.messages || []),
          ...providerMessages,
        ]) {
          try {
            if (message?.id == null) continue
            messagesById.set(BigInt.asUintN(64, BigInt(message.id)).toString(), message)
          } catch {}
        }
        const messages = Array.from(messagesById.values()).slice(-200)
        const candidates = []
        for (const message of messages) {
          try {
            if (message?.id == null || BigInt(message.id) === 0n) continue
            let replyToId = null
            let quotedText = ''
            if (message?.link?.id != null && BigInt(message.link.id) !== 0n) {
              replyToId = BigInt.asUintN(64, BigInt(message.link.id)).toString()
              quotedText = messagesById.get(replyToId)?.text?.plain || ''
            }
            candidates.push({
              id: BigInt.asUintN(64, BigInt(message.id)).toString(),
              text: message.text?.plain || '',
              timestamp: Number(message.time) || null,
              isOutgoing: Boolean(message.isOut),
              replyToId,
              quotedText,
              attachmentCount: Array.isArray(message.attaches) ? message.attaches.length : 0,
              messageType: Array.isArray(message.attaches) && message.attaches.length > 0
                ? String(message.attaches[0]?._type || message.attaches[0]?.type || 'attachment').toLowerCase()
                : 'text',
            })
          } catch {}
        }
        return {
          ok: true,
          candidates,
          providerChatId: String(chatKey),
          routeMatchCount,
        }
      } catch (error) {
        return { ok: false, reason: String(error?.message || error), candidates: [] }
      }
    }, {
      chatId: String(chatId),
      uiRouteId,
      sentAt: timestampMs(context?.sentAt),
    })

    if (!result?.ok) throw new Error(`MAX reply target lookup failed: ${result?.reason || 'unknown'}`)
    return {
      candidates: result.candidates || [],
      providerChatId: result.providerChatId || null,
      routeMatchCount: Number(result.routeMatchCount) || 0,
    }
  }

  async resolveProviderId(chatId, context, options = {}) {
    const lookup = await this.readCandidates(chatId, context, options)
    const candidates = lookup.candidates
    const expectedText = normalizeReplyText(context?.text)
    const expectedDirection = context?.direction === 'outbound'
      ? true
      : (context?.direction === 'inbound' ? false : null)
    const expectedTime = timestampMs(context?.sentAt)
    const textMatches = candidates.filter(candidate =>
      normalizeReplyText(candidate?.text) === expectedText
    )
    const directionMatches = textMatches.filter(candidate =>
      expectedDirection === null || Boolean(candidate?.isOutgoing) === expectedDirection
    )
    const timeWindowMatches = directionMatches.filter(candidate => {
      if (expectedTime === null) return true
      const candidateTime = timestampMs(candidate?.timestamp)
      return candidateTime !== null && Math.abs(candidateTime - expectedTime) <= 120_000
    })
    return {
      ...selectReplyTargetCandidate(candidates, context, options),
      candidateCount: candidates.length,
      textMatchCount: textMatches.length,
      directionMatchCount: directionMatches.length,
      timeWindowMatchCount: timeWindowMatches.length,
      providerChatId: lookup.providerChatId,
      routeMatchCount: lookup.routeMatchCount,
    }
  }

  async snapshotProviderMessageIds(chatId, options = {}) {
    const lookup = await this.readCandidates(chatId, {}, options)
    const providerMessageIds = new Set()
    for (const candidate of lookup.candidates) {
      try {
        providerMessageIds.add(providerIdFromDecimal(candidate.id))
      } catch {}
    }
    return Array.from(providerMessageIds).sort()
  }

  async resolveInboundReply(chatId, context, options = {}) {
    const lookup = await this.readCandidates(chatId, context, options)
    return {
      ...selectInboundReplyCandidate(lookup.candidates, context, options),
      providerChatId: lookup.providerChatId,
      routeMatchCount: lookup.routeMatchCount,
    }
  }

  async sendReply(chatId, text, providerMessageId, cid, options = {}) {
    if (!this.page) throw new Error('MAX Web page is not available')
    const replyId = providerDecimalFromId(providerMessageId)
    const rawUiRouteId = String(options.uiChatId || '').trim()
    const uiRouteId = /^\d{1,10}$/.test(rawUiRouteId)
      ? rawUiRouteId
      : uiRouteIdFromProviderChatId(chatId)
    const result = await this.page.evaluate(async args => {
      const findCoreModule = async () => {
        const cached = window.__crmMaxCoreModule
        if (cached?.store?.chats && cached?.store?.messages) return cached

        const describeModule = (module, url) => {
          const legacyStore = module?.Wa
          if (legacyStore?.chats && legacyStore?.messages) {
            return { module, url, store: legacyStore, storeExportKey: 'Wa', legacySendPrimitives: true }
          }
          const storeMatches = Object.entries(module || {}).filter(([, value]) => {
            try {
              return value !== null && typeof value === 'object' &&
                typeof value.chats?.getLazy === 'function' &&
                typeof value.messages?.get === 'function' &&
                value.profile != null
            } catch {
              return false
            }
          })
          if (storeMatches.length !== 1) return null
          const [storeExportKey, store] = storeMatches[0]
          return { module, url, store, storeExportKey, legacySendPrimitives: false }
        }

        const urls = new Set()
        for (const script of document.querySelectorAll('script[src]')) urls.add(script.src)
        for (const entry of performance.getEntriesByType('resource')) {
          if (entry?.name) urls.add(entry.name)
        }
        for (const url of urls) {
          if (!/\/_app\/immutable\/chunks\/[^/]+\.js(?:\?|$)/.test(url)) continue
          try {
            const module = await import(url)
            const descriptor = describeModule(module, url)
            if (descriptor) {
              window.__crmMaxCoreModule = descriptor
              return window.__crmMaxCoreModule
            }
          } catch {}
        }
        return null
      }

      try {
        const core = await findCoreModule()
        if (!core) return { ok: false, reason: 'max_web_core_not_found' }
        if (!core.legacySendPrimitives || typeof core.module.$i !== 'function' || !core.module.Es || !core.module.ws) {
          return { ok: false, reason: 'max_web_reply_sender_not_supported' }
        }
        const requestedChatKey = BigInt(String(args.chatId))
        const uiRouteKey = BigInt(String(args.uiRouteId))
        const replyKey = BigInt(args.replyId)
        let routeMatches = Array.from(core.store.chats.values || []).filter(candidate => {
          try {
            return BigInt.asUintN(32, BigInt(candidate?.id)) === uiRouteKey
          } catch {
            return false
          }
        })
        if (routeMatches.length > 1) {
          return { ok: false, reason: 'max_web_chat_route_ambiguous' }
        }
        const chat = routeMatches.length === 1
          ? routeMatches[0]
          : await core.store.chats.getLazy(requestedChatKey)
        if (!chat) return { ok: false, reason: 'max_web_chat_not_loaded' }
        const chatKey = chat.id
        try {
          const normalizedChatKey = BigInt(chatKey)
          if ((normalizedChatKey !== requestedChatKey && normalizedChatKey !== uiRouteKey)
            || BigInt.asUintN(32, normalizedChatKey) !== uiRouteKey) {
            return { ok: false, reason: 'max_web_chat_route_mismatch' }
          }
        } catch {
          return { ok: false, reason: 'max_web_chat_route_mismatch' }
        }
        routeMatches = Array.from(core.store.chats.values || []).filter(candidate => {
          try {
            return BigInt.asUintN(32, BigInt(candidate?.id)) === uiRouteKey
          } catch {
            return false
          }
        })
        if (routeMatches.length > 1
          || (routeMatches.length === 1
            && ![requestedChatKey, uiRouteKey].includes(BigInt(routeMatches[0]?.id)))) {
          return { ok: false, reason: 'max_web_chat_route_ambiguous' }
        }

        let target = Array.from(chat.messages || []).find(message => {
          try { return BigInt.asUintN(64, BigInt(message?.id)) === replyKey } catch { return false }
        })
        if (!target && core.store.messages?.get) {
          try { target = await core.store.messages.get(chatKey).getLazy(replyKey) } catch {}
        }
        if (!target) return { ok: false, reason: 'max_web_reply_target_not_loaded' }

        const providerStore = core.store.messages.get(chatKey)
        const beforeProviderIds = new Set(
          Array.from(providerStore.values || []).map(message => {
            try { return BigInt.asUintN(64, BigInt(message?.id)).toString() } catch { return null }
          }).filter(Boolean),
        )
        const draft = new core.module.Es(chatKey, {
          text: String(args.text),
          saveTime: Date.now(),
          replyTo: replyKey,
        })
        const pending = new core.module.ws(draft)
        pending.id = BigInt(args.cid)
        await core.module.$i({ chat, message: pending })

        const normalizeText = value => String(value || '')
          .replace(/\u00a0/g, ' ')
          .replace(/\r\n/g, '\n')
          .trim()
        const expectedText = normalizeText(args.text)
        const confirmedCandidates = []
        for (const message of Array.from(providerStore.values || [])) {
          try {
            const providerNumericId = BigInt.asUintN(64, BigInt(message?.id))
            const providerHex = providerNumericId.toString(16).padStart(16, '0')
            if (!providerHex.startsWith('01')) continue
            if (!message?.isOut) continue
            if (normalizeText(message?.text?.plain) !== expectedText) continue
            if (BigInt.asUintN(64, BigInt(message?.link?.id)) !== replyKey) continue
            const id = providerNumericId.toString()
            confirmedCandidates.push({ id, isNew: !beforeProviderIds.has(id) })
          } catch {}
        }
        const newCandidates = confirmedCandidates.filter(candidate => candidate.isNew)
        const confirmedProviderId = newCandidates.length === 1
          ? newCandidates[0].id
          : (confirmedCandidates.length === 1 ? confirmedCandidates[0].id : null)
        return {
          ok: true,
          cid: String(pending.cid),
          providerMessageDecimal: confirmedProviderId,
          providerCandidateCount: confirmedCandidates.length,
        }
      } catch (error) {
        return { ok: false, reason: String(error?.message || error) }
      }
    }, {
      chatId: String(chatId),
      uiRouteId,
      replyId,
      text: String(text),
      cid: String(cid),
    })

    if (!result?.ok) throw new Error(`MAX Web reply send failed: ${result?.reason || 'unknown'}`)
    const confirmedProviderMessageId = result.providerMessageDecimal
      ? providerIdFromDecimal(result.providerMessageDecimal)
      : null
    return { ...result, providerMessageId: confirmedProviderMessageId }
  }
}

module.exports = {
  MaxWebReplyBridge,
  normalizeReplyText,
  providerDecimalFromId,
  providerIdFromDecimal,
  selectInboundReplyCandidate,
  selectReplyTargetCandidate,
  uiRouteIdFromProviderChatId,
}
