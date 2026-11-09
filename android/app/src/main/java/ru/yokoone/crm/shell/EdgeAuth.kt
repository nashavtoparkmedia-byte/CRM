package ru.yokoone.crm.shell

import android.app.Activity
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.annotation.VisibleForTesting
import androidx.core.content.ContextCompat
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewFeature
import java.util.Base64

/**
 * Which edge challenges the shell may answer at all (R5.1 §3.1, §3.2).
 *
 * Pure and JVM-testable. The callback that delivers a challenge gives only a
 * host and a realm, so the policy never tries to tell an origin challenge from
 * a proxy challenge: the WebView is forced DIRECT ([EdgeProxyGuard]) and nothing
 * is answered until that is confirmed, the origin is a compile-time https pin,
 * and then host and realm only select the one staff gate this shell is for.
 */
object EdgeAuthPolicy {

    const val EDGE_REALM = "YOKO CRM"

    /** The pinned apex host. `www` is rendered in-app but never answered. */
    val PINNED_HOST: String = Uri.parse(CrmOrigin.ORIGIN).host.orEmpty().lowercase()

    /** R9: a build whose origin is not https answers no challenge at all. */
    val ORIGIN_IS_HTTPS: Boolean = CrmOrigin.ORIGIN.startsWith("https://")

    const val MAX_PROMPTS_PER_NAVIGATION = 3
    const val MAX_AUTO_ANSWERS_PER_NAVIGATION = 8

    /** The release value the unit tests pin (T36). */
    const val RELEASE_EDGE_MAX_AGE_MS = 43_200_000L

    /** Accepted context lifetime, measured from fill (F-1). Acceptance may shorten it. */
    const val EDGE_MAX_AGE_MS: Long = BuildConfig.EDGE_MAX_AGE_MS

    /** An unaccepted credential is usable this long, and only until the next onStop. */
    const val UNACCEPTED_MAX_MS = 5 * 60 * 1000L

    /** The cookie-less edge probe of the continuity barrier (§5.8.3 step 4). */
    const val PROBE_PATH = "/favicon.ico"

    enum class Refusal { HOST, REALM, PRECONDITION }

    enum class Kind401 { EDGE, MOBILE_SESSION, OTHER }

    fun preconditions(proxyOverrideConfirmed: Boolean, originIsHttps: Boolean = ORIGIN_IS_HTTPS): Boolean =
        originIsHttps && proxyOverrideConfirmed

    /** Why a challenge is refused, or null when it may be answered (rule A). */
    fun refusal(
        host: String?,
        realm: String?,
        preconditionsMet: Boolean,
        pinnedHost: String = PINNED_HOST,
    ): Refusal? {
        if (!preconditionsMet) return Refusal.PRECONDITION
        if (host == null || pinnedHost.isEmpty() || !host.equals(pinnedHost, ignoreCase = true)) {
            return Refusal.HOST
        }
        if (realm != EDGE_REALM) return Refusal.REALM
        return null
    }

    fun acceptsChallenge(
        host: String?,
        realm: String?,
        preconditionsMet: Boolean,
        pinnedHost: String = PINNED_HOST,
    ): Boolean = refusal(host, realm, preconditionsMet, pinnedHost) == null

    /**
     * Whether a challenge names the staff gate, whatever the preconditions.
     *
     * Used only to remember that the gate exists, which makes the native lane
     * stricter (it then defers instead of sending without a credential). It
     * never decides whether a credential is sent.
     */
    fun isStaffGate(host: String?, realm: String?, pinnedHost: String = PINNED_HOST): Boolean =
        host != null && pinnedHost.isNotEmpty() && host.equals(pinnedHost, ignoreCase = true) && realm == EDGE_REALM

    /**
     * `WWW-Authenticate: Basic …` is nginx; a 401 without it on `/api/` is the
     * CRM's mobile session answer; anything else is neither.
     */
    fun classify401(headers: Map<String, String>?, url: String?): Kind401 {
        val challenge = headers?.entries
            ?.firstOrNull { it.key.equals("WWW-Authenticate", ignoreCase = true) }
            ?.value
            ?.trim()
            .orEmpty()
        if (challenge.regionMatches(0, "Basic", 0, 5, ignoreCase = true)) return Kind401.EDGE
        if (url != null && CrmOrigin.isInAppUrl(url) && Uri.parse(url).path.orEmpty().startsWith("/api/")) {
            return Kind401.MOBILE_SESSION
        }
        return Kind401.OTHER
    }

