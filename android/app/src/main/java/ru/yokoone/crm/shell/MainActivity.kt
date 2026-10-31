package ru.yokoone.crm.shell

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.ConnectivityManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.os.SystemClock
import android.util.Log
import android.view.View
import android.webkit.ConsoleMessage
import android.webkit.CookieManager
import android.webkit.HttpAuthHandler
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebStorage
import android.webkit.WebView
import android.webkit.WebViewClient
import android.webkit.WebViewDatabase
import android.widget.Button
import android.widget.TextView
import android.widget.Toast
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.app.NotificationManagerCompat
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.lifecycle.Lifecycle
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import androidx.work.WorkManager
import ru.yokoone.crm.shell.push.PushRegistrar
import ru.yokoone.crm.shell.push.PushRegistration
import ru.yokoone.crm.shell.push.PushRegistrationWorker
import ru.yokoone.crm.shell.push.PushTokenState
import ru.yokoone.crm.shell.push.TokenActor
import java.io.ByteArrayInputStream
import java.util.concurrent.TimeUnit

/**
 * The whole shell.
 *
 * It renders the deployed CRM Messenger at the pinned origin and adds exactly
 * four things the browser cannot give an operator: a launcher icon, a session
 * that survives the app being killed, a notification that opens a specific
 * conversation, and a readable failure when the CRM is unreachable.
 *
 * It deliberately contains no CRM logic. It does not parse messages, does not
 * know what a chat is beyond an opaque identifier, never marks anything read,
 * and issues no network request of its own — every byte on the wire is the
 * WebView loading the CRM.
 *
 * Edge Basic auth (design R5.1) adds the staff gate in front of the CRM: the
 * challenge rules A–H ([EdgeChallengeCoordinator]), the hardened dialog
 * ([EdgeAuthDialog]), the continuity barrier at every process start
 * ([ContinuityGuard]), and the durable edge context reset that ends the process
 * ([EdgeContextReset]). Nothing in the page is trusted to decide any of it.
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var errorPanel: View
    private lateinit var errorTitle: TextView
    private lateinit var errorText: TextView
    private lateinit var retryButton: Button
    private lateinit var switchButton: Button

    /** URL the shell most recently decided to load; the retry button reuses it. */
    private var currentTargetUrl: String = CrmOrigin.startUrl()

    /**
     * Whether the load now in flight has already failed.
     *
     * `onPageFinished` fires even for a navigation that errored, and it fires
     * AFTER `onReceivedError`, carrying the URL that was being attempted. Without
     * this flag the finish handler saw an in-app URL, called `showContent`, and
     * revealed the WebView's own technical error page — the operator lost the
     * retry screen a fraction of a second after seeing it.
     */
    private var currentLoadFailed = false

    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

    // ── edge auth state (R5.1) ───────────────────────────────────────────

    private val main = Handler(Looper.getMainLooper())
    private lateinit var edgeDialog: EdgeAuthDialog
    private val coordinator = EdgeChallengeCoordinator(EdgeUi())

    /** What the operator asked for while the shell may not load anything yet. */
    private var heldTarget: String? = null
    private var startedFromNotification = false

    /**
     * An explicit load (a notification tap delivered to onNewIntent, a retry)
     * arrived while the start was held. It wins over restored page state, as it
     * did when restoreState ran synchronously in onCreate before onNewIntent.
     */
    private var heldExplicitly = false
    private var pendingSavedState: Bundle? = null

    /** The continuity record's fingerprint while the barrier waits for the probe. */
    private var recordFp: String? = null

    /** The cookie-less edge probe in flight, if any (§5.8.3 step 4). */
    private var probe: Probe? = null

    /** SESSION = VALID was observed in this process. */
    @Volatile
    private var sessionValidSeen = false

    /** The continuity record was written, confirmed or deliberately skipped in this process. */
    private var recordHandled = false


    /** From reset step 0 on, nothing in-app may load or be requested. */
    @Volatile
    private var resetInProgress = false

    private val operatorFence = ShellNavigationGuard.OperatorFence()

    private var mobileReloadAtElapsed = -1L

    /** What the panel's primary button does right now. */
    private var panelAction: (() -> Unit)? = null

    /**
     * An edge panel is on screen and owns it until the operator acts (rule F,
     * guard, unavailable). After a decline or EXHAUSTED, Chromium still finishes
     * the cancelled navigation, and that onPageFinished can arrive before the
     * 401 that marks it failed; without this hold it would hide the panel and
     * leave a blank WebView (found on the B-layer stand, B01/B03).
     */
    private var panelHeld = false

    private class Probe {
        var proceeded = false
        var decided = false
    }

    private val filePicker = registerForActivityResult(
        ActivityResultContracts.StartActivityForResult(),
    ) { result ->
        val callback = fileChooserCallback
        fileChooserCallback = null
        callback?.onReceiveValue(
            WebChromeClient.FileChooserParams.parseResult(result.resultCode, result.data),
        )
    }

    private val notificationPermission = registerForActivityResult(
        ActivityResultContracts.RequestPermission(),
    ) { granted -> if (granted) ShellTestHooks.onNotificationsReady(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Before anything else, and before a WebView exists. If this line is
        // missing from a diagnostic run, nothing downstream can be trusted and
        // the problem is log delivery, not the page.
        ShellDiagnostics.start(this)

        // Draw behind the system bars, then hand the real insets to the layout
        // below. Without this the CRM composer sits under the navigation bar on
        // a gesture-navigation device.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.web_view)
        errorPanel = findViewById(R.id.error_panel)
        errorTitle = findViewById(R.id.error_title)
        errorText = findViewById(R.id.error_text)
        retryButton = findViewById(R.id.error_retry)
        switchButton = findViewById(R.id.error_switch)
        retryButton.setOnClickListener { (panelAction ?: { retry() }).invoke() }
        switchButton.setOnClickListener { requestReset(EdgeContextReset.Reason.OPERATOR_SWITCH, automatic = false) }
        edgeDialog = EdgeAuthDialog(this)

        applyWindowInsets()
        configureWebView()
        installBackHandler()
        ChatNotifications.ensureChannel(this)
        requestNotificationPermissionIfNeeded()

        val fromNotification = consumeDeepLinkUrl(intent)
        // Name which of the three starts this was. A push that arrives after
        // the system has taken the process is the one case where the target can
        // go missing and the screen still looks plausible - the chat list shows
        // the same message as a preview - so the start has to say for itself
        // whether it carried a target. safeUrl keeps the identifier out.
        ShellDiagnostics.write(
            "YOKO_NET fail push-open cold act=${shortName(intent?.action)}" +
                // The flags say whose Intent this is. A launcher tap carries
                // NEW_TASK|RESET_TASK_IF_NEEDED (0x10200000); the notification's
                // carries NEW_TASK|CLEAR_TASK or NEW_TASK|CLEAR_TOP. That is the
                // difference between an Intent that was never ours and one that
                // was ours and arrived stripped.
                " flags=0x${Integer.toHexString(intent?.flags ?: 0)}" +
                " keys=${intent?.extras?.keySet()?.joinToString(",") { shortName(it) } ?: "none"}" +
                " tgt=${ShellDiagnostics.safeUrl(fromNotification)}" +
                " restored=${savedInstanceState != null}",
        )
        intent?.getStringExtra(ResetTrampolineActivity.EXTRA_AFTER_RESET)?.let {
            ShellDiagnostics.write("edge-reset relaunched reason=${EdgeContextReset.Reason.sanitize(it)}")
            intent.removeExtra(ResetTrampolineActivity.EXTRA_AFTER_RESET)
        }

        // A notification tap always wins over restored state: the operator
        // asked for a specific conversation. Otherwise the restored URL, then
        // the remembered one. Each is only a target until the shell may load.
        startedFromNotification = fromNotification != null
        pendingSavedState = savedInstanceState
        heldTarget = fromNotification
            ?: CrmOrigin.sanitizeRestoredUrl(savedInstanceState?.getString(KEY_SAVED_TARGET))
            ?: lastVisitedUrl()
            ?: CrmOrigin.startUrl()

        startup()
    }

    /**
     * §5.3a first (a pending reset is completed before anything can load), then
     * the DIRECT proxy override, then the continuity barrier, then the load.
     */
    private fun startup() {
        if (PushTokenState.resetPending(this) != null) {
            // A shortcut request is moot: completion yields a fresh context.
            OperatorSwitchRequest.take()
            completePendingReset()
            return
        }
        if (OperatorSwitchRequest.take()) {
            if (PushTokenState.admitShortcutReset(this, System.currentTimeMillis())) {
                // Nothing loads first: the reset runs on a fresh, empty WebView.
                main.post { requestReset(EdgeContextReset.Reason.OPERATOR_SWITCH, automatic = false) }
                return
            }
            ShellDiagnostics.write("edge-reset shortcut-limited")
            Toast.makeText(this, R.string.shortcut_reset_limited, Toast.LENGTH_LONG).show()
        }
        EdgeProxyGuard.apply(this) { runBarrier() }
    }

    /**
     * launchMode=singleTask, so a notification tap on a running app arrives
     * here rather than creating a second activity.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        if (OperatorSwitchRequest.take()) {
            requestReset(EdgeContextReset.Reason.OPERATOR_SWITCH, automatic = false, fromShortcut = true)
            return
        }
        val target = consumeDeepLinkUrl(intent)
        ShellDiagnostics.write(
            "YOKO_NET fail push-open new act=${shortName(intent.action)}" +
                " keys=${intent.extras?.keySet()?.joinToString(",") { shortName(it) } ?: "none"}" +
                " tgt=${ShellDiagnostics.safeUrl(target)}",
        )
        if (target == null) return
        coordinator.onOperatorNavigation()
        load(target)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
        // The target alone, so a held start never has to restore page state
        // before the continuity barrier has decided.
        CrmOrigin.sanitizeRestoredUrl(currentTargetUrl)
            ?.takeUnless { EdgeAuthPolicy.isProbeUrl(it) }
            ?.let { outState.putString(KEY_SAVED_TARGET, it) }
    }

    override fun onStart() {
        super.onStart()
        ShellForeground.started = true
        if (resetInProgress) return
        // 12 h from fill, checked at every return to the foreground (F-1).
        if (EdgeCredentialHolder.isAccepted && EdgeCredentialHolder.isExpired()) {
            requestReset(EdgeContextReset.Reason.EDGE_MAX_AGE, automatic = true)
            return
        }
        if (EdgeCredentialHolder.refusedByRegistrar && coordinator.everAuthenticated) {
            requestReset(EdgeContextReset.Reason.EDGE_CREDENTIAL_REFUSED, automatic = true)
            return
        }
        if (!isTerminal(coordinator.state)) {
            webView.onResume()
            webView.resumeTimers()
        }
        if (EdgeCredentialHolder.isAccepted) PushRegistration.onEdgeReady(this)
        scheduleCredentialTimers()
        TokenActor.onRotationTrigger(this)
        showPushNotices()
    }

    /**
     * A third opportunity, for the case neither of the other two covers: the
     * app returning to the foreground on a session established while it was
     * away. Costs one cookie read; PushRegistration ignores it unless the
     * observation is actually a transition.
     */
    override fun onResume() {
        super.onResume()
        resumedOnce = true
        pendingDialog?.let { wrongPassword ->
            // The first prompt of this activity, asked for before it was on
            // screen; not a reopen after onPause (that never happens, §3.6).
            pendingDialog = null
            if (coordinator.state == EdgeChallengeCoordinator.EdgeState.PROMPTING) {
                edgeDialog.show(wrongPassword, EdgeCredentialHolder.pinnedUsername, dialogListener)
            }
        }
        if (::webView.isInitialized) observeSession(webView.url)
    }

    private var resumedOnce = false
    private var pendingDialog: Boolean? = null

    /**
     * Hand the shell's view of the session to the registration state machine,
     * and to the edge rules that depend on it.
     *
     * It reads whether a session cookie exists for the pinned origin and
     * whether the page is the login screen. It does not read the cookie value
     * and stores nothing about it.
     */
    private fun observeSession(url: String?) {
        if (resetInProgress) return
        if (!loadAllowed()) return
        val jar = CookieManager.getInstance().getCookie(CrmOrigin.ORIGIN)
        val started = PushRegistration.onPageSettled(this, url, jar)
        if (started) {
            // Persist the jar now: the registration attempt may run in a
            // process started after this one is gone, and a cookie that was
            // never flushed is a cookie that worker cannot see.
            CookieManager.getInstance().flush()
        }
        if (PushRegistration.isAuthenticatedPage(url, jar)) {
            operatorFence.bind(jar)
            if (!sessionValidSeen) {
                sessionValidSeen = true
                maybeWriteContinuityRecord()
            }
        } else if (sessionValidSeen && isMobileLogin(url)) {
            // The CRM ended the session it had (expiry, revocation, logout).
            requestReset(EdgeContextReset.Reason.SESSION_ENDED, automatic = true)
        }
    }

    override fun onPause() {
        super.onPause()
        // §3.6: a dialog never outlives the foreground; the operator taps «Войти».
        pendingDialog = null
        if (coordinator.onPause()) showEdgePanel(EdgePanel.REQUIRED)
        // Persist cookies now: the process may never get another chance.
        CookieManager.getInstance().flush()
        if (!resetInProgress) rememberLastVisitedUrl()
    }

    override fun onStop() {
        super.onStop()
        ShellForeground.started = false
        cancelCredentialTimers()
        if (resetInProgress) return
        // F-1: an unaccepted credential does not survive backgrounding.
        if (coordinator.onStop()) {
            probe = null
            showEdgePanel(EdgePanel.REQUIRED)
        }
        // Page polling stops: nothing in the background can carry the credential.
        webView.onPause()
        webView.pauseTimers()
    }

    // ── WebView configuration ────────────────────────────────────────────

    private fun configureWebView() {
        CookieManager.getInstance().apply {
            // A recreated activity never re-enables cookies the continuity
            // barrier of this process has disabled (§5.8.3).
            val held = ContinuityGuard.state == ContinuityGuard.State.PENDING ||
                ContinuityGuard.state == ContinuityGuard.State.MISMATCH
            setAcceptCookie(!held)
            // The shell renders one origin; it has no use for third-party
            // cookies and refusing them removes a whole class of surprises.
            setAcceptThirdPartyCookies(webView, false)
        }
        // The shell never reads or writes the WebView's own credential store.
        runCatching { WebViewDatabase.getInstance(this).clearHttpAuthUsernamePassword() }

        webView.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            databaseEnabled = true
            loadsImagesAutomatically = true
            mediaPlaybackRequiresUserGesture = true
            // The CRM is responsive; let it lay out at device width rather than
            // rendering a desktop page scaled down.
            useWideViewPort = true
            loadWithOverviewMode = false
            builtInZoomControls = false
            displayZoomControls = false
            // No local file or content access: the shell loads nothing but https.
            allowFileAccess = false
            allowContentAccess = false
            cacheMode = WebSettings.LOAD_DEFAULT
            mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW

            // Declare the lane. The CRM fails every shell request closed unless
            // it carries a live mobile session, and withholds SIP credentials
            // from this client entirely. The marker only ever selects a
            // stricter path, so it needs no integrity: stripping it makes this
            // an ordinary browser, which gains nothing it did not have.
            userAgentString = buildString {
                append(userAgentString)
                append(' ')
                append(CrmOrigin.SHELL_UA_TOKEN)
                append(CrmOrigin.SHELL_UA_VERSION)
                // Random per app start, so one run can be matched across the
                // phone log and the server request log. It says nothing about
                // the device or the operator.
                if (BuildConfig.CAPTURE_CONSOLE) append(" (run/${ShellDiagnostics.runId})")
            }
        }

        installPageErrorHook()
        webView.webViewClient = ShellWebViewClient()
        webView.webChromeClient = ShellWebChromeClient()
        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.shell_background))
    }

    private inner class ShellWebViewClient : WebViewClient() {

        override fun onPageStarted(view: WebView, url: String?, favicon: android.graphics.Bitmap?) {
            super.onPageStarted(view, url, favicon)
            if (refusesLegacyLogin(url)) {
                view.stopLoading()
                onLegacyLogin()
                return
            }
            currentLoadFailed = false
            ShellDiagnostics.write("nav start ${ShellDiagnostics.safeUrl(url)}")
            if (pageStartHookFallback) {
                view.evaluateJavascript(ShellDiagnostics.errorHookScript(), null)
            }
        }

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url?.toString()
            if (probe != null && request.isForMainFrame && request.isRedirect) {
                // A redirect is an answer to the probe; it is never followed.
                onProbeResponse(302, null)
                return true
            }
            // INV-21: the CRM TopBar «Выйти» navigates to the legacy operator
            // list with the mobile session still alive. Never load it.
            if (request.isForMainFrame && refusesLegacyLogin(url)) {
                onLegacyLogin()
                return true
            }
            if (CrmOrigin.isInAppUrl(url)) return false
            openExternally(url)
            // Consumed: an off-origin URL never renders inside the shell.
            return true
        }

        /**
         * The last line of the in-process guards, for every request the page
         * makes (main frame, subresources, fetch, RSC): nothing in-app leaves
         * while a reset runs or continuity is undecided (only the cookie-less
         * probe may), the legacy `/login` is refused with a session present,
         * and the operator fence holds.
         */
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
            val url = request.url?.toString() ?: return null
            if (!CrmOrigin.isInAppUrl(url)) return null
            if (resetInProgress) return refusedResponse()
            val state = ContinuityGuard.state
            if (state != ContinuityGuard.State.NONE && state != ContinuityGuard.State.CONFIRMED) {
                return if (state == ContinuityGuard.State.PENDING && EdgeAuthPolicy.isProbeUrl(url)) null else refusedResponse()
            }
            val jar = CookieManager.getInstance().getCookie(CrmOrigin.ORIGIN)
            if (ShellNavigationGuard.refusesLegacyLogin(url, PushRegistrar.sessionCookiePair(jar) != null, sessionValidSeen)) {
                main.post { onLegacyLogin() }
                return refusedResponse()
            }
            if (operatorFence.isViolated(jar)) {
                main.post { onOperatorFence() }
                return refusedResponse()
            }
            return null
        }

        override fun onReceivedHttpAuthRequest(
            view: WebView,
            handler: HttpAuthHandler,
            challengeHost: String?,
            challengeRealm: String?,
        ) {
            // super cancels; every decision is the coordinator's (rules A–F).
            coordinator.onChallenge(object : EdgeChallengeCoordinator.Challenge {
                override val host: String? = challengeHost
                override val realm: String? = challengeRealm
                override fun useStoredCredential(): Boolean = handler.useHttpAuthUsernamePassword()
                override fun proceed(username: String, password: String) = handler.proceed(username, password)
                override fun cancel() = handler.cancel()
            })
        }

        override fun onPageFinished(view: WebView, url: String?) {
            super.onPageFinished(view, url)
            if (EdgeAuthPolicy.isProbeUrl(url)) {
                // The probe never becomes content, a target or a remembered URL.
                if (!currentLoadFailed && probe != null) onProbeResponse(200, null)
                return
            }
            // A failed navigation still finishes, and the URL it reports is the
            // one we asked for. Showing content here would put the WebView's own
            // error page back on screen in place of ours.
            if (currentLoadFailed) return
            if (resetInProgress) return
            if (panelHeld) return
            if (CrmOrigin.isInAppUrl(url)) {
                acceptIfAuthenticating()
                applyRuleH()
                showContent()
                currentTargetUrl = url ?: currentTargetUrl
                rememberLastVisitedUrl()
                ShellDiagnostics.write("nav done  ${ShellDiagnostics.safeUrl(url)}")

                observeSession(url)
            }
        }

        /**
         * The signal a document load does NOT give us.
         *
         * The CRM is a Next.js App Router application: signing in posts a
         * Server Action, the server answers 303, and the router then moves to
         * the messenger client-side, inside the same document. No second page
         * load happens, so onPageFinished fires once - for the login screen -
         * and never again. The first hosted run proved it: the device held a
         * token, observed no authenticated session, and therefore never
         * registered. doUpdateVisitedHistory is the hook Chromium calls for
         * those history changes, so it is the one that sees a sign-in.
         */
        override fun doUpdateVisitedHistory(view: WebView, url: String?, isReload: Boolean) {
            super.doUpdateVisitedHistory(view, url, isReload)
            if (refusesLegacyLogin(url)) {
                onLegacyLogin()
                return
            }
            if (currentLoadFailed) return
            if (CrmOrigin.isInAppUrl(url) && !EdgeAuthPolicy.isProbeUrl(url)) acceptIfAuthenticating()
            observeSession(url)
        }

        override fun onReceivedError(
            view: WebView,
            request: WebResourceRequest,
            error: WebResourceError,
        ) {
            super.onReceivedError(view, request, error)
            // Only a failed main-frame load is worth a full error screen; a
            // missing avatar is not.
            if (request.isForMainFrame) {
                currentLoadFailed = true
                // A probe that never got an HTTP answer decided nothing.
                probe = null
                ShellDiagnostics.write("main-frame error ${error.errorCode} ${ShellDiagnostics.safeUrl(request.url?.toString())}")
                showError(getString(R.string.error_network))
            }
        }

        override fun onReceivedHttpError(
            view: WebView,
            request: WebResourceRequest,
            errorResponse: WebResourceResponse,
        ) {
            super.onReceivedHttpError(view, request, errorResponse)
            val url = request.url?.toString()
            val status = errorResponse.statusCode
            ShellDiagnostics.write("http $status ${ShellDiagnostics.safeUrl(url)}")

            if (probe != null && request.isForMainFrame && EdgeAuthPolicy.isProbeUrl(url)) {
                onProbeResponse(status, header(errorResponse, "WWW-Authenticate"))
                return
            }

            if (status == 401) {
                when (EdgeAuthPolicy.classify401(errorResponse.responseHeaders, url)) {
                    // nginx refused (after a cancel): never reload automatically.
                    EdgeAuthPolicy.Kind401.EDGE -> {
                        if (request.isForMainFrame) {
                            currentLoadFailed = true
                            if (!isTerminal(coordinator.state)) showEdgePanel(EdgePanel.REQUIRED)
                        }
                        return
                    }
                    // The CRM answers 401 to this lane when the mobile session
                    // has expired or been revoked. That reaches us on a
                    // background request — a poll, the stream, a send — while
                    // the page carries on showing stale content. Reload so the
                    // request boundary can hand us the login screen, rather than
                    // leaving an operator typing into a conversation that will
                    // never send.
                    else -> if (CrmOrigin.isInAppUrl(url)) {
                        onMobileSession401(view)
                        return
                    }
                }
            }

            if (request.isForMainFrame && status >= 500) {
                currentLoadFailed = true
                showError(getString(R.string.error_server, status))
            }
        }

        override fun onReceivedSslError(
            view: WebView,
            handler: SslErrorHandler,
            error: android.net.http.SslError,
        ) {
            // Never proceed. A certificate problem on the CRM origin is a hard
            // stop, not something an operator should be able to click through.
            handler.cancel()
            currentLoadFailed = true
            probe = null
            showError(getString(R.string.error_tls))
        }

        /**
         * The renderer died, usually out of memory. Without this the shell keeps
         * a dead grey WebView on screen with no way forward.
         */
        override fun onRenderProcessGone(
            view: WebView,
            detail: android.webkit.RenderProcessGoneDetail,
        ): Boolean {
            currentLoadFailed = true
            ShellDiagnostics.write("renderer gone, crashed=${detail.didCrash()}")
            showError(getString(R.string.error_network))
            return true
        }
    }

    private inner class ShellWebChromeClient : WebChromeClient() {

        /**
         * Deny every device capability the page asks for.
         *
         * This has a known cost: the composer's hold-to-record voice message
         * calls getUserMedia, so holding the microphone button does nothing in
         * the shell. It fails silently, because the CRM swallows the rejection.
         * Typed messages, photo and file attachments are unaffected.
         *
         * It is still the right default for stage 1. Granting audio would mean
         * declaring RECORD_AUDIO and asking the operator for the microphone on
         * a CRM app whose next stage is telephony — which reads as "this app is
         * about to start taking calls" at exactly the moment the shell must not
         * suggest that. The softphone itself is already stopped server-side, so
         * this is defence in depth, not the mechanism.
         *
         * Re-enabling voice messages is a small, separate change: declare
         * RECORD_AUDIO, request it on first use, and grant only
         * PermissionRequest.RESOURCE_AUDIO_CAPTURE — never the whole request.
         */
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()

        /**
         * Mirror page-level JavaScript errors into logcat, test builds only.
         *
         * A failure that happens only inside the device WebView is otherwise
         * unreadable: it renders as a generic "Application error" and the real
         * exception never leaves the renderer. Chromium reports uncaught
         * exceptions here, so this is the one place the message can be captured
         * without attaching a desktop debugger.
         *
         * Deliberately narrow. Only ERROR level is taken, the text is capped,
         * and the only other fields are the script name and line. No cookie, no
         * request body and no page content is read, and nothing is written to
         * disk or sent anywhere — it goes to logcat and nowhere else. A password
         * cannot reach here: the CRM never writes one to the console, and the
         * field's value is never part of an error message.
         */
        override fun onConsoleMessage(message: ConsoleMessage): Boolean {
            if (!BuildConfig.CAPTURE_CONSOLE) return false
            if (message.messageLevel() != ConsoleMessage.MessageLevel.ERROR) return false

            val script = message.sourceId()?.substringAfterLast('/').orEmpty()
            ShellDiagnostics.write("console | ${message.message()} | $script:${message.lineNumber()}")
            return false
        }

        override fun onShowFileChooser(
            webView: WebView,
            filePathCallback: ValueCallback<Array<Uri>>,
            fileChooserParams: FileChooserParams,
        ): Boolean {
            fileChooserCallback?.onReceiveValue(null)
            fileChooserCallback = filePathCallback
            return try {
                filePicker.launch(fileChooserParams.createIntent())
                true
            } catch (e: ActivityNotFoundException) {
                fileChooserCallback = null
                filePathCallback.onReceiveValue(null)
                false
            }
        }
    }

    // ── Bridge ───────────────────────────────────────────────────────────
    //
    // There is none, deliberately.
    //
    // The page needs no native operation from the shell. Session expiry is
    // handled by the CRM redirecting to the mobile login, a notification target
    // is consumed natively from the Intent, and every other decision is the
    // CRM's. Injecting an object into the page to carry messages nothing sends
    // would be attack surface bought for nothing.
    //
    // Push registration does not change this. An earlier version of this
    // comment said the FCM token would be handed to the page over a
    // WebMessageListener; it is not, and no bridge was ever added. The device
    // registers natively against the CRM's own endpoint, carrying the session
    // cookie the WebView already holds, so the token, the device identity and
    // the session value never cross into page script in either direction.

    // ── Edge auth: challenge UI (rules A–F, §3.3) ───────────────────────

    private inner class EdgeUi : EdgeChallengeCoordinator.Ui {

        override fun preconditionsMet(): Boolean = EdgeAuthPolicy.preconditions(EdgeProxyGuard.confirmed)

        override fun onStaffGateSeen() {
            gateDecidedInProcess = true
            PushTokenState.setEdgeGate(this@MainActivity, ContinuityGuard.EdgeGate.PRESENT)
            logProxyCollision()
        }

        override fun mayAnswerStaffChallenge(): Boolean = !ContinuityGuard.sessionIsGateless

        override fun openDialog(wrongPassword: Boolean) {
            if (resetInProgress || isFinishing) {
                main.post { coordinator.onPause() }
                return
            }
            if (!lifecycle.currentState.isAtLeast(Lifecycle.State.RESUMED)) {
                if (!resumedOnce && lifecycle.currentState.isAtLeast(Lifecycle.State.CREATED)) {
                    // Starting up: show it as soon as the activity is on screen.
                    pendingDialog = wrongPassword
                    return
                }
                // Never a dialog behind the operator's back; «Войти» on return.
                main.post { if (coordinator.onPause()) showEdgePanel(EdgePanel.REQUIRED) }
                return
            }
            edgeDialog.show(wrongPassword, EdgeCredentialHolder.pinnedUsername, dialogListener)
        }

        override fun closeDialog() {
            pendingDialog = null
            edgeDialog.dismissAndClear()
        }

        override fun stopAfterDecline(state: EdgeChallengeCoordinator.EdgeState) {
            // Rule F: no page keeps polling into a gate the operator declined.
            probe = null
            webView.stopLoading()
            webView.loadUrl(BLANK)
            webView.onPause()
            showEdgePanel(if (state == EdgeChallengeCoordinator.EdgeState.EXHAUSTED) EdgePanel.EXHAUSTED else EdgePanel.REQUIRED)
        }

        override fun onUnavailable() {
            showEdgePanel(EdgePanel.UNAVAILABLE)
        }

        override fun onProceeded() {
            probe?.proceeded = true
        }

        override fun onCredentialReady() {
            scheduleCredentialTimers()
            if (ContinuityGuard.state == ContinuityGuard.State.PENDING) loadProbe()
        }

        override fun requestReset(reason: String) {
            this@MainActivity.requestReset(reason, automatic = reason != EdgeContextReset.Reason.OPERATOR_SWITCH)
        }

        override fun diagnostic(line: String) = ShellDiagnostics.write(line)
    }

    private val dialogListener = object : EdgeAuthDialog.Listener {
        override fun onSubmit(username: String, password: CharArray) {
            coordinator.onDialogSubmit(username, password)
            scheduleCredentialTimers()
        }

        override fun onCancel() = coordinator.onDialogCancel()

        override fun onSwitchOperator() = requestReset(EdgeContextReset.Reason.OPERATOR_SWITCH, automatic = false)
    }

    /** Rule G: after a proceed(), an in-app page finished or the history moved with nothing pending. */
    private fun acceptIfAuthenticating() {
        if (coordinator.markAuthenticated()) onEdgeAuthenticated()
    }

    private fun onEdgeAuthenticated() {
        ShellDiagnostics.write("edge-auth authenticated")
        PushTokenState.setEdgeGate(this, ContinuityGuard.EdgeGate.PRESENT)
        scheduleCredentialTimers()
        PushRegistration.onEdgeReady(this)
        maybeWriteContinuityRecord()
    }

    /** Rule H: the first in-app page of this process finished without any staff challenge. */
    private fun applyRuleH() {
        if (gateDecidedInProcess || coordinator.staffChallengeSeen) return
        gateDecidedInProcess = true
        PushTokenState.setEdgeGate(this, ContinuityGuard.EdgeGate.ABSENT)
    }

    /**
     * Rule G with R4-IA-1 record protection, and IMPL-1 for a session that was
     * established without any edge principal.
     */
    private fun maybeWriteContinuityRecord() {
        if (!sessionValidSeen || recordHandled || resetInProgress) return
        val result = if (coordinator.state == EdgeChallengeCoordinator.EdgeState.AUTHENTICATED) {
            val accepted = EdgeCredentialHolder.currentUsername()
            val pinned = EdgeCredentialHolder.pinnedUsername
            if (accepted == null || pinned == null || accepted != pinned) {
                requestReset(EdgeContextReset.Reason.CONTINUITY_MISMATCH, automatic = true)
                return
            }
            ContinuityGuard.writeRecord(this, pinned)
        } else if (!coordinator.staffChallengeSeen && PushTokenState.edgeGate(this) != ContinuityGuard.EdgeGate.PRESENT) {
            applyRuleH()
            ContinuityGuard.sessionIsGateless = true
            ContinuityGuard.writeRecord(this, null)
        } else {
            // A staff challenge is still being answered; rule G writes it.
            return
        }
        when (result) {
            ContinuityGuard.WriteResult.WRITTEN, ContinuityGuard.WriteResult.SAME -> recordHandled = true
            ContinuityGuard.WriteResult.MISMATCH -> requestReset(EdgeContextReset.Reason.CONTINUITY_MISMATCH, automatic = true)
            // No record: the next process start with this session fails closed.
            ContinuityGuard.WriteResult.KEY_UNAVAILABLE -> recordHandled = true
        }
        ShellDiagnostics.write("continuity record ${result.name.lowercase()}")
    }

    // ── Edge auth: continuity barrier (§5.8.3) ───────────────────────────

    private fun runBarrier() {
        if (resetInProgress) return
        val manager = CookieManager.getInstance()
        val decided = ContinuityGuard.state
        if (decided == ContinuityGuard.State.NONE || decided == ContinuityGuard.State.CONFIRMED) {
            // Once per process start: a recreated activity in a process that
            // already decided continuity does not ask again.
            startFirstLoad(allowRestore = true)
            return
        }
        val sessionPresent = PushRegistrar.sessionCookiePair(manager.getCookie(CrmOrigin.ORIGIN)) != null ||
            PushRegistrar.sessionCookiePair(manager.getCookie(EdgeContextReset.wwwAliasUrl())) != null
        val (stored, verification) = ContinuityGuard.verifyStored(this)
        val decision = ContinuityGuard.precheck(
            sessionCookiePresent = sessionPresent,
            recordStored = stored,
            verification = verification,
            installKeyAvailable = PushTokenState.installKeyAvailable(this),
            gate = PushTokenState.edgeGate(this),
            noEdgeFingerprint = ContinuityGuard.noEdgeFingerprint(this),
        )
        when (decision) {
            is ContinuityGuard.Precheck.None -> {
                ContinuityGuard.state = ContinuityGuard.State.NONE
                startFirstLoad(allowRestore = true)
            }

            is ContinuityGuard.Precheck.ConfirmedNoEdge -> {
                ContinuityGuard.state = ContinuityGuard.State.CONFIRMED
                ContinuityGuard.sessionIsGateless = true
                recordHandled = true
                ShellDiagnostics.write("continuity confirmed gate=absent")
                startFirstLoad(allowRestore = true)
            }

            is ContinuityGuard.Precheck.Probe -> {
                // Hold everything; the old cookies leave the device in no
                // request until continuity is decided.
                ContinuityGuard.state = ContinuityGuard.State.PENDING
                recordFp = decision.recordFp
                manager.setAcceptCookie(false)
                ShellDiagnostics.write("continuity pending")
                promptForProbe()
            }

            is ContinuityGuard.Precheck.Mismatch -> {
                ContinuityGuard.state = ContinuityGuard.State.MISMATCH
                manager.setAcceptCookie(false)
                ShellDiagnostics.write("continuity mismatch reason=${decision.reason}")
                requestReset(EdgeContextReset.Reason.CONTINUITY_MISMATCH, automatic = true)
            }
        }
    }

    private fun promptForProbe() {
        if (resetInProgress) return
        showEdgePanel(EdgePanel.REQUIRED)
        if (!EdgeAuthPolicy.preconditions(EdgeProxyGuard.confirmed)) {
            showEdgePanel(EdgePanel.UNAVAILABLE)
            return
        }
        coordinator.promptPreemptively()
    }

    private fun loadProbe() {
        if (ContinuityGuard.state != ContinuityGuard.State.PENDING || resetInProgress) return
        probe = Probe()
        currentLoadFailed = false
        panelHeld = false
        ShellDiagnostics.write("continuity probe start")
        // From the network only: a cached favicon would answer without nginx
        // ever seeing the credential, and an unverified answer is a mismatch.
        webView.settings.cacheMode = WebSettings.LOAD_NO_CACHE
        webView.loadUrl(EdgeAuthPolicy.probeUrl())
    }

    private fun retryProbe() {
        if (EdgeCredentialHolder.isPresent && !EdgeCredentialHolder.isExpired()) loadProbe() else promptForProbe()
    }

    /** Security R5.1-1: the probe's own answer decides, and only after a proceed(). */
    private fun onProbeResponse(status: Int, wwwAuthenticate: String?) {
        val current = probe ?: return
        if (current.decided) return
        val outcome = ContinuityGuard.classifyProbe(status, wwwAuthenticate, current.proceeded, transportFailed = false)
        ShellDiagnostics.write("continuity probe status=$status outcome=${outcome.name.lowercase()}")
        when (outcome) {
            ContinuityGuard.ProbeOutcome.ACCEPTED -> {
                current.decided = true
                probe = null
                if (coordinator.markAuthenticated()) onEdgeAuthenticated()
                decideContinuity()
            }
            ContinuityGuard.ProbeOutcome.REFUSED -> {
                current.decided = true
                probe = null
            }
            ContinuityGuard.ProbeOutcome.UNVERIFIED -> {
                current.decided = true
                probe = null
                ContinuityGuard.state = ContinuityGuard.State.MISMATCH
                requestReset(EdgeContextReset.Reason.CONTINUITY_MISMATCH, automatic = true)
            }
            ContinuityGuard.ProbeOutcome.UNDECIDED -> {
                probe = null
                showError(getString(R.string.error_network))
            }
        }
    }

    private fun decideContinuity() {
        val fp = recordFp
        val confirmed = fp != null && ContinuityGuard.decide(
            acceptedUsername = EdgeCredentialHolder.currentUsername(),
            pinnedUsername = EdgeCredentialHolder.pinnedUsername,
            recordFp = fp,
            installKeyAvailable = PushTokenState.installKeyAvailable(this),
        ) { ContinuityGuard.fingerprintOf(this, it) }
        if (!confirmed) {
            ContinuityGuard.state = ContinuityGuard.State.MISMATCH
            requestReset(EdgeContextReset.Reason.CONTINUITY_MISMATCH, automatic = true)
            return
        }
        ContinuityGuard.state = ContinuityGuard.State.CONFIRMED
        recordHandled = true
        recordFp = null
        webView.settings.cacheMode = WebSettings.LOAD_DEFAULT
        CookieManager.getInstance().setAcceptCookie(true)
        ShellDiagnostics.write("continuity confirmed")
        startFirstLoad(allowRestore = false)
        PushRegistration.onEdgeReady(this)
    }

    private fun startFirstLoad(allowRestore: Boolean) {
        panelHeld = false
        val target = heldTarget ?: CrmOrigin.startUrl()
        val saved = pendingSavedState
        pendingSavedState = null
        when {
            startedFromNotification || heldExplicitly -> load(target)
            // Process recreation with live state: put back the history stack and
            // the scroll position instead of reloading from scratch — only when
            // no barrier had to hold the start.
            allowRestore && saved != null && webView.restoreState(saved) != null -> {
                currentTargetUrl = CrmOrigin.sanitizeRestoredUrl(webView.url) ?: CrmOrigin.startUrl()
            }
            // Cold start after the process was killed: state is gone but the
            // persisted cookie is not, so the CRM resumes the session itself.
            else -> load(target)
        }
        startedFromNotification = false
        heldExplicitly = false
    }

    // ── Edge auth: reset (§5) ────────────────────────────────────────────

    private fun refusesLegacyLogin(url: String?): Boolean {
        if (!ShellNavigationGuard.isLegacyLogin(url)) return false
        val jar = CookieManager.getInstance().getCookie(CrmOrigin.ORIGIN)
        return ShellNavigationGuard.refusesLegacyLogin(url, PushRegistrar.sessionCookiePair(jar) != null, sessionValidSeen)
    }

    private fun onLegacyLogin() {
        ShellDiagnostics.write("edge-reset trigger=topbar-login")
        requestReset(EdgeContextReset.Reason.OPERATOR_SWITCH, automatic = false)
    }

    private fun onOperatorFence() {
        ShellDiagnostics.write("edge-reset trigger=operator-fence")
        requestReset(EdgeContextReset.Reason.OPERATOR_SWITCH, automatic = false)
    }

    private fun requestReset(reason: String, automatic: Boolean, fromShortcut: Boolean = false) {
        if (resetInProgress) return
        if (reason == EdgeContextReset.Reason.CONTINUITY_MISMATCH) {
            // Whatever happens next (reset or guard), the old session's
            // cookies leave the device in no further request.
            ContinuityGuard.state = ContinuityGuard.State.MISMATCH
            CookieManager.getInstance().setAcceptCookie(false)
        }
        if (fromShortcut && !PushTokenState.admitShortcutReset(this, System.currentTimeMillis())) {
            ShellDiagnostics.write("edge-reset shortcut-limited")
            Toast.makeText(this, R.string.shortcut_reset_limited, Toast.LENGTH_LONG).show()
            return
        }
        if (automatic && reason in EdgeContextReset.Reason.AUTOMATIC &&
            !EdgeContextReset.automaticAllowed(
                PushTokenState.lastReset(this),
                System.currentTimeMillis(),
                SystemClock.elapsedRealtime(),
            )
        ) {
            // §5.5: no reset loop. Clear the holder, stop, and leave the choice
            // to the operator; cookies are not re-enabled and nothing loads.
            ShellDiagnostics.write("edge-reset guard reason=$reason")
            coordinator.clearForReset()
            probe = null
            if (ContinuityGuard.state == ContinuityGuard.State.MISMATCH) {
                ContinuityGuard.state = ContinuityGuard.State.PENDING
            }
            stopTraffic(cancelWork = false)
            showEdgePanel(EdgePanel.GUARD)
            return
        }
        runReset(reason)
    }

    /** §5.3 steps 0–6. */
    private fun runReset(reason: String) {
        resetInProgress = true
        // 0. Durable intent first, one commit under PushTokenState.LOCK.
        PushTokenState.beginReset(this, reason, System.currentTimeMillis(), SystemClock.elapsedRealtime())
        ShellDiagnostics.write("edge-reset start reason=$reason")
        // 1. In-memory.
        coordinator.clearForReset()
        edgeDialog.dismissAndClear()
        cancelCredentialTimers()
        probe = null
        // 2. Stop traffic.
        stopTraffic(cancelWork = true)
        showPanel(getString(R.string.reset_in_progress), "", null, null, switchVisible = false)
        // 5a. Token deletion runs alongside, bounded at 5 s, never blocking step 3.
        val deleteStarted = SystemClock.elapsedRealtime()
        val deleteDone = TokenActor.requestResetDelete(this)
        verifyThenEnd(reason, deleteStarted, deleteDone)
    }

    private fun verifyThenEnd(reason: String, deleteStarted: Long, deleteDone: java.util.concurrent.CountDownLatch) {
        // 3. Cookies — verified, not timed.
        EdgeContextReset.verifyCookieRemoval(cookieJar, ::schedule, onResult = { verified ->
            if (!verified) {
                // The process does not end and nothing is relaunched;
                // reset_pending stays and the next start completes it.
                ShellDiagnostics.write("edge-reset cookies-unverified")
                showPanel(
                    getString(R.string.reset_incomplete_title),
                    getString(R.string.reset_incomplete_text),
                    getString(R.string.error_retry),
                    { verifyThenEnd(reason, deleteStarted, deleteDone) },
                    switchVisible = false,
                )
            } else {
                // 4–5. WebView stores and app state.
                clearWebStores()
                clearAppState()
                Thread {
                    val remaining = EdgeContextReset.TOKEN_DELETE_WAIT_MS - (SystemClock.elapsedRealtime() - deleteStarted)
                    if (remaining > 0) deleteDone.await(remaining, TimeUnit.MILLISECONDS)
                    main.post { endProcess(reason) }
                }.start()
            }
        })
    }

    /** §5.3 step 6: only after step 3 verified. */
    private fun endProcess(reason: String) {
        ShellDiagnostics.write("edge-reset end-process reason=$reason")
        runCatching {
            startActivity(
                Intent(this, ResetTrampolineActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    .putExtra(ResetTrampolineActivity.EXTRA_MAIN_PID, Process.myPid())
                    .putExtra(ResetTrampolineActivity.EXTRA_REASON, reason),
            )
        }
        finishAffinity()
        Runtime.getRuntime().exit(0)
    }

    /** §5.3a: steps 3–5 again at the start of the next process, before any load. */
    private fun completePendingReset() {
        resetInProgress = true
        stopTraffic(cancelWork = false)
        showPanel(getString(R.string.reset_in_progress), "", null, null, switchVisible = false)
        EdgeContextReset.verifyCookieRemoval(cookieJar, ::schedule, onResult = { verified ->
            if (!verified) {
                ShellDiagnostics.write("edge-reset completion cookies-unverified")
                showPanel(
                    getString(R.string.reset_incomplete_title),
                    "",
                    getString(R.string.error_retry),
                    { completePendingReset() },
                    switchVisible = false,
                )
            } else {
                clearWebStores()
                // The saved instance state is the old context's page state and
                // back history; it is never restored into the fresh one.
                pendingSavedState = null
                clearAppState()
                PushTokenState.completeReset(this)
                resetInProgress = false
                ShellDiagnostics.write("edge-reset completed")
                webView.onResume()
                webView.resumeTimers()
                TokenActor.onRotationTrigger(this)
                EdgeProxyGuard.apply(this) { runBarrier() }
            }
        })
    }

    private fun stopTraffic(cancelWork: Boolean) {
        webView.stopLoading()
        webView.loadUrl(BLANK)
        webView.onPause()
        webView.pauseTimers()
        if (cancelWork) {
            runCatching { WorkManager.getInstance(applicationContext).cancelUniqueWork(PushRegistrationWorker.UNIQUE_WORK_NAME) }
        }
    }

    private fun clearWebStores() {
        WebStorage.getInstance().deleteAllData()
        webView.clearCache(true)
        webView.clearHistory()
        runCatching { WebViewDatabase.getInstance(this).clearHttpAuthUsernamePassword() }
    }

    private fun clearAppState() {
        prefs().edit().remove(KEY_LAST_URL).commit()
        NotificationManagerCompat.from(this).cancelAll()
    }

    private val cookieJar = object : EdgeContextReset.CookieJar {
        override fun removeAll(done: () -> Unit) {
            CookieManager.getInstance().removeAllCookies { done() }
        }

        override fun flush() = CookieManager.getInstance().flush()

        override fun cookiesFor(url: String): String? = CookieManager.getInstance().getCookie(url)
    }

    private fun schedule(delayMs: Long, block: () -> Unit) {
        main.postDelayed(block, delayMs)
    }

    // ── Edge auth: credential lifetime (F-1) ─────────────────────────────

    private val unacceptedExpiry = Runnable {
        if (coordinator.onUnacceptedExpiry()) {
            edgeDialog.dismissAndClear()
            probe = null
            showEdgePanel(EdgePanel.REQUIRED)
        }
    }

    private val acceptedExpiry = Runnable {
        if (EdgeCredentialHolder.isAccepted && EdgeCredentialHolder.isExpired()) {
            requestReset(EdgeContextReset.Reason.EDGE_MAX_AGE, automatic = true)
        }
    }

    private fun scheduleCredentialTimers() {
        cancelCredentialTimers()
        if (!ShellForeground.started) return
        val expiry = EdgeCredentialHolder.expiryAtElapsed() ?: return
        val delay = (expiry - SystemClock.elapsedRealtime()).coerceAtLeast(0L) + TIMER_SLACK_MS
        main.postDelayed(if (EdgeCredentialHolder.isAccepted) acceptedExpiry else unacceptedExpiry, delay)
    }

    private fun cancelCredentialTimers() {
        main.removeCallbacks(unacceptedExpiry)
        main.removeCallbacks(acceptedExpiry)
    }

    private fun isTerminal(state: EdgeChallengeCoordinator.EdgeState): Boolean =
        state == EdgeChallengeCoordinator.EdgeState.DECLINED ||
            state == EdgeChallengeCoordinator.EdgeState.EXHAUSTED ||
            state == EdgeChallengeCoordinator.EdgeState.UNAVAILABLE

    /** §3.2 item 4: a diagnostic only; it changes no decision. */
    private fun logProxyCollision() {
        runCatching {
            val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            val proxy = manager.getLinkProperties(manager.activeNetwork)?.httpProxy ?: return
            ShellDiagnostics.write("edge-auth proxy-configured collision=${proxy.host.equals(EdgeAuthPolicy.PINNED_HOST, ignoreCase = true)}")
        }
    }

    /** Mobile 401: at most one automatic reload per 30 s, never from the login page. */
    private fun onMobileSession401(view: WebView) {
        val current = view.url.orEmpty()
        if (current.contains(CrmOrigin.LOGIN_PATH)) return
        val now = SystemClock.elapsedRealtime()
        val since = if (mobileReloadAtElapsed < 0) Long.MAX_VALUE else now - mobileReloadAtElapsed
        // Parallel requests of the same page fail together; they are one event.
        if (since < MOBILE_401_BURST_MS) return
        if (since < MOBILE_401_WINDOW_MS) {
            showPanel(
                getString(R.string.session_expired_title),
                getString(R.string.session_expired_text),
                getString(R.string.error_retry),
                { load(CrmOrigin.startUrl()) },
                switchVisible = true,
            )
            return
        }
        mobileReloadAtElapsed = now
        view.post { load(CrmOrigin.startUrl()) }
    }

    private fun showPushNotices() {
        if (PushTokenState.takeRotationNotice(this, System.currentTimeMillis())) {
            ShellDiagnostics.write("YOKO_NET fail push-rotation pending-over-24h")
            Toast.makeText(this, R.string.push_notice_rotation, Toast.LENGTH_LONG).show()
        }
        if (PushTokenState.takeConflictNotice(this)) {
            Toast.makeText(this, R.string.push_notice_conflict, Toast.LENGTH_LONG).show()
        }
    }

    // ── Navigation and state ─────────────────────────────────────────────

    private fun installBackHandler() {
        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack()
                } else {
                    // No history left: leave the app rather than showing a blank
                    // screen. The session stays on the device.
                    finish()
                }
            }
        })
    }

    /**
     * Whether an in-app URL may load now. The gate sits here so notification
     * taps, restored state and every retry obey it: never while a reset is
     * pending or running, never before the continuity barrier has decided.
     */
    private fun loadAllowed(): Boolean {
        if (resetInProgress) return false
        if (PushTokenState.resetPending(this) != null) return false
        val state = ContinuityGuard.state
        return state == ContinuityGuard.State.NONE || state == ContinuityGuard.State.CONFIRMED
    }

    private fun load(url: String) {
        currentTargetUrl = url
        if (!loadAllowed()) {
            heldTarget = url
            heldExplicitly = true
            ShellDiagnostics.write("nav held ${ShellDiagnostics.safeUrl(url)} continuity=${ContinuityGuard.state.name.lowercase()}")
            return
        }
        currentLoadFailed = false
        panelHeld = false
        showContent()
        webView.loadUrl(url)
    }

    private fun retry() {
        coordinator.onOperatorNavigation()
        if (ContinuityGuard.state == ContinuityGuard.State.PENDING) {
            retryProbe()
            return
        }
        load(currentTargetUrl)
    }

    /** «Войти» on an edge panel (rule F, §5.8.3 re-entry): cookies stay as the barrier left them. */
    private fun edgeLogin() {
        webView.onResume()
        webView.resumeTimers()
        coordinator.resumeAfterStop()
        if (ContinuityGuard.state == ContinuityGuard.State.PENDING) {
            promptForProbe()
            return
        }
        retry()
    }

    /**
     * Read a notification target and then strip it from the Intent.
     *
     * The strip is the point. Android keeps the launching Intent attached to
     * the activity, so without it a target would be replayed every time the
     * activity is recreated — after a process kill the operator would be pulled
     * back to whichever conversation they last tapped, losing wherever they had
     * navigated since. A notification opens a conversation once.
     */
    /**
     * Last dot-segment of a fully qualified constant name.
     *
     * The start lines have to survive a 200-character annotation and a
     * 400-character assertion message, and the difference that matters is VIEW
     * against MAIN, not the package they live in.
     */
    private fun shortName(value: String?): String =
        value?.substringAfterLast('.') ?: "null"

    private fun consumeDeepLinkUrl(intent: Intent?): String? {
        if (intent == null) return null
        val callAlertKind = intent.getStringExtra(ChatNotifications.EXTRA_CALL_ALERT_KIND)
        val chatId = intent.getStringExtra(ChatNotifications.EXTRA_CHAT_ID)
        if (callAlertKind == null && chatId == null) return null

        // The routing decision itself lives in CrmOrigin, where the pinned
        // origin and the two compile-time paths are, and is a pure function so
        // it can be asserted without an Activity. This method's job is the
        // Intent: read the extras once, then clear them so a later restart
        // cannot replay the same target.
        val url = CrmOrigin.deepLinkTarget(
            callAlertKind = callAlertKind,
            chatId = chatId,
            channelTab = intent.getStringExtra(ChatNotifications.EXTRA_CHANNEL_TAB),
            messageId = intent.getStringExtra(ChatNotifications.EXTRA_MESSAGE_ID),
        )

        intent.removeExtra(ChatNotifications.EXTRA_CALL_ALERT_KIND)
        intent.removeExtra(ChatNotifications.EXTRA_CHAT_ID)
        intent.removeExtra(ChatNotifications.EXTRA_CHANNEL_TAB)
        intent.removeExtra(ChatNotifications.EXTRA_MESSAGE_ID)

        if (url == null) {
            // A payload the shell will not act on. Fall back to the Messenger
            // rather than guessing.
            Log.w(TAG, "rejected notification target: identifier failed validation")
        }
        return url
    }

    private fun openExternally(url: String?) {
        if (!CrmOrigin.isLaunchableExternally(url)) {
            Log.w(TAG, "refused to open unsupported scheme from page")
            return
        }
        val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
            addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            // Do not let this shell be its own handler and re-enter itself.
            addCategory(Intent.CATEGORY_BROWSABLE)
        }
        runCatching { startActivity(intent) }
            .onFailure { Log.w(TAG, "no app available for external link") }
    }

    private fun prefs() = getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    private fun rememberLastVisitedUrl() {
        if (!loadAllowed()) return
        val url = CrmOrigin.sanitizeRestoredUrl(webView.url) ?: return
        if (EdgeAuthPolicy.isProbeUrl(url)) return
        prefs().edit().putString(KEY_LAST_URL, url).apply()
    }

    private fun lastVisitedUrl(): String? =
        CrmOrigin.sanitizeRestoredUrl(prefs().getString(KEY_LAST_URL, null))

    private fun isMobileLogin(url: String?): Boolean =
        url != null && CrmOrigin.isInAppUrl(url) && Uri.parse(url).path.orEmpty().startsWith(CrmOrigin.LOGIN_PATH)

    private fun header(response: WebResourceResponse, name: String): String? =
        response.responseHeaders?.entries?.firstOrNull { it.key.equals(name, ignoreCase = true) }?.value

    private fun refusedResponse(): WebResourceResponse =
        WebResourceResponse(
            "text/plain",
            "utf-8",
            403,
            "Forbidden",
            mapOf("Cache-Control" to "no-store"),
            ByteArrayInputStream(ByteArray(0)),
        )

    // ── Error surface ────────────────────────────────────────────────────

    private enum class EdgePanel { REQUIRED, EXHAUSTED, UNAVAILABLE, GUARD }

    private fun showError(message: String) {
        showPanel(getString(R.string.error_title), message, getString(R.string.error_retry), null, switchVisible = true)
    }

    private fun showEdgePanel(kind: EdgePanel) {
        panelHeld = true
        when (kind) {
            EdgePanel.REQUIRED -> showPanel(
                getString(R.string.edge_required_title),
                getString(R.string.edge_required_text),
                getString(R.string.edge_login),
                { edgeLogin() },
                switchVisible = true,
            )
            EdgePanel.EXHAUSTED -> showPanel(
                getString(R.string.edge_required_title),
                getString(R.string.edge_exhausted_text),
                getString(R.string.edge_login),
                { edgeLogin() },
                switchVisible = true,
            )
            EdgePanel.UNAVAILABLE -> showPanel(
                getString(R.string.edge_required_title),
                getString(
                    when {
                        !EdgeAuthPolicy.ORIGIN_IS_HTTPS -> R.string.edge_insecure_origin_text
                        EdgeProxyGuard.state == EdgeProxyGuard.State.TIMEOUT -> R.string.edge_proxy_timeout_text
                        else -> R.string.edge_unsupported_text
                    },
                ),
                getString(R.string.error_retry),
                {
                    EdgeProxyGuard.apply(this) {
                        coordinator.resumeAfterStop()
                        if (ContinuityGuard.state == ContinuityGuard.State.PENDING) promptForProbe() else retry()
                    }
                },
                switchVisible = true,
            )
            EdgePanel.GUARD -> showPanel(
                getString(R.string.edge_required_title),
                getString(R.string.edge_guard_text),
                getString(R.string.edge_login),
                { edgeLogin() },
                switchVisible = true,
            )
        }
    }

    private fun showPanel(title: String, message: String, actionLabel: String?, action: (() -> Unit)?, switchVisible: Boolean) {
        errorTitle.text = title
        errorText.text = message
        panelAction = action
        retryButton.visibility = if (actionLabel == null) View.GONE else View.VISIBLE
        retryButton.text = actionLabel ?: getString(R.string.error_retry)
        switchButton.visibility = if (switchVisible) View.VISIBLE else View.GONE
        errorPanel.visibility = View.VISIBLE
        webView.visibility = View.GONE
    }

    private fun showContent() {
        errorPanel.visibility = View.GONE
        webView.visibility = View.VISIBLE
    }

    // ── Insets ───────────────────────────────────────────────────────────

    private fun applyWindowInsets() {
        val root = findViewById<View>(R.id.root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
            val ime = insets.getInsets(WindowInsetsCompat.Type.ime())
            // Bottom padding follows the keyboard when it is up and the
            // navigation bar when it is not, so the CRM composer is always
            // reachable and never covered.
            view.setPadding(bars.left, bars.top, bars.right, maxOf(bars.bottom, ime.bottom))
            insets
        }
    }

    // ── Notification permission ──────────────────────────────────────────

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            ShellTestHooks.onNotificationsReady(this)
            return
        }
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) {
            ShellTestHooks.onNotificationsReady(this)
        } else {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    /**
     * Install the page error hook so it runs before the page's own scripts.
     *
     * Document-start injection matters: an exception thrown while the page is
     * still initialising happens before any listener added afterwards could see
     * it, which is exactly the window the reported failure falls in. Where the
     * WebView is too old for that API the hook is injected at page start
     * instead, which still catches everything after the first script.
     */
    private fun installPageErrorHook() {
        if (!BuildConfig.CAPTURE_CONSOLE) return
        if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
            runCatching {
                WebViewCompat.addDocumentStartJavaScript(
                    webView,
                    ShellDiagnostics.errorHookScript(),
                    setOf(CrmOrigin.ORIGIN),
                )
            }.onFailure { ShellDiagnostics.write("document-start hook unavailable: ${it.message}") }
        } else {
            ShellDiagnostics.write("document-start scripts unsupported; hooking at page start")
            pageStartHookFallback = true
        }
    }

    private var pageStartHookFallback = false

    companion object {
        private const val TAG = "YokoShell"
        private const val PREFS = "yoko_shell"
        private const val KEY_LAST_URL = "last_url"
        private const val KEY_SAVED_TARGET = "shell_target"
        private const val BLANK = "about:blank"
        private const val TIMER_SLACK_MS = 50L
        private const val MOBILE_401_BURST_MS = 3_000L
        private const val MOBILE_401_WINDOW_MS = 30_000L

        /** Rule H decided (or a staff challenge was seen) in this process. */
        @Volatile
        private var gateDecidedInProcess = false
    }
}
