package ru.yokoone.crm.shell

import android.net.Uri

/**
 * Origin pinning and URL construction for the shell.
 *
 * Everything the shell is ever allowed to load is derived here from the
 * compile-time [BuildConfig.CRM_ORIGIN]. Nothing in an Intent, a notification
 * payload, a saved instance state or a web page can widen it:
 *
 *  - [isInAppUrl] decides what stays inside the WebView.
 *  - [buildOpenChatUrl] rejects a notification payload that is not a plain
 *    chat identifier and a known channel tab, so a payload can never become an
 *    arbitrary URL. It also never builds the messenger URL directly: it points
 *    at the CRM's own server-side gate, which re-checks the session and the
 *    chat before it decides where the browser actually lands.
 *
 * The functions are pure so they can be exercised by JVM unit tests without a
 * device or an emulator.
 */
object CrmOrigin {

    /** Canonical origin. The bridge trusts this and only this. */
    const val ORIGIN: String = BuildConfig.CRM_ORIGIN

    /**
     * Hosts rendered inside the shell. `www` is the same deployment behind the
     * same certificate and the CRM redirects it to the apex host; accepting it
     * avoids bouncing an ordinary in-app link out to the system browser.
     */
    private val IN_APP_HOSTS: Set<String> = buildSet {
        val canonical = Uri.parse(ORIGIN).host.orEmpty().lowercase()
        if (canonical.isNotEmpty()) {
            add(canonical)
            add("www.$canonical")
        }
    }

    /** Channel tabs the CRM messenger accepts. Anything else is dropped. */
    private val KNOWN_CHANNEL_TABS = setOf("all", "wa", "tg", "max", "av", "phone", "gost")

    /** Identifier shape accepted from a notification payload (cuid / uuid-like). */
    private val SAFE_ID = Regex("^[A-Za-z0-9_-]{1,64}$")

    /** Schemes the shell will hand to another app. Everything else is ignored. */
    private val EXTERNAL_SCHEMES = setOf("http", "https", "tel", "mailto")

    /** Where a cold start with no deep link lands: the Messenger, not the CRM home. */
    fun startUrl(): String = ORIGIN + BuildConfig.MESSENGER_PATH

    fun isInAppUrl(url: String?): Boolean {
        val uri = runCatching { Uri.parse(url ?: return false) }.getOrNull() ?: return false
        if (!uri.isAbsolute) return false
        if (!uri.scheme.equals("https", ignoreCase = true)) return false
        val host = uri.host?.lowercase() ?: return false
        return host in IN_APP_HOSTS
    }

    /** True when the shell may hand this URL to another app instead of rendering it. */
    fun isLaunchableExternally(url: String?): Boolean {
        val uri = runCatching { Uri.parse(url ?: return false) }.getOrNull() ?: return false
        val scheme = uri.scheme?.lowercase() ?: return false
        return scheme in EXTERNAL_SCHEMES && !isInAppUrl(url)
    }

    /**
     * Build the server-side open-chat URL for a notification target, or null if
     * the payload is not something this shell is willing to act on.
     *
     * The result is always on the pinned origin and always goes through the
     * CRM gate; the chat id is carried as a query value, never spliced into a
     * path, and a payload that fails [SAFE_ID] produces no navigation at all.
     */
    fun buildOpenChatUrl(chatId: String?, channelTab: String?, messageId: String?): String? {
        val chat = chatId?.trim().orEmpty()
        if (!SAFE_ID.matches(chat)) return null

        val builder = Uri.parse(ORIGIN + BuildConfig.OPEN_CHAT_PATH)
            .buildUpon()
            .appendQueryParameter("chat", chat)

        val channel = channelTab?.trim()?.lowercase().orEmpty()
        if (channel.isNotEmpty() && channel in KNOWN_CHANNEL_TABS) {
            builder.appendQueryParameter("channel", channel)
        }

        val message = messageId?.trim().orEmpty()
        if (message.isNotEmpty() && SAFE_ID.matches(message)) {
            builder.appendQueryParameter("msg", message)
        }

        return builder.build().toString()
    }

    /**
     * Validate a URL restored from saved state or preferences before reloading
     * it. State survives process death, so it is treated as untrusted input.
     */
    fun sanitizeRestoredUrl(url: String?): String? = if (isInAppUrl(url)) url else null
}
