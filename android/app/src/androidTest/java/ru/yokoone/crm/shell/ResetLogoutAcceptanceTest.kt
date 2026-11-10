package ru.yokoone.crm.shell

import android.content.Context
import android.content.Intent
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.webkit.CookieManager
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters
import ru.yokoone.crm.shell.push.PushRegistrar
import java.io.File
import java.net.HttpURLConnection
import java.net.Proxy
import java.net.URL

/**
 * Reset logout (F-1, docs/mobile/ANDROID_EDGE_R51_AMENDMENTS.md A1) on a real
 * Android system, against a disposable CRM that carries the identity_access
 * logout endpoint.
 *
 * Two scenarios, run by the workflow in this order and never on their own:
 *
 * - test15 signs in, keeps the session cookie pair, and starts the target of the
 *   «Выйти и сменить сотрудника» shortcut. The reset that follows ends the
 *   process and the instrumentation with it, which is the expected outcome; the
 *   workflow asserts it, and that the only request the shell made during the
 *   reset was its one logout.
 * - test16 presents the kept cookie to the CRM, natively, and expects the logout
 *   barrier to refuse it. A 204 from the logout endpoint alone proves nothing,
 *   because the endpoint answers 204 for a session that was already dead too.
 *
 * The cookie pair is kept in the app's own no-backup directory, the same
 * private storage that holds the WebView's cookie database. It never leaves the
 * device, is never logged, and is deleted the moment test16 reads it.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class ResetLogoutAcceptanceTest {

    private lateinit var device: UiDevice

    private val targetPackage = "ru.yokoone.crm.shell.acceptance"
    private val user = "acceptance"
    private val password = "yoko acceptance passphrase"

    private val app: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Before
    fun prepare() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
    }

    @Test
    fun test15_signInThenSwitchOperatorFromTheShortcut() {
        launchApp()
        signIn()
        assertMessengerOpen()

        val jar = CookieManager.getInstance()
        jar.flush()
        val pair = PushRegistrar.sessionCookiePair(jar.getCookie(CrmOrigin.ORIGIN))
        assertNotNull("signed in, yet the jar holds no session cookie", pair)
        stash().writeText(pair!!)
        step("kept")

        // The shortcut's own target, started by the app's own uid exactly as
        // the launcher starts it on the app's behalf (it is not exported).
        app.startActivity(Intent(app, OperatorResetActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))

        // The reset ends this process. Getting past this wait means it did not.
        SystemClock.sleep(RESET_TIMEOUT)
        fail("the operator switch did not end the process within $RESET_TIMEOUT ms; shell: ${resetLines()}")
    }

    @Test
    fun test16_theOldSessionIsRefusedAfterTheResetLogout() {
        val file = stash()
        assertTrue("test15 kept no session to present", file.isFile)
        val pair = try {
            file.readText()
        } finally {
            file.delete()
        }
        assertEquals("the kept value is not one session cookie pair", pair, PushRegistrar.sessionCookiePair(pair))
        assertNull(
            "the reset left a session cookie in the jar",
            PushRegistrar.sessionCookiePair(CookieManager.getInstance().getCookie(CrmOrigin.ORIGIN)),
        )

        // As a native client presents it, without the shell marker (the same
        // lane as the shell's own registrar): the route refuses and names the
        // logout barrier. Only a session that verified and is then barred gets
        // this code; a damaged or unknown cookie gets MOBILE_SESSION_REQUIRED.
        val native = request("POST", PUSH_REGISTRATION_PATH, pair, shellLane = false)
        step("native status=${native.status} error=${native.error}")
        assertEquals("native push-registration with the old cookie", 401, native.status)
        assertEquals("native push-registration with the old cookie", "MOBILE_SESSION_REVOKED", native.error)

        // In the shell lane the request boundary refuses it first.
        val shell = request("POST", PUSH_REGISTRATION_PATH, pair, shellLane = true)
        step("shell status=${shell.status} error=${shell.error}")
        assertEquals("shell-lane push-registration with the old cookie", 401, shell.status)
        assertEquals("shell-lane push-registration with the old cookie", "mobile_session_required", shell.error)

        // And a page in the shell lane goes back to sign-in.
        val page = request("GET", BuildConfig.MESSENGER_PATH, pair, shellLane = true)
        val target = page.location?.let { runCatching { URL(URL(CrmOrigin.ORIGIN), it).path }.getOrNull() }
        step("page status=${page.status} location=$target")
        assertEquals("shell-lane page with the old cookie", 303, page.status)
        assertEquals("shell-lane page with the old cookie", CrmOrigin.LOGIN_PATH, target)
    }

    // ── the probe ────────────────────────────────────────────────────────

    private class Answer(val status: Int, val error: String?, val location: String?)

    /**
     * One request with the kept cookie and nothing else from any jar. No
     * redirect is followed and no proxy consulted; nothing of the request or
     * the answer but the status, the error code and the redirect path is read.
     */
    private fun request(method: String, path: String, cookiePair: String, shellLane: Boolean): Answer {
        val connection = URL(CrmOrigin.ORIGIN + path).openConnection(Proxy.NO_PROXY) as HttpURLConnection
        return try {
            connection.requestMethod = method
            connection.instanceFollowRedirects = false
            connection.connectTimeout = REQUEST_TIMEOUT_MS
            connection.readTimeout = REQUEST_TIMEOUT_MS
            connection.useCaches = false
            connection.setRequestProperty("Cookie", cookiePair)
            if (shellLane) {
                connection.setRequestProperty(
                    "User-Agent",
                    "Mozilla/5.0 (Linux; Android) ${CrmOrigin.SHELL_UA_TOKEN}${CrmOrigin.SHELL_UA_VERSION}",
                )
            }
            if (method == "POST") {
                connection.doOutput = true
                connection.setRequestProperty("Content-Type", "application/json")
                connection.outputStream.use { it.write("""{"token":"$PROBE_TOKEN"}""".toByteArray(Charsets.UTF_8)) }
            }
            val status = connection.responseCode
            val body = runCatching {
                (connection.errorStream ?: connection.inputStream)?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
            }.getOrNull().orEmpty()
            val error = runCatching { JSONObject(body).optString("error") }.getOrNull()?.ifEmpty { null }
            Answer(status, error, connection.getHeaderField("Location"))
        } finally {
            connection.disconnect()
        }
    }

    private fun stash(): File = File(app.noBackupFilesDir, STASH_NAME)

    // ── the shell ────────────────────────────────────────────────────────

    private fun launchApp() {
        device.pressHome()
        val context = InstrumentationRegistry.getInstrumentation().context
        val intent = context.packageManager.getLaunchIntentForPackage(targetPackage)
            ?.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
        assertNotNull("launch intent for $targetPackage", intent)
        context.startActivity(intent)
        assertTrue(
            "app did not reach the sign-in screen; on screen: ${visibleText()}",
            device.wait(Until.hasObject(By.textContains("Вход в мобильное приложение")), LAUNCH_TIMEOUT),
        )
    }

    /** The same form, filled the same way as in LoginAcceptanceTest and PushAcceptanceTest. */
    private fun signIn() {
        device.wait(Until.hasObject(By.textContains("Сотрудник")), ACTION_TIMEOUT)
        val candidates = (
            device.findObjects(By.textContains("Выберите")) +
                device.findObjects(By.textContains("Сотрудник"))
            ).distinct()
        val picker = candidates.firstOrNull { it.isClickable }
            ?: candidates.firstOrNull { it.className != "android.widget.TextView" }
        assertNotNull("no clickable operator select; on screen: ${visibleText()}", picker)
        picker!!.click()

        val option = device.wait(Until.findObject(By.textContains("Мария")), ACTION_TIMEOUT)
        assertNotNull("the operator list did not open; on screen: ${visibleText()}", option)
        option!!.click()

        val fields = device.wait(Until.findObjects(By.clazz("android.widget.EditText")), ACTION_TIMEOUT)
        assertNotNull("sign-in fields not found; on screen: ${visibleText()}", fields)
        assertTrue("expected a login and a password field, found ${fields.size}", fields.size >= 2)
        fields[0].text = user
        fields[1].text = password

        val submit = device.wait(Until.findObject(By.text("Войти")), ACTION_TIMEOUT)
        assertNotNull("submit button not found; on screen: ${visibleText()}", submit)
        submit.click()
    }

    private fun assertMessengerOpen() {
        val open = device.wait(Until.hasObject(By.textContains(MAX_CHAT)), MESSENGER_TIMEOUT)
        step(if (open) "signed-in" else "no-messenger")
        assertTrue("the messenger did not open after sign-in; on screen: ${visibleText()}", open)
    }

    /**
     * One line where the job can publish it. Shaped as a `fail` line on
     * purpose: the workflow counts `done` lines with a path as requests.
     */
    private fun step(label: String) {
        ShellDiagnostics.write("YOKO_NET fail reset-logout-acceptance $label")
    }

    /** The reset's own lines, for a failure message worth reading. */
    private fun resetLines(): String = runCatching {
        val fd = InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("logcat -d -s ${ShellDiagnostics.TAG}:E")
        ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().toString(Charsets.UTF_8) }
    }.getOrDefault("")
        .lineSequence()
        .filter { it.contains("edge-reset") || it.contains("reset-logout") || it.contains("session/logout") }
        .map { it.substringAfter("${ShellDiagnostics.TAG}: ").trim() }
        .toList()
        .takeLast(6)
        .joinToString(" | ")
        .ifEmpty { "<no reset lines>" }

    private fun visibleText(limit: Int = 260): String = runCatching {
        device.findObjects(By.textStartsWith(""))
            .mapNotNull { it.text?.trim() }
            .filter { it.isNotEmpty() }
            .joinToString(" | ")
            .take(limit)
    }.getOrDefault("<unreadable>")

    private companion object {
        const val LAUNCH_TIMEOUT = 60_000L
        const val ACTION_TIMEOUT = 20_000L
        const val MESSENGER_TIMEOUT = 45_000L
        const val RESET_TIMEOUT = 60_000L
        const val REQUEST_TIMEOUT_MS = 10_000

        const val MAX_CHAT = "Тест · MAX"
        const val STASH_NAME = "reset-logout-acceptance.session"
        const val PUSH_REGISTRATION_PATH = "/api/mobile/push-registration"

        /** Well-formed and never seeded: a live session would register it, a barred one cannot. */
        const val PROBE_TOKEN = "reset-logout-acceptance-probe-0001"
    }
}