    /** True for an https URL on exactly the pinned host and port; the native header goes nowhere else. */
    fun isPinnedHttpsEndpoint(url: String?): Boolean {
        val uri = runCatching { Uri.parse(url ?: return false) }.getOrNull() ?: return false
        if (!"https".equals(uri.scheme, ignoreCase = true)) return false
        if (!ORIGIN_IS_HTTPS) return false
        if (uri.port != Uri.parse(CrmOrigin.ORIGIN).port) return false
        return uri.host.equals(PINNED_HOST, ignoreCase = true)
    }

    fun probeUrl(): String = CrmOrigin.ORIGIN + PROBE_PATH

    fun isProbeUrl(url: String?): Boolean {
        if (url == null || !CrmOrigin.isInAppUrl(url)) return false
        val uri = Uri.parse(url)
        return uri.path == PROBE_PATH && uri.host.equals(PINNED_HOST, ignoreCase = true)
    }
}

/** Process-wide foreground flag; single-activity app, set by MainActivity.onStart/onStop. */
object ShellForeground {
    @Volatile
    var started: Boolean = false
}

/**
 * The staff credential, in memory only, for the lifetime rules of F-1.
 *
 * Never persisted, never logged, never in a Bundle, Intent, preference or URL.
 * `toString` names the class and nothing else. Age is measured on the monotonic
 * clock from the moment the dialog filled it: an unaccepted credential lives at
 * most five minutes and only until the next onStop; an accepted one at most
 * twelve hours from fill. Nothing renews the fill time except a new [set].
 *
 * The username of the first `proceed()` in this process is pinned (F-2) and is
 * cleared only by the process ending.
 */
object EdgeCredentialHolder {

    private const val MISSING = -1L

    @Volatile
    @VisibleForTesting
    var clock: () -> Long = { SystemClock.elapsedRealtime() }

    private val lock = Any()

    private var user: String? = null
    private var password: CharArray? = null
    private var filledAtElapsed: Long = MISSING
    private var acceptedAtElapsed: Long = MISSING

    /** Set at the first proceed() of this process; never cleared except by process end. */
    @Volatile
    var pinnedUsername: String? = null
        private set

    /**
     * The native lane saw an accepted credential refused (§4.1 item 4). The
     * activity resets EDGE_CREDENTIAL_REFUSED at its next challenge or onStart.
     */
    @Volatile
    var refusedByRegistrar: Boolean = false

    /** Copy the typed values in and wipe the caller's array. */
    fun set(username: String, typed: CharArray, now: Long = clock()) = synchronized(lock) {
        wipe()
        user = username
        password = typed.copyOf()
        typed.fill('\u0000')
        filledAtElapsed = now
    }

    val isPresent: Boolean get() = synchronized(lock) { user != null && password != null && filledAtElapsed != MISSING }

    val isAccepted: Boolean get() = synchronized(lock) { isPresentLocked() && acceptedAtElapsed != MISSING }

    fun markAccepted(now: Long = clock()) = synchronized(lock) {
        if (isPresentLocked() && acceptedAtElapsed == MISSING) acceptedAtElapsed = now
    }

    /** Pin the username of the first proceed(); later proceeds must use the same one. */
    fun pinIfFirst(username: String) = synchronized(lock) {
        if (pinnedUsername == null) pinnedUsername = username
    }

    fun isExpired(now: Long = clock()): Boolean = synchronized(lock) { isExpiredLocked(now) }

    /** When the current credential stops being usable, on the elapsed clock, or null if absent. */
    fun expiryAtElapsed(): Long? {
        synchronized(lock) {
            if (!isPresentLocked()) return null
            val limit = if (acceptedAtElapsed != MISSING) EdgeAuthPolicy.EDGE_MAX_AGE_MS else EdgeAuthPolicy.UNACCEPTED_MAX_MS
            return filledAtElapsed + limit
        }
    }

    /** Hand the credential to [block] once, or return false if it is absent or expired. */
    fun proceedWith(now: Long = clock(), block: (String, String) -> Unit): Boolean {
        val pair = synchronized(lock) {
            if (isExpiredLocked(now)) return false
            val u = user ?: return false
            val p = password ?: return false
            u to String(p)
        }
        block(pair.first, pair.second)
        return true
    }

