package ru.yokoone.crm.shell

import android.util.Log
import org.json.JSONObject

/**
 * The whole native surface exposed to the web page.
 *
 * It is installed with [androidx.webkit.WebViewCompat.addWebMessageListener],
 * whose allowed-origin rule is enforced by the WebView itself: a page served
 * from anywhere other than the pinned CRM origin never sees `window.YokoShell`
 * at all. That is why this is used instead of `addJavascriptInterface`, which
 * injects into every frame regardless of origin.
 *
 * Two operations are accepted and nothing else. Neither can navigate the shell
 * to a URL of the page's choosing, read a file, or reach a device capability —
 * the page can only tell the shell something about its own state.
 */
class ShellBridge(
    private val onDeepLinkApplied: () -> Unit,
    private val onSessionExpired: () -> Unit,
) {

    fun handle(rawMessage: String?) {
        val op = parseOp(rawMessage)
        when (op) {
            OP_DEEPLINK_APPLIED -> onDeepLinkApplied()
            OP_SESSION_EXPIRED -> onSessionExpired()
            else -> Log.w(TAG, "rejected bridge message: unsupported operation")
        }
    }

    private fun parseOp(rawMessage: String?): String? {
        val raw = rawMessage ?: return null
        if (raw.length > MAX_MESSAGE_BYTES) return null
        return runCatching { JSONObject(raw).optString("op") }
            .getOrNull()
            ?.takeIf { it in ALLOWED_OPS }
    }

    companion object {
        private const val TAG = "YokoShellBridge"

        /** Name of the injected object. Kept boring on purpose. */
        const val JS_OBJECT_NAME = "YokoShell"

        /** The page reports that it has consumed the deep-link target. */
        const val OP_DEEPLINK_APPLIED = "deeplink_applied"

        /** The page reports that the mobile session is no longer valid. */
        const val OP_SESSION_EXPIRED = "session_expired"

        private val ALLOWED_OPS = setOf(OP_DEEPLINK_APPLIED, OP_SESSION_EXPIRED)

        private const val MAX_MESSAGE_BYTES = 2048
    }
}
