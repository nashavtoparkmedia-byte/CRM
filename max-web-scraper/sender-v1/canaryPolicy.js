'use strict'

const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

function exactSet(values, pattern = ACCOUNT_PATTERN) {
  const result = new Set(values || [])
  if ([...result].some(value => typeof value !== 'string' || value === '*' || !pattern.test(value))) throw new Error('Canary allowlist is invalid')
  return result
}

function canaryConversationScope(accountId, conversationKey) {
  return `${accountId.length}:${accountId}${conversationKey.length}:${conversationKey}`
}

class TextCanaryPolicy {
  constructor(configuration = {}) {
    this.physicalSenderEnabled = configuration.physicalSenderEnabled === true
    this.globalPhysicalSenderDisabled = configuration.globalPhysicalSenderDisabled !== false
    this.globalEmergencyStop = configuration.globalEmergencyStop !== false
    this.accountAllowlist = exactSet(configuration.accountAllowlist)
    this.conversationAllowlist = exactSet(configuration.conversationAllowlist, /^[^\p{Cc}]{1,512}$/u)
    this.allowAuthorizedConversations = configuration.allowAuthorizedConversations === true
    this.disabledAccounts = exactSet(configuration.disabledAccounts)
    this.disabledConversations = exactSet(configuration.disabledConversations, /^[^\p{Cc}]{1,512}$/u)
    this.maximumAccounts = configuration.maximumAccounts ?? 1
    this.maximumConversations = configuration.maximumConversations ?? 1
    this.dailyMessageLimit = configuration.dailyMessageLimit ?? 3
    this.staleFenceRejectionThreshold = configuration.staleFenceRejectionThreshold ?? 1
    this.repeatedRestartThreshold = configuration.repeatedRestartThreshold ?? 2
    this.stopAfterFirstUnknown = configuration.stopAfterFirstUnknown !== false
    this.stopAfterRouteConflict = configuration.stopAfterRouteConflict !== false
    this.stopAfterWrongAccount = configuration.stopAfterWrongAccount !== false
    for (const [value, field, maximum] of [[this.maximumAccounts, 'maximumAccounts', 10], [this.maximumConversations, 'maximumConversations', 100],
      [this.dailyMessageLimit, 'dailyMessageLimit', 1000], [this.staleFenceRejectionThreshold, 'staleFenceRejectionThreshold', 100],
      [this.repeatedRestartThreshold, 'repeatedRestartThreshold', 100]]) {
      if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new Error(`${field} is invalid`)
    }
    this.calls = 0
    this.unknownStopped = false
    this.routeConflictStopped = false
    this.wrongAccountStopped = false
    this.staleFenceRejects = 0
    this.restartCount = 0
  }

  conversationScope(request) { return canaryConversationScope(request.accountId, request.conversationKey) }

  evaluate(request) {
    if (!this.physicalSenderEnabled || this.globalPhysicalSenderDisabled) return 'GLOBAL_PHYSICAL_SENDER_DISABLED'
    if (this.globalEmergencyStop) return 'GLOBAL_EMERGENCY_STOP'
    if (this.accountAllowlist.size === 0 || this.accountAllowlist.size > this.maximumAccounts || !this.accountAllowlist.has(request.accountId)) return 'ACCOUNT_NOT_ALLOWLISTED'
    if (this.disabledAccounts.has(request.accountId)) return 'ACCOUNT_KILL_SWITCH'
    const scope = this.conversationScope(request)
    if (!this.allowAuthorizedConversations
      && (this.conversationAllowlist.size === 0 || this.conversationAllowlist.size > this.maximumConversations || !this.conversationAllowlist.has(scope))) return 'CONVERSATION_NOT_ALLOWLISTED'
    if (this.disabledConversations.has(scope)) return 'CONVERSATION_KILL_SWITCH'
    if (this.unknownStopped) return 'STOPPED_AFTER_UNKNOWN'
    if (this.routeConflictStopped) return 'STOPPED_AFTER_ROUTE_CONFLICT'
    if (this.wrongAccountStopped) return 'STOPPED_AFTER_WRONG_ACCOUNT'
    if (this.staleFenceRejects >= this.staleFenceRejectionThreshold) return 'STOPPED_AFTER_STALE_FENCE_THRESHOLD'
    if (this.restartCount >= this.repeatedRestartThreshold) return 'STOPPED_AFTER_REPEATED_RESTART'
    if (this.calls >= this.dailyMessageLimit) return 'DAILY_MESSAGE_LIMIT'
    return null
  }

  recordBoundaryCall() { this.calls += 1 }
  recordOutcome(outcome) { if (outcome === 'UNKNOWN_AFTER_ATTEMPT' && this.stopAfterFirstUnknown) this.unknownStopped = true }
  recordSafetySignal(signal) {
    if (signal === 'ROUTE_CONFLICT' && this.stopAfterRouteConflict) this.routeConflictStopped = true
    if (signal === 'WRONG_ACCOUNT' && this.stopAfterWrongAccount) this.wrongAccountStopped = true
    if (signal === 'STALE_FENCE') this.staleFenceRejects += 1
  }
  recordRestart() { this.restartCount += 1 }
}

module.exports = { TextCanaryPolicy, canaryConversationScope }
