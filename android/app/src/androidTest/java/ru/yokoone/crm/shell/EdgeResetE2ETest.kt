package ru.yokoone.crm.shell

import android.content.Context
import android.content.Intent
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import android.webkit.CookieManager
import android.webkit.WebView
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import ru.yokoone.crm.shell.push.PushRegistrar
import ru.yokoone.crm.shell.push.PushRegistrationWorker
import ru.yokoone.crm.shell.push.PushTokenState

/**
 * I layer, end to end on the emulator, with real process deaths.
 *
 * Each scenario has a phase A that signs in and then either triggers a reset
 * (and is expected to die with the app process: `Runtime.exit` ends the
 * instrumentation too) or injects a deterministic fault into durable state
 * and returns. The workflow then kills or relaunches the process as the
 * scenario needs and runs [e00_verifyFreshContext] attached to the new process.
 * Only state the production code itself reads is touched; no product hook exists.
 */
@RunWith(AndroidJUnit4::class)
class EdgeResetE2ETest {

    private lateinit var device: UiDevice
    private val targetPackage = "ru.yokoone.crm.shell.acceptance"
    private val user = "acceptance"
    private val password = "yoko acceptance passphrase"
    private val args get() = InstrumentationRegistry.getArguments()
    private val app: Context get() = InstrumentationRegistry.getInstrumentation().targetContext

