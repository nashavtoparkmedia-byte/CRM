'use strict'

/**
 * Proof that DOM-recovered text was read from the conversation it is forwarded for.
 *
 * The scraper reads fallback text from one shared browser page that UI sends, phone
 * lookups, reloads and other recoveries also move. A DOM candidate may only be attested
 * when the page provably showed exactly `/<uiRouteId>` before, during and after the one
 * page task that read it, with no navigation, UI send or phone-lookup dialog in between.
 * Anything else yields `verified: false`; the CRM then refuses to bind the text to a
 * person, exactly as it does for an unattested event.
 */

const MIN_NAVIGATION_QUIET_MS = 500

function exactUiRoutePath(url, uiRouteId) {
  const route = String(uiRouteId ?? '')
  if (!/^\d{1,20}$/.test(route)) return false
  try {
    return new URL(String(url ?? '')).pathname === `/${route}`
  } catch {
    return false
  }
}

function exactRoutePathname(pathname, uiRouteId) {
  const route = String(uiRouteId ?? '')
  return /^\d{1,20}$/.test(route) && pathname === `/${route}`
}

/**
 * One sample of the shared page state around the DOM read.
 * `page` state is passed in explicitly so the fold stays a pure function.
 */
function pageSample({ url, uiRouteId, uiSendInProgress, dialogBusy, uiSendEpoch, navigationEpoch, lastNavigationAt, now }) {
  return {
    onRoute: exactUiRoutePath(url, uiRouteId),
    idle: uiSendInProgress === false && dialogBusy === false,
    uiSendEpoch,
    navigationEpoch,
    quietMs: Number.isFinite(lastNavigationAt) && Number.isFinite(now) ? now - lastNavigationAt : -1,
  }
}

function attestDomRead({ uiRouteId, before, readPathname, after }) {
  return Boolean(
    before && after
      && before.onRoute && after.onRoute
      && before.idle && after.idle
      && before.quietMs >= MIN_NAVIGATION_QUIET_MS
      && Number.isInteger(before.uiSendEpoch) && before.uiSendEpoch === after.uiSendEpoch
      && Number.isInteger(before.navigationEpoch) && before.navigationEpoch === after.navigationEpoch
      && exactRoutePathname(readPathname, uiRouteId),
  )
}

/** A candidate is a message element only when the element itself is a message wrapper. */
function domCandidateExtraction(isMessageWrapper) {
  return isMessageWrapper === true ? 'message_element' : 'generic_text_rows'
}

module.exports = {
  MIN_NAVIGATION_QUIET_MS,
  attestDomRead,
  domCandidateExtraction,
  exactRoutePathname,
  exactUiRoutePath,
  pageSample,
}
