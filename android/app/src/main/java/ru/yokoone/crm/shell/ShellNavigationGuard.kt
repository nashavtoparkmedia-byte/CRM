package ru.yokoone.crm.shell

import android.net.Uri

/**
 * Two in-process guards on the CRM's own navigation (pure, JVM-testable).
 *
 * 1. Legacy `/login` (R5.1 §5.2, §5.9, INV-21; Security R5-1). The CRM TopBar
 *    «Выйти» deletes only `crm_user_id` and navigates to the legacy operator
 *    list at `/login`, leaving the mobile session alive. With a mobile session
 *    present, any request for exactly `/login` on the pinned origin — a main
 *    frame, a client-side route change or an RSC fetch (`?_rsc=`) — is refused
 *    and the context is reset (OPERATOR_SWITCH). Keyed on the presence of the
 *    session cookie, so it holds in every process, not only after a VALID page.
 *
 * 2. Operator fence (client side of the external BR-4 dependency). The TopBar
 *    operator dropdown rewrites `crm_user_id` without a navigation. The shell
 *    binds the value it saw at the first VALID page of the process and refuses
 *    any later in-app request made while the jar holds a different (or no)
 *    value, resetting the context instead. The value is compared, never logged,
 *    never stored, and the session token is never decoded. This narrows the
 *    window; the authoritative fix (derive the operator from the signed `op`)
 *    is owned by Identity Access.
 */
object ShellNavigationGuard {

    const val LEGACY_LOGIN_PATH = "/login"
    const val OPERATOR_COOKIE_NAME = "crm_user_id"

    /** Exactly `/login` (trailing slash tolerated), any query, on the pinned origin or its `www` alias. */
    fun isLegacyLogin(url: String?): Boolean {
        if (url == null || !CrmOrigin.isInAppUrl(url)) return false
        val path = Uri.parse(url).path ?: return false
        return path == LEGACY_LOGIN_PATH || path == "$LEGACY_LOGIN_PATH/"
    }

    /** True when a request for [url] must be refused because a mobile session exists. */
    fun refusesLegacyLogin(url: String?, sessionCookiePresent: Boolean, sessionWasValid: Boolean): Boolean =
        isLegacyLogin(url) && (sessionCookiePresent || sessionWasValid)

    fun cookieValue(header: String?, name: String): String? {
        val raw = header ?: return null
        for (part in raw.split(";")) {
            val pair = part.trim()
            if (pair.startsWith("$name=")) return pair.substring(name.length + 1)
        }
        return null
    }

    /** The `crm_user_id` bound at the first VALID page of this process. */
    class OperatorFence {

        @Volatile
        private var bound: String? = null

        @Volatile
        private var armed = false

        val isArmed: Boolean get() = armed

        /** Bind at the first VALID page; a missing value binds as soon as one appears. */
        fun bind(jar: String?) {
            if (armed) return
            val value = cookieValue(jar, OPERATOR_COOKIE_NAME)?.takeIf { it.isNotEmpty() } ?: return
            bound = value
            armed = true
        }

        /** True when the jar no longer carries the bound operator. */
        fun isViolated(jar: String?): Boolean {
            if (!armed) return false
            val current = cookieValue(jar, OPERATOR_COOKIE_NAME)
            return current != bound
        }
    }
}