    @Before
    fun prepare() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        shell("pm grant $targetPackage android.permission.POST_NOTIFICATIONS")
    }

    // ── phase A: trigger a reset and die with the process ────────────────

    @Test
    fun e01_operatorSwitchFromTheShortcutTarget() {
        signedIn("E01")
        app.startActivity(Intent(app, OperatorResetActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        expectProcessEnd("E01")
    }

    @Test
    fun e03_legacyLoginNavigationIsRefused() {
        signedIn("E03")
        javascript("window.location.href = '/login';")
        expectProcessEnd("E03")
    }

    @Test
    fun e04_legacyLoginRscFetchIsRefused() {
        signedIn("E04")
        javascript("fetch('/login?_rsc=i04', {credentials: 'include'}).catch(function () {});")
        expectProcessEnd("E04")
    }

    @Test
    fun e05_operatorRewriteAfterValidIsRefused() {
        signedIn("E05")
        val jar = CookieManager.getInstance()
        if (ShellNavigationGuard.cookieValue(jar.getCookie(CrmOrigin.ORIGIN), ShellNavigationGuard.OPERATOR_COOKIE_NAME) == null) {
            jar.setCookie(CrmOrigin.ORIGIN, "${ShellNavigationGuard.OPERATOR_COOKIE_NAME}=op_fence_a; Path=/")
        }
        // A VALID observation binds the operator the jar holds now.
        javascript("history.pushState({}, '', location.pathname + '?fence=bind');")
        SystemClock.sleep(2_000)
        EdgeDeviceSupport.mark("E05 rewriting operator cookie")
        jar.setCookie(CrmOrigin.ORIGIN, "${ShellNavigationGuard.OPERATOR_COOKIE_NAME}=op_fence_b; Path=/")
        javascript("fetch('/messages?fence=after', {credentials: 'include'}).catch(function () {});")
        expectProcessEnd("E05")
    }

    // ── phase A: inject a fault into durable state, then the workflow kills ──

    @Test
    fun e06_durableIntentWrittenThenKilled() {
        signedIn("E06")
        PushTokenState.beginReset(app, EdgeContextReset.Reason.OPERATOR_SWITCH, System.currentTimeMillis(), SystemClock.elapsedRealtime())
        CookieManager.getInstance().flush()
        assertTrue("precondition: the old session cookie is still in the jar", sessionCookiePresent())
        EdgeDeviceSupport.mark("E06 step0-only reset_pending=${PushTokenState.resetPending(app)}")
    }

    @Test
    fun e08_backgroundedWithStateThenDurableIntentThenKilled() {
        signedIn("E08")
        device.pressHome()
        assertTrue(device.wait(Until.gone(By.pkg(targetPackage).depth(0)), 20_000))
        SystemClock.sleep(1_500)
        PushTokenState.beginReset(app, EdgeContextReset.Reason.OPERATOR_SWITCH, System.currentTimeMillis(), SystemClock.elapsedRealtime())
        CookieManager.getInstance().flush()
        assertTrue(sessionCookiePresent())
        EdgeDeviceSupport.mark("E08 backgrounded step0-only")
    }

    /** E08 V2, step 1: sign in only; the workflow then starts the activity outside instrumentation. */
    @Test
    fun e08a_signInOnly() {
        signedIn("E08")
        awaitRecord()
        CookieManager.getInstance().flush()
        EdgeDeviceSupport.mark("E08 V2 signed-in pid=${android.os.Process.myPid()}")
    }

    /**
     * E08 V2, step 2: attached with --no-restart to the backgrounded process, no
     * UI at all; writes the durable reset intent (step 0) exactly as if the
     * process were killed right after it, leaving the old session cookie in the jar.
     */
    @Test
    fun e08b_injectDurableIntentOnly() {
        assertTrue("E08: precondition — the old session cookie is in the jar", sessionCookiePresent())
        PushTokenState.beginReset(app, EdgeContextReset.Reason.OPERATOR_SWITCH, System.currentTimeMillis(), SystemClock.elapsedRealtime())
        CookieManager.getInstance().flush()
        EdgeDeviceSupport.mark("E08 V2 step0-only reset_pending=${PushTokenState.resetPending(app)} pid=${android.os.Process.myPid()}")
    }

    @Test
    fun e09_contextKeyLostThenKilled() {
        signedIn("E09")
        awaitRecord()
        EdgeDeviceSupport.deleteShellKeys(ShellKeys.CONTEXT_ALIAS_PREFIX)
        CookieManager.getInstance().flush()
        EdgeDeviceSupport.mark("E09 K_ctx deleted")
    }

    @Test
    fun e10_edgeGateAppearsThenKilled() {
        signedIn("E10")
        awaitRecord()
        PushTokenState.setEdgeGate(app, ContinuityGuard.EdgeGate.PRESENT)
        CookieManager.getInstance().flush()
        EdgeDeviceSupport.mark("E10 gate=PRESENT")
    }

    @Test
    fun e11_recordTamperedThenKilled() {
        signedIn("E11")
        awaitRecord()
        val prefs = app.getSharedPreferences(PushTokenState.PREFS_NAME, Context.MODE_PRIVATE)
        val mac = prefs.getString("crm_ctx_mac", null)
        assertNotNull("no record MAC to tamper with", mac)
        val flipped = (if (mac!![0] == 'a') "b" else "a") + mac.substring(1)
        assertTrue(prefs.edit().putString("crm_ctx_mac", flipped).commit())
        CookieManager.getInstance().flush()
        EdgeDeviceSupport.mark("E11 record MAC tampered")
    }

    @Test
    fun e12_registrationWorkQueuedWithRotationPendingThenKilled() {
        signedIn("E12")
        shell("cmd connectivity airplane-mode enable")
        SystemClock.sleep(3_000)
        val token = "i12-acceptance-token-0123456789"
        PushTokenState.rememberToken(app, token)
        val generation = PushTokenState.startSessionGeneration(app).sessionGeneration
        val prefs = app.getSharedPreferences(PushTokenState.PREFS_NAME, Context.MODE_PRIVATE)
        assertTrue(prefs.edit().putBoolean("token_rotation_pending", true).commit())
        PushRegistrationWorker.enqueue(app, generation, token)
        EdgeDeviceSupport.mark("E12 work queued offline generation=$generation rotation_pending=true")
    }

    // ── phase B: attached to the relaunched process ──────────────────────

    /**
     * The context after a reset (or its completion): the CRM shows its login,
     * the old session cookie is gone, the reset is complete, push display is
     * off, a rotation is owed, no continuity record exists — and, in order, the
     * completion happened before the first page load of the new process.
     */
    @Test
    fun e00_verifyFreshContext() {
        val id = args.getString("scenario").orEmpty()
        val expectReason = args.getString("expectReason")
        val expectMismatch = args.getString("expectMismatch")
        assertTrue(
            "$id: the relaunched shell does not show the CRM login; on screen: ${visibleText()}",
            device.wait(Until.hasObject(By.textContains("Вход в мобильное приложение")), 60_000),
        )
        assertFalse("$id: the old session cookie survived", sessionCookiePresent())
        assertNull("$id: reset_pending still set", PushTokenState.resetPending(app))
        val s = PushTokenState.snapshot(app)
        assertFalse("$id: push display re-enabled without a current-ticket 200", s.displayAllowed)
        assertTrue("$id: no rotation owed after a reset", s.rotationPending)
        assertNull("$id: no token may survive a reset", s.newestToken)
        assertNull("$id: a continuity record survived", PushTokenState.continuityRecord(app).body)

        val lines = EdgeDeviceSupport.diagnostics()
        if (expectReason != null) {
            assertTrue("$id: no reset with reason $expectReason; ${tail(lines)}", lines.any { it.second.contains("edge-reset start reason=$expectReason") })
        }
        if (expectMismatch != null) {
            assertTrue("$id: no continuity mismatch '$expectMismatch'; ${tail(lines)}", lines.any { it.second.contains("continuity mismatch reason=$expectMismatch") })
        }
        val mine = android.os.Process.myPid()
        val own = lines.filter { it.first == mine }.map { it.second }
        val completed = own.indexOfFirst { it.contains("edge-reset completed") }
        val firstLoad = own.indexOfFirst { it.startsWith("nav start http") }
        assertTrue("$id: this process did not complete the reset; ${own.takeLast(12)}", completed >= 0)
        assertTrue("$id: a page loaded before the reset completed (load at $firstLoad, completion at $completed)", firstLoad < 0 || completed < firstLoad)
        EdgeDeviceSupport.mark("$id VERIFIED pid=$mine completedAt=$completed firstLoadAt=$firstLoad")
    }

    // ── plumbing ─────────────────────────────────────────────────────────

    private fun signedIn(id: String) {
        device.pressHome()
        val launch = app.packageManager.getLaunchIntentForPackage(targetPackage)!!
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
        InstrumentationRegistry.getInstrumentation().context.startActivity(launch)
        var shown = device.wait(Until.hasObject(By.textContains("Вход в мобильное приложение")), 90_000)
        if (!shown) {
            // One relaunch: a first WebView start after `pm clear` can stall the page.
            EdgeDeviceSupport.mark("$id sign-in not shown after 90 s; relaunching once; ${tail(EdgeDeviceSupport.diagnostics())}")
            InstrumentationRegistry.getInstrumentation().context.startActivity(launch)
            shown = device.wait(Until.hasObject(By.textContains("Вход в мобильное приложение")), 90_000)
        }
        assertTrue("$id: no sign-in screen; on screen: ${visibleText()}; ${tail(EdgeDeviceSupport.diagnostics())}", shown)
        device.wait(Until.hasObject(By.textContains("Сотрудник")), 20_000)
        val candidates = (device.findObjects(By.textContains("Выберите")) + device.findObjects(By.textContains("Сотрудник"))).distinct()
        val picker = candidates.firstOrNull { it.isClickable } ?: candidates.firstOrNull { it.className != "android.widget.TextView" }
        assertNotNull("$id: no operator select", picker)
        picker!!.click()
        val option = device.wait(Until.findObject(By.textContains("Мария")), 20_000)
        assertNotNull("$id: operator list did not open", option)
        option!!.click()
        val fields = device.wait(Until.findObjects(By.clazz("android.widget.EditText")), 20_000)
        assertTrue("$id: sign-in fields not found", fields != null && fields.size >= 2)
        fields!![0].text = user
        fields[1].text = password
        val submit = device.wait(Until.findObject(By.text("Войти")), 20_000)
        assertNotNull("$id: submit not found", submit)
        submit!!.click()
        assertTrue(
            "$id: the messenger did not open; on screen: ${visibleText()}",
            device.wait(Until.hasObject(By.textContains("Тест · MAX")), 45_000),
        )
        SystemClock.sleep(1_500)
        assertTrue("$id: no session cookie after sign-in", sessionCookiePresent())
        EdgeDeviceSupport.mark("$id signed-in pid=${android.os.Process.myPid()}")
    }

    private fun expectProcessEnd(id: String) {
        EdgeDeviceSupport.mark("$id reset-triggered")
        SystemClock.sleep(30_000)
        fail("$id: the process did not end within 30 s; ${tail(EdgeDeviceSupport.diagnostics())}")
    }

    private fun awaitRecord() {
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (PushTokenState.continuityRecord(app).body != null) return
            SystemClock.sleep(250)
        }
        fail("the continuity record was never written; ${tail(EdgeDeviceSupport.diagnostics())}")
    }

    private fun javascript(source: String) {
        var webView: WebView? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            val activity = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).firstOrNull()
            webView = activity?.findViewById(R.id.web_view)
        }
        assertNotNull("no resumed shell WebView", webView)
        InstrumentationRegistry.getInstrumentation().runOnMainSync { webView!!.evaluateJavascript(source, null) }
    }

    private fun sessionCookiePresent(): Boolean =
        PushRegistrar.sessionCookiePair(CookieManager.getInstance().getCookie(CrmOrigin.ORIGIN)) != null

    private fun shell(command: String) {
        val fd = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
        ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes() }
    }

    private fun tail(lines: List<Pair<Int, String>>): String = lines.takeLast(14).joinToString(" | ") { "${it.first}:${it.second.take(90)}" }

    private fun visibleText(limit: Int = 240): String = runCatching {
        device.findObjects(By.textStartsWith("")).mapNotNull { it.text?.trim() }.filter { it.isNotEmpty() }.joinToString(" | ").take(limit)
    }.getOrDefault("<unreadable>")

    @Suppress("unused")
    private fun same(a: Any?, b: Any?) = assertEquals(a, b)
}