    /** The username of the credential now held, for the continuity decision only. */
    fun currentUsername(): String? = synchronized(lock) { if (isPresentLocked()) user else null }

    /**
     * The native lane's header, built per call (§4.1 item 2): only while the
     * activity is STARTED, only for an accepted credential, only within age.
     */
    fun authorizationHeaderOrNull(now: Long = clock()): String? {
        if (!ShellForeground.started) return null
        val pair = synchronized(lock) {
            if (acceptedAtElapsed == MISSING || isExpiredLocked(now)) return null
            val u = user ?: return null
            val p = password ?: return null
            u to String(p)
        }
        val raw = (pair.first + ":" + pair.second).toByteArray(Charsets.UTF_8)
        return "Basic " + Base64.getEncoder().encodeToString(raw)
    }

    /** onStop: an unaccepted credential does not survive backgrounding (F-1). */
    fun onStop(): Boolean = synchronized(lock) {
        if (isPresentLocked() && acceptedAtElapsed == MISSING) {
            wipe()
            true
        } else {
            false
        }
    }

    fun clear() = synchronized(lock) { wipe() }

    @VisibleForTesting
    fun passwordBufferForTest(): CharArray? = synchronized(lock) { password }

    @VisibleForTesting
    fun resetForTest() = synchronized(lock) {
        wipe()
        pinnedUsername = null
        refusedByRegistrar = false
        clock = { SystemClock.elapsedRealtime() }
    }

    override fun toString(): String = "EdgeCredentialHolder"

    private fun isPresentLocked() = user != null && password != null && filledAtElapsed != MISSING

    private fun isExpiredLocked(now: Long): Boolean {
        if (!isPresentLocked()) return true
        if (now < filledAtElapsed) return true
        val age = now - filledAtElapsed
        val limit = if (acceptedAtElapsed != MISSING) EdgeAuthPolicy.EDGE_MAX_AGE_MS else EdgeAuthPolicy.UNACCEPTED_MAX_MS
        return age >= limit
    }

    private fun wipe() {
        password?.fill('\u0000')
        password = null
        user = null
        filledAtElapsed = MISSING
        acceptedAtElapsed = MISSING
    }
}

/**
 * DIRECT-only proxy override for the WebView (§3.2 item 1).
 *
 * Until the override's listener has run, [confirmed] is false and every
 * challenge is refused. Unsupported is permanent for the process; a timeout
 * stays unconfirmed until a retry applies the override again.
 */
object EdgeProxyGuard {

    enum class State { PENDING, CONFIRMED, UNSUPPORTED, TIMEOUT }

    const val TIMEOUT_MS = 3_000L

    @Volatile
    var state: State = State.PENDING
        private set

    val confirmed: Boolean get() = state == State.CONFIRMED

    private var attempt = 0

    /** Apply the override, then call [onReady] exactly once (confirmed, unsupported or timed out). */
    fun apply(activity: Activity, onReady: () -> Unit) {
        if (state == State.CONFIRMED || state == State.UNSUPPORTED) {
            onReady()
            return
        }
        val supported = runCatching { WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE) }
            .getOrDefault(false)
        if (!supported) {
            state = State.UNSUPPORTED
            ShellDiagnostics.write("edge-auth proxy-override unsupported")
            onReady()
            return
        }
        val mine = ++attempt
        var fired = false
        val main = Handler(Looper.getMainLooper())
        val fire = {
            if (!fired) {
                fired = true
                onReady()
            }
        }
        runCatching {
            ProxyController.getInstance().setProxyOverride(
                ProxyConfig.Builder().addDirect().build(),
                ContextCompat.getMainExecutor(activity),
            ) {
                // A listener from an attempt that already timed out is ignored:
                // requests may have started before it, so this process stays
                // unconfirmed until a retry applies the override again.
                if (mine == attempt && !fired) {
                    state = State.CONFIRMED
                    ShellDiagnostics.write("edge-auth proxy-override confirmed")
                    fire()
                }
            }
        }.onFailure {
            state = State.UNSUPPORTED
            ShellDiagnostics.write("edge-auth proxy-override failed ${it.javaClass.simpleName}")
            fire()
            return
        }
        main.postDelayed({
            if (mine == attempt && !fired) {
                state = State.TIMEOUT
                ShellDiagnostics.write("edge-auth proxy-override timeout")
                fire()
            }
        }, TIMEOUT_MS)
    }
}
