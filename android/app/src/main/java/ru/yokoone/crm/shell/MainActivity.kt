package ru.yokoone.crm.shell

import android.Manifest
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.util.Log
import android.view.View
import android.webkit.CookieManager
import android.webkit.PermissionRequest
import android.webkit.SslErrorHandler
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.TextView
import androidx.activity.OnBackPressedCallback
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

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
 */
class MainActivity : AppCompatActivity() {

    private lateinit var webView: WebView
    private lateinit var errorPanel: View
    private lateinit var errorText: TextView

    /** URL the shell most recently decided to load; the retry button reuses it. */
    private var currentTargetUrl: String = CrmOrigin.startUrl()

    private var fileChooserCallback: ValueCallback<Array<Uri>>? = null

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
    ) { granted -> if (granted) TestNotificationSeed.ensureDiagnosticsNotification(this) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        // Draw behind the system bars, then hand the real insets to the layout
        // below. Without this the CRM composer sits under the navigation bar on
        // a gesture-navigation device.
        WindowCompat.setDecorFitsSystemWindows(window, false)
        setContentView(R.layout.activity_main)

        webView = findViewById(R.id.web_view)
        errorPanel = findViewById(R.id.error_panel)
        errorText = findViewById(R.id.error_text)
        findViewById<Button>(R.id.error_retry).setOnClickListener { retry() }

        applyWindowInsets()
        configureWebView()
        installBackHandler()
        ChatNotifications.ensureChannel(this)
        requestNotificationPermissionIfNeeded()

        val fromNotification = consumeDeepLinkUrl(intent)
        when {
            // A notification tap always wins over restored state: the operator
            // asked for a specific conversation.
            fromNotification != null -> load(fromNotification)
            // Process recreation with live state: put back the history stack and
            // the scroll position instead of reloading from scratch.
            savedInstanceState != null && webView.restoreState(savedInstanceState) != null -> {
                currentTargetUrl = CrmOrigin.sanitizeRestoredUrl(webView.url) ?: CrmOrigin.startUrl()
            }
            // Cold start after the process was killed: state is gone but the
            // persisted cookie is not, so the CRM resumes the session itself.
            else -> load(lastVisitedUrl() ?: CrmOrigin.startUrl())
        }
    }

    /**
     * launchMode=singleTask, so a notification tap on a running app arrives
     * here rather than creating a second activity.
     */
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        val target = consumeDeepLinkUrl(intent) ?: return
        load(target)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        webView.saveState(outState)
    }

    override fun onPause() {
        super.onPause()
        // Persist cookies now: the process may never get another chance.
        CookieManager.getInstance().flush()
        rememberLastVisitedUrl()
    }

    // ── WebView configuration ────────────────────────────────────────────

    private fun configureWebView() {
        CookieManager.getInstance().apply {
            setAcceptCookie(true)
            // The shell renders one origin; it has no use for third-party
            // cookies and refusing them removes a whole class of surprises.
            setAcceptThirdPartyCookies(webView, false)
        }

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
        }

        webView.webViewClient = ShellWebViewClient()
        webView.webChromeClient = ShellWebChromeClient()
        webView.setBackgroundColor(ContextCompat.getColor(this, R.color.shell_background))
    }

    private inner class ShellWebViewClient : WebViewClient() {

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
            val url = request.url?.toString()
            if (CrmOrigin.isInAppUrl(url)) return false
            openExternally(url)
            // Consumed: an off-origin URL never renders inside the shell.
            return true
        }

        override fun onPageFinished(view: WebView, url: String?) {
            super.onPageFinished(view, url)
            if (CrmOrigin.isInAppUrl(url)) {
                showContent()
                currentTargetUrl = url ?: currentTargetUrl
                rememberLastVisitedUrl()
            }
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
                showError(getString(R.string.error_network))
            }
        }

        override fun onReceivedHttpError(
            view: WebView,
            request: WebResourceRequest,
            errorResponse: WebResourceResponse,
        ) {
            super.onReceivedHttpError(view, request, errorResponse)
            if (request.isForMainFrame && errorResponse.statusCode >= 500) {
                showError(getString(R.string.error_server, errorResponse.statusCode))
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
            showError(getString(R.string.error_tls))
        }
    }

    private inner class ShellWebChromeClient : WebChromeClient() {

        /**
         * Deny every device capability the page asks for.
         *
         * Stage 1 is messaging only. The CRM root layout mounts a browser
         * softphone on every page; refusing the microphone here means the shell
         * can never become a second, competing call endpoint even if a future
         * change re-enables SIP for a mobile session. Telephony is a later
         * stage and will be an explicit decision, not an inherited default.
         */
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()

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
    // Stage 1 needs no native operation from the page. Session expiry is
    // handled by the CRM redirecting to the mobile login, a notification target
    // is consumed natively from the Intent, and every other decision is the
    // CRM's. Injecting an object into the page to carry messages nothing sends
    // would be attack surface bought for nothing.
    //
    // When push lands it will need exactly one operation, to hand the FCM
    // registration token to the page so it can be bound to the session that
    // owns the device. That will use WebViewCompat.addWebMessageListener with
    // an allowed-origin rule of BuildConfig.CRM_ORIGIN — never
    // addJavascriptInterface, which injects into every frame regardless of
    // origin and cannot be restricted.

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

    private fun load(url: String) {
        currentTargetUrl = url
        showContent()
        webView.loadUrl(url)
    }

    private fun retry() {
        load(currentTargetUrl)
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
    private fun consumeDeepLinkUrl(intent: Intent?): String? {
        val chatId = intent?.getStringExtra(ChatNotifications.EXTRA_CHAT_ID) ?: return null
        val url = CrmOrigin.buildOpenChatUrl(
            chatId = chatId,
            channelTab = intent.getStringExtra(ChatNotifications.EXTRA_CHANNEL_TAB),
            messageId = intent.getStringExtra(ChatNotifications.EXTRA_MESSAGE_ID),
        )

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
        val url = CrmOrigin.sanitizeRestoredUrl(webView.url) ?: return
        prefs().edit().putString(KEY_LAST_URL, url).apply()
    }

    private fun lastVisitedUrl(): String? =
        CrmOrigin.sanitizeRestoredUrl(prefs().getString(KEY_LAST_URL, null))

    // ── Error surface ────────────────────────────────────────────────────

    private fun showError(message: String) {
        errorText.text = message
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

    // ── Local test notifications (stage 1 only) ──────────────────────────

    private fun requestNotificationPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) {
            TestNotificationSeed.ensureDiagnosticsNotification(this)
            return
        }
        val granted = ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) ==
            PackageManager.PERMISSION_GRANTED
        if (granted) {
            TestNotificationSeed.ensureDiagnosticsNotification(this)
        } else {
            notificationPermission.launch(Manifest.permission.POST_NOTIFICATIONS)
        }
    }

    companion object {
        private const val TAG = "YokoShell"
        private const val PREFS = "yoko_shell"
        private const val KEY_LAST_URL = "last_url"
    }
}
