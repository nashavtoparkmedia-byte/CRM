package ru.yokoone.crm.shell.push

import android.webkit.CookieManager
import androidx.annotation.VisibleForTesting
import org.json.JSONObject
import ru.yokoone.crm.shell.BuildConfig
import ru.yokoone.crm.shell.CrmOrigin
import java.io.IOException
import java.net.HttpURLConnection
import java.net.URL

/**
 * The shell's only outbound request, and the narrowest one that can do the job.
 *
 * It speaks to exactly one URL, derived at compile time from the pinned origin,
 * with the session cookie the WebView already holds. There is no base-URL
 * parameter on the production path, no redirect following, no retry loop, no
 * response body parsed beyond a single error code, and no second endpoint this
 * could grow into: it is not an API client and must not become one.
 *
 * Why the cookie can be read at all: it is httpOnly, which keeps it away from
 * page JavaScript, not from the app that owns the WebView. CookieManager is
 * that app. Nothing here copies, stores, hashes or logs the value — it is read
 * out of the jar, put on one request, and forgotten.
 *
 * Every outcome is one of three kinds, because the caller only ever needs three
 * decisions: it worked, it will never work as asked (stop), or the network was
 * unhelpful (try again later under a bounded policy).
 */
object PushRegistrar {

    const val SESSION_COOKIE_NAME = "yoko_mobile_session"

    /** Mirrors PUSH_TOKEN in gravity-mvp/src/contracts/identity-access/v1. */
    private val TOKEN_SHAPE = Regex("^[A-Za-z0-9_:-]{20,512}$")

    private const val CONNECT_TIMEOUT_MS = 10_000
    private const val READ_TIMEOUT_MS = 10_000

    sealed interface Outcome {
        /** The CRM accepted the registration. */
        data object Registered : Outcome

        /** The CRM (or this shell) refused; retrying the same thing cannot help. */
        data class Refused(val code: String) : Outcome

        /** Nothing was decided; the request may be repeated later. */
        data class Retryable(val detail: String) : Outcome
    }

    fun register(token: String): Outcome {
        if (!TOKEN_SHAPE.matches(token)) return Outcome.Refused("INVALID_TOKEN_SHAPE")
        val cookie = sessionCookiePair(CookieManager.getInstance().getCookie(CrmOrigin.ORIGIN))
            ?: return Outcome.Refused("NO_SESSION_COOKIE")
        return post(endpoint(), token, cookie)
    }

    private fun endpoint(): String = CrmOrigin.ORIGIN + BuildConfig.PUSH_REGISTRATION_PATH

    /**
     * Pick out the one cookie this request needs.
     *
     * The jar for the origin also holds the derived UI identity value the
     * Messenger reads, and sending it would be sending more than the request
     * requires. The endpoint authenticates on the session cookie alone.
     */
    @VisibleForTesting
    fun sessionCookiePair(header: String?): String? {
        val raw = header ?: return null
        for (part in raw.split(";")) {
            val pair = part.trim()
            if (pair.startsWith("$SESSION_COOKIE_NAME=") && pair.length > SESSION_COOKIE_NAME.length + 1) {
                return pair
            }
        }
        return null
    }

    @VisibleForTesting
    fun post(endpoint: String, token: String, cookiePair: String): Outcome {
        var connection: HttpURLConnection? = null
        return try {
            connection = (URL(endpoint).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                // A redirect is never a valid answer here. Following one would
                // put the session cookie on a URL the shell never chose.
                instanceFollowRedirects = false
                connectTimeout = CONNECT_TIMEOUT_MS
                readTimeout = READ_TIMEOUT_MS
                useCaches = false
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
                setRequestProperty("Accept", "application/json")
                setRequestProperty("Cookie", cookiePair)
            }

            // The token shape is validated above and contains no character that
            // JSON would have to escape, so the body is built directly rather
            // than through a serializer this module would otherwise not need.
            connection.outputStream.use { it.write("""{"token":"$token"}""".toByteArray(Charsets.UTF_8)) }

            when (val status = connection.responseCode) {
                200 -> Outcome.Registered
                401, 409, 422, 400, 413, 415 -> Outcome.Refused(errorCode(connection, status))
                in 300..399 -> Outcome.Refused("UNEXPECTED_REDIRECT")
                in 500..599 -> Outcome.Retryable("http_$status")
                else -> Outcome.Retryable("http_$status")
            }
        } catch (error: IOException) {
            Outcome.Retryable(error.javaClass.simpleName)
        } finally {
            connection?.disconnect()
        }
    }

    /**
     * Read the named failure the CRM returned, or fall back to the status.
     *
     * Only the `error` field is read, and only to decide whether a retry could
     * ever help. Nothing from the response is stored or displayed.
     */
    private fun errorCode(connection: HttpURLConnection, status: Int): String {
        val body = runCatching {
            connection.errorStream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
        }.getOrNull().orEmpty()
        val code = runCatching { JSONObject(body).optString("error") }.getOrNull().orEmpty()
        return code.ifEmpty { "HTTP_$status" }
    }
}
