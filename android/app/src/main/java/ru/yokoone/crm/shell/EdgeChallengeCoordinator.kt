package ru.yokoone.crm.shell

/**
 * Challenge handling rules A–F of R5.1 §3.3, without a WebView.
 *
 * MainActivity adapts `onReceivedHttpAuthRequest` to [Challenge] and implements
 * [Ui]; everything that decides whether a challenge is answered, queued,
 * refused or turned into a reset is here, where a unit test can drive it.
 *
 * Rule G (acceptance) is entered through [markAuthenticated]; rule H (gate
 * absent) and the session-dependent parts of rule G live in MainActivity
 * because they depend on page and cookie state.
 */
class EdgeChallengeCoordinator(
    private val ui: Ui,
    private val holder: EdgeCredentialHolder = EdgeCredentialHolder,
) {

    /** One `HttpAuthHandler` with the host and realm it arrived with. */
    interface Challenge {
        val host: String?
        val realm: String?

        /** `HttpAuthHandler.useHttpAuthUsernamePassword()`: false once this request's credential was rejected. */
        fun useStoredCredential(): Boolean
        fun proceed(username: String, password: String)
        fun cancel()
    }

    interface Ui {
        /** ORIGIN https and the DIRECT proxy override confirmed. */
        fun preconditionsMet(): Boolean

        /** The challenge named the staff gate; persist `edge_gate = PRESENT`. */
        fun onStaffGateSeen()

        /**
         * IMPL-1: false when this process carries a CRM session established
         * without an edge principal; the challenge is then cancelled and the
         * context reset (CONTINUITY_MISMATCH) before any credential is sent.
         */
        fun mayAnswerStaffChallenge(): Boolean

        fun openDialog(wrongPassword: Boolean)
        fun closeDialog()

        /** Rule F: stop loading, pause the page, show the panel for [state]. */
        fun stopAfterDecline(state: EdgeState)

        /** A staff challenge refused because the preconditions do not hold. */
        fun onUnavailable()

        /** A credential was handed to Chromium for a challenge. */
        fun onProceeded()

        /** The dialog filled the holder and nothing was queued (bootstrap prompt). */
        fun onCredentialReady()

        fun requestReset(reason: String)

        fun diagnostic(line: String)
    }

    enum class EdgeState { UNKNOWN, REQUIRED, PROMPTING, AUTHENTICATING, AUTHENTICATED, DECLINED, EXHAUSTED, UNAVAILABLE }

    var state: EdgeState = EdgeState.UNKNOWN
        private set

    /** Whether the edge ever reached AUTHENTICATED in this process (rule E refusal ⇒ reset). */
    var everAuthenticated: Boolean = false
        private set

    /** Whether any staff challenge arrived in this process (rule H, IMPL-1). */
    var staffChallengeSeen: Boolean = false
        private set

    var prompts: Int = 0
        private set

    var autoAnswers: Int = 0
        private set

    private val queue = ArrayList<Challenge>()

    val queued: Int get() = queue.size

    fun onChallenge(challenge: Challenge) {
        val host = challenge.host
        val realm = challenge.realm
        val staff = EdgeAuthPolicy.isStaffGate(host, realm)
        if (staff) {
            staffChallengeSeen = true
            ui.onStaffGateSeen()
        }

        // Rule A.
        val refusal = EdgeAuthPolicy.refusal(host, realm, ui.preconditionsMet())
        if (refusal != null) {
            challenge.cancel()
            ui.diagnostic("edge-auth refused reason=${refusal.name.lowercase()}")
            if (staff && refusal == EdgeAuthPolicy.Refusal.PRECONDITION && state != EdgeState.UNAVAILABLE) {
                state = EdgeState.UNAVAILABLE
                ui.onUnavailable()
            }
            return
        }

        if (!ui.mayAnswerStaffChallenge()) {
            challenge.cancel()
            cancelQueued()
            ui.requestReset(EdgeContextReset.Reason.CONTINUITY_MISMATCH)
            return
        }

        if (holder.refusedByRegistrar && everAuthenticated) {
            challenge.cancel()
            cancelQueued()
            ui.requestReset(EdgeContextReset.Reason.EDGE_CREDENTIAL_REFUSED)
            return
        }

        // Rule B.
        if (state == EdgeState.DECLINED || state == EdgeState.EXHAUSTED || state == EdgeState.UNAVAILABLE) {
            challenge.cancel()
            return
        }

        // Rule C: while prompting, everything waits for the one dialog.
        if (state == EdgeState.PROMPTING) {
            queue += challenge
            return
        }

        if (holder.isPresent && holder.isExpired()) {
            if (holder.isAccepted) {
                challenge.cancel()
                cancelQueued()
                ui.requestReset(EdgeContextReset.Reason.EDGE_MAX_AGE)
                return
            }
            holder.clear()
        }

        if (!holder.isPresent) {
            queue += challenge
            prompt(wrongPassword = false)
            return
        }

        // Rule E.
        if (challenge.useStoredCredential() && autoAnswers < EdgeAuthPolicy.MAX_AUTO_ANSWERS_PER_NAVIGATION) {
            autoAnswers += 1
            if (!answer(challenge)) {
                // Expired at this very tick (T90): never proceed with it.
                if (holder.isAccepted) {
                    challenge.cancel()
                    cancelQueued()
                    ui.requestReset(EdgeContextReset.Reason.EDGE_MAX_AGE)
                    return
                }
                holder.clear()
                queue += challenge
                prompt(wrongPassword = false)
            }
            return
        }

        if (everAuthenticated) {
            // An accepted credential is refused now: rotation or revocation.
            challenge.cancel()
            cancelQueued()
            holder.clear()
            ui.requestReset(EdgeContextReset.Reason.EDGE_CREDENTIAL_REFUSED)
            return
        }

        // Wrong password typed now.
        holder.clear()
        queue += challenge
        if (prompts >= EdgeAuthPolicy.MAX_PROMPTS_PER_NAVIGATION) {
            stop(EdgeState.EXHAUSTED)
        } else {
            prompt(wrongPassword = true)
        }
    }

    /** Pre-emptive prompt of the continuity barrier (§5.8.3 step 4). */
    fun promptPreemptively() {
        if (state == EdgeState.PROMPTING) return
        prompt(wrongPassword = false)
    }

    /** Rule D, «Войти». */
    fun onDialogSubmit(username: String, password: CharArray) {
        val pinned = holder.pinnedUsername
        // In pinned mode the dialog shows the username read-only; enforce it here too.
        val effective = pinned ?: username
        holder.set(effective, password)
        prompts += 1
        state = EdgeState.AUTHENTICATING
        if (queue.isEmpty()) {
            ui.onCredentialReady()
            return
        }
        val pending = ArrayList(queue)
        queue.clear()
        for (challenge in pending) {
            if (!answer(challenge)) {
                challenge.cancel()
            }
        }
    }

    /** Rule D, «Отмена» ⇒ rule F with DECLINED. */
    fun onDialogCancel() {
        stop(EdgeState.DECLINED)
    }

    /** Rule G entry. Returns true on the transition into AUTHENTICATED. */
    fun markAuthenticated(): Boolean {
        if (state != EdgeState.AUTHENTICATING || queue.isNotEmpty()) return false
        if (!holder.isPresent) return false
        state = EdgeState.AUTHENTICATED
        holder.markAccepted()
        everAuthenticated = true
        return true
    }

    /** Operator-initiated navigation (tap, notification, «Повторить», «Войти»). */
    fun onOperatorNavigation() {
        prompts = 0
        autoAnswers = 0
    }

    /** «Войти» on a rule F panel: counters reset, state REQUIRED. */
    fun resumeAfterStop() {
        prompts = 0
        autoAnswers = 0
        state = EdgeState.REQUIRED
    }

    /** onPause: dismiss and clear the dialog, cancel queued, REQUIRED (§3.6). Returns true if a dialog was open. */
    fun onPause(): Boolean {
        if (state != EdgeState.PROMPTING) return false
        ui.closeDialog()
        cancelQueued()
        state = EdgeState.REQUIRED
        return true
    }

    /** onStop: an unaccepted credential does not survive (F-1). Returns true if it was cleared. */
    fun onStop(): Boolean {
        val cleared = holder.onStop()
        if (cleared) {
            cancelQueued()
            if (state == EdgeState.AUTHENTICATING || state == EdgeState.PROMPTING) state = EdgeState.REQUIRED
        }
        return cleared
    }

    /** The 5-minute timer of an unaccepted credential fired while STARTED. */
    fun onUnacceptedExpiry(): Boolean {
        if (!holder.isPresent || holder.isAccepted || !holder.isExpired()) return false
        holder.clear()
        cancelQueued()
        if (state == EdgeState.AUTHENTICATING || state == EdgeState.PROMPTING) state = EdgeState.REQUIRED
        return true
    }

    /** Reset step 1. */
    fun clearForReset() {
        if (state == EdgeState.PROMPTING) ui.closeDialog()
        cancelQueued()
        holder.clear()
        state = EdgeState.UNKNOWN
    }

    private fun prompt(wrongPassword: Boolean) {
        state = EdgeState.PROMPTING
        ui.openDialog(wrongPassword)
    }

    private fun stop(terminal: EdgeState) {
        cancelQueued()
        state = terminal
        ui.stopAfterDecline(terminal)
    }

    private fun answer(challenge: Challenge): Boolean =
        holder.proceedWith { username, password ->
            holder.pinIfFirst(username)
            challenge.proceed(username, password)
            if (state != EdgeState.AUTHENTICATED) state = EdgeState.AUTHENTICATING
            ui.onProceeded()
        }

    private fun cancelQueued() {
        val pending = ArrayList(queue)
        queue.clear()
        for (challenge in pending) challenge.cancel()
    }
}
