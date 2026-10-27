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
import androidx.test.uiautomator.UiObject2
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
import ru.yokoone.crm.shell.push.PushTokenState

/**
 * B layer: the acceptance build pinned to `https://localhost:8443`, an
 * nginx 1.27 TLS front with HTTP Basic realm "YOKO CRM" (test CA trusted only
 * by this build, generated test logins), and the disposable CRM behind it.
 * Nothing here reaches production. The workflow switches nginx modes and kills
 * or relaunches the process between phases.
 */
@RunWith(AndroidJUnit4::class)
class EdgeGateBTest {

    private lateinit var device: UiDevice
    private val targetPackage = "ru.yokoone.crm.shell.acceptance"
    private val args get() = InstrumentationRegistry.getArguments()
    private val app: Context get() = InstrumentationRegistry.getInstrumentation().targetContext
    private val dialogTarget = "${EdgeAuthPolicy.EDGE_REALM} · ${EdgeAuthPolicy.PINNED_HOST}"

    private val staffA = "staff.a"
    private val passA get() = args.getString("passA") ?: "b-layer-pass-a"
    private val staffB = "staff.b"
    private val passB = "b-layer-pass-b"

    @Before
    fun prepare() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        shell("pm grant $targetPackage android.permission.POST_NOTIFICATIONS")
    }

    // ── B01: challenge, realm, hardened dialog, decline ⇒ rule F ─────────
    @Test
    fun b01_challengeOpensTheStaffDialogAndDeclineStops() {
        launch()
        awaitDialog("B01")
        assertEquals("B01: a fresh dialog asks for login and password", 2, dialogEdits().size)
        assertTrue(device.hasObject(By.text("Вход в CRM")))
        device.findObject(By.res("android", "button2")).click()
        assertTrue("B01: no rule-F panel after decline", device.wait(Until.hasObject(By.textContains("Нужен вход в CRM")), 20_000))
        SystemClock.sleep(10_000)
        assertFalse("B01: a second dialog appeared after decline", device.hasObject(By.textContains(dialogTarget)))
        assertTrue(PushTokenState.edgeGate(app) == ContinuityGuard.EdgeGate.PRESENT)
        mark("B01 PASS")
    }

    // ── B02: staff login through nginx, then the CRM mobile login ────────
    @Test
    fun b02_staffLoginThenCrmLogin() {
        launch()
        awaitDialog("B02")
        fill(staffA, passA)
        crmSignIn("B02")
        awaitRecord("B02")
        assertTrue(lines().any { it.contains("edge-auth authenticated") })
        mark("B02 PASS signed-in pid=${android.os.Process.myPid()}")
    }

    // ── B05 + B08 (after B02, same process): foreign realm, CRM 401 ─────
    @Test
    fun b05_foreignRealmAndCrm401OpenNoDialog() {
        // Self-contained: the JavaScript below needs an activity this instrumentation saw start.
        launch()
        awaitDialog("B05")
        fill(staffA, passA)
        crmSignIn("B05")
        // B08: the CRM's own 401s (no WWW-Authenticate) never open the edge dialog.
        SystemClock.sleep(3_000)
        assertFalse("B08: a CRM 401 opened the staff dialog", device.hasObject(By.textContains(dialogTarget)))
        // B05: a location with realm "YOKO Cash" on the pinned host never gets a dialog.
        // Whether Chromium attached the cached staff credential preemptively is
        // read from the nginx log by the workflow (auth=0/1).
        javascript("var i = new Image(); i.src = '/cash-gate/probe.png?' + Date.now();")
        SystemClock.sleep(5_000)
        assertFalse("B05: the foreign realm opened a dialog", device.hasObject(By.textContains(dialogTarget)))
        mark("B05 no-dialog refused=${lines().any { it.contains("edge-auth refused reason=realm") }}")
    }

    // ── B03: wrong password ×3 ⇒ EXHAUSTED; username pinned on re-prompt ─
    @Test
    fun b03_wrongPasswordThreeTimesExhausts() {
        launch()
        awaitDialog("B03")
        fill(staffA, "wrong-1")
        repeat(2) { attempt ->
            awaitDialog("B03 re-prompt ${attempt + 1}")
            assertTrue("B03: no «Пароль не подошёл»", device.wait(Until.hasObject(By.textContains("Пароль не подошёл")), 10_000))
            assertTrue("B03: username not pinned read-only", device.hasObject(By.textContains("Сотрудник: $staffA")))
            assertEquals("B03: pinned mode asks for the password only", 1, dialogEdits().size)
            fill(null, "wrong-${attempt + 2}")
        }
        assertTrue(
            "B03: no EXHAUSTED panel; on screen: ${visible()}",
            device.wait(Until.hasObject(By.textContains("Не удалось подтвердить доступ")), 30_000),
        )
        mark("B03 PASS")
    }

    // ── B04: the panel survives late page events; «Войти» releases it ────
    @Test
    fun b04_panelHoldSurvivesLateEventsAndReentryReleasesIt() {
        launch()
        awaitDialog("B04")
        device.findObject(By.res("android", "button2")).click()
        assertTrue("B04: no panel after decline; on screen: ${visible()}", device.wait(Until.hasObject(By.textContains("Нужен вход в CRM")), 20_000))
        SystemClock.sleep(5_000)
        assertTrue("B04: the decline panel was hidden by a late page event", device.hasObject(By.textContains("Нужен вход в CRM")))
        panelLogin()
        awaitDialog("B04 re-entry after decline")
        assertEquals("B04: no proceed happened yet, so login and password are asked", 2, dialogEdits().size)
        fill(staffA, "wrong-1")
        repeat(2) { attempt ->
            awaitDialog("B04 re-prompt ${attempt + 1}")
            fill(null, "wrong-${attempt + 2}")
        }
        assertTrue("B04: no EXHAUSTED panel; on screen: ${visible()}", device.wait(Until.hasObject(By.textContains("Не удалось подтвердить доступ")), 30_000))
        SystemClock.sleep(5_000)
        assertTrue("B04: the EXHAUSTED panel was hidden by a late page event", device.hasObject(By.textContains("Не удалось подтвердить доступ")))
        panelLogin()
        awaitDialog("B04 re-entry after EXHAUSTED")
        assertTrue("B04: the username is not pinned after wrong passwords", device.hasObject(By.textContains("Сотрудник: $staffA")))
        fill(null, passA)
        assertTrue(
            "B04: the panel hold was not released by a successful sign-in; on screen: ${visible()}",
            device.wait(Until.hasObject(By.textContains("Вход в мобильное приложение")), 60_000),
        )
        assertFalse("B04: an edge panel stayed over the CRM", device.hasObject(By.textContains("Нужен вход в CRM")))
        mark("B04 PASS")
    }

    /** «Войти» on the edge panel (a native button; the WebView is hidden while the panel shows). */
    private fun panelLogin() {
        val button = device.wait(Until.findObject(By.clazz("android.widget.Button").text("Войти").pkg(targetPackage)), 10_000)
        assertNotNull("no «Войти» on the edge panel; on screen: ${visible()}", button)
        button!!.click()
    }

    // ── B06: TLS failure ⇒ panel, no dialog ───────────────────────────────
    @Test
    fun b06_tlsFailureShowsThePanelAndNoDialog() {
        launch()
        assertTrue(
            "B06: no TLS panel; on screen: ${visible()}",
            device.wait(Until.hasObject(By.textContains("Защищённое соединение с CRM не подтверждено")), 60_000),
        )
        assertFalse("B06: a dialog appeared over a TLS failure", device.hasObject(By.textContains(dialogTarget)))
        mark("B06 PASS")
    }

    // ── B07: a configured system proxy is never used ─────────────────────
    @Test
    fun b07_systemProxyIsNeverUsed() {
        launch()
        awaitDialog("B07")
        fill(staffA, passA)
        assertTrue(
            "B07: the CRM was not reached directly; on screen: ${visible()}",
            device.wait(Until.hasObject(By.textContains("Вход в мобильное приложение")), 60_000),
        )
        assertTrue("B07: proxy diagnostic missing; ${tail()}", lines().any { it.contains("edge-auth proxy-configured collision=false") })
        mark("B07 PASS")
    }

    // ── B09/B13/B14/B15: bootstrap barrier after process death ───────────
    /**
     * Args: user, pass, expect = resume | reset, wrongFirst = true (B15).
     * Runs in the relaunched process with residual CRM context.
     */
    @Test
    fun b09_bootstrapBarrier() {
        val user = args.getString("user") ?: staffA
        val pass = args.getString("pass") ?: passA
        val expect = args.getString("expect") ?: "resume"
        val wrongFirst = args.getString("wrongFirst") == "true"
        val id = args.getString("scenario") ?: "B09"
        assertTrue("$id: no residual context to hold", PushRegistrar.sessionCookiePair(CookieManager.getInstance().getCookie(CrmOrigin.ORIGIN)) != null)
        awaitDialog(id)
        assertEquals("$id: the barrier holds before any CRM page", ContinuityGuard.State.PENDING, ContinuityGuard.state)
        if (wrongFirst) {
            fill(user, "wrong-bootstrap")
            awaitDialog("$id re-prompt")
            assertTrue("$id: username not pinned after a wrong password", device.hasObject(By.textContains("Сотрудник: $user")))
            assertEquals("$id: another login can be typed in pinned mode", 1, dialogEdits().size)
            mark("$id pinned after wrong password; switching operator")
            device.findObject(By.res("android", "button3")).click()
            expectProcessEnd(id)
        }
        fill(user, pass)
        if (expect == "resume") {
            assertTrue(
                "$id: the session did not resume; on screen: ${visible()}; ${tail()}",
                device.wait(Until.hasObject(By.textContains("Тест · MAX")), 60_000),
            )
            assertEquals(ContinuityGuard.State.CONFIRMED, ContinuityGuard.state)
            assertTrue(lines().any { it.contains("continuity confirmed") })
            mark("$id resumed ${lines().lastOrNull { it.contains("continuity probe status=") }}")
        } else {
            expectProcessEnd(id)
        }
    }

    // ── B10: the accepted credential is refused mid-session ──────────────
    @Test
    fun b10_rotatedPasswordResets() {
        mark("B10 reloading after rotation")
        javascript("location.reload();")
        expectProcessEnd("B10")
    }

    // ── B11: operator switch A → B ────────────────────────────────────────
    @Test
    fun b11_operatorSwitch() {
        app.startActivity(Intent(app, OperatorResetActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))
        expectProcessEnd("B11")
    }

    /** After a reset: an empty dialog for whoever holds the device; no old session. */
    @Test
    fun b00_verifyFreshAfterReset() {
        val id = args.getString("scenario").orEmpty()
        val reason = args.getString("expectReason")
        awaitDialog(id)
        assertEquals("$id: the fresh dialog is not empty", 2, dialogEdits().size)
        assertFalse("$id: pinned label after a reset", device.hasObject(By.textContains("Сотрудник:")))
        assertNull("$id: old session cookie survived", PushRegistrar.sessionCookiePair(CookieManager.getInstance().getCookie(CrmOrigin.ORIGIN)))
        assertNull("$id: reset still pending", PushTokenState.resetPending(app))
        assertNull("$id: continuity record survived", PushTokenState.continuityRecord(app).body)
        if (reason != null) {
            // The reset was started by the previous process; read every pid's lines.
            val all = EdgeDeviceSupport.diagnostics().map { it.second }
            assertTrue("$id: no reset $reason; ${tail()}", all.any { it.contains("edge-reset start reason=$reason") })
        }
        if (args.getString("thenStaffB") == "true") {
            fill(staffB, passB)
            assertTrue(
                "$id: staff B did not land on the CRM login (old session?); on screen: ${visible()}",
                device.wait(Until.hasObject(By.textContains("Вход в мобильное приложение")), 60_000),
            )
            assertFalse("$id: the messenger opened without a CRM login", device.hasObject(By.textContains("Тест · MAX")))
        }
        mark("$id VERIFIED")
    }

    // ── plumbing ─────────────────────────────────────────────────────────

    private fun launch() {
        // The workflow already started the shell; a second launch would create a
        // second activity with its own challenge. Launch only if it is not in front.
        if (device.wait(Until.hasObject(By.pkg(targetPackage).depth(0)), 5_000)) return
        device.pressHome()
        val intent = app.packageManager.getLaunchIntentForPackage(targetPackage)!!
            .addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
        InstrumentationRegistry.getInstrumentation().context.startActivity(intent)
    }

    private fun awaitDialog(id: String): UiObject2 {
        val found = device.wait(Until.findObject(By.textContains(dialogTarget)), 90_000)
        assertNotNull("$id: no staff dialog; on screen: ${visible()}; ${tail()}", found)
        return found!!
    }

    private fun dialogEdits(): List<UiObject2> = device.findObjects(By.clazz("android.widget.EditText").pkg(targetPackage))

    private fun fill(user: String?, password: String) {
        val edits = dialogEdits()
        if (user != null && edits.size >= 2) {
            edits[0].text = user
            edits[1].text = password
        } else {
            edits.last().text = password
        }
        device.findObject(By.res("android", "button1")).click()
    }

    private fun crmSignIn(id: String) {
        assertTrue(
            "$id: no CRM login after the staff gate; on screen: ${visible()}; ${tail()}",
            device.wait(Until.hasObject(By.textContains("Вход в мобильное приложение")), 90_000),
        )
        device.wait(Until.hasObject(By.textContains("Сотрудник")), 20_000)
        val candidates = (device.findObjects(By.textContains("Выберите")) + device.findObjects(By.textContains("Сотрудник"))).distinct()
        val picker = candidates.firstOrNull { it.isClickable } ?: candidates.firstOrNull { it.className != "android.widget.TextView" }
        assertNotNull("$id: no operator select", picker)
        picker!!.click()
        device.wait(Until.findObject(By.textContains("Мария")), 20_000)!!.click()
        val fields = device.wait(Until.findObjects(By.clazz("android.widget.EditText")), 20_000)
        assertTrue("$id: CRM sign-in fields not found", fields != null && fields.size >= 2)
        fields!![0].text = "acceptance"
        fields[1].text = "yoko acceptance passphrase"
        device.wait(Until.findObject(By.text("Войти")), 20_000)!!.click()
        assertTrue("$id: messenger did not open; on screen: ${visible()}", device.wait(Until.hasObject(By.textContains("Тест · MAX")), 60_000))
    }

    private fun awaitRecord(id: String) {
        val deadline = SystemClock.uptimeMillis() + 20_000
        while (SystemClock.uptimeMillis() < deadline) {
            if (PushTokenState.continuityRecord(app).body != null) return
            SystemClock.sleep(250)
        }
        fail("$id: no continuity record; ${tail()}")
    }

    private fun expectProcessEnd(id: String): Nothing {
        mark("$id reset-expected")
        SystemClock.sleep(30_000)
        throw AssertionError("$id: the process did not end; ${tail()}")
    }

    private fun javascript(source: String) {
        var webView: WebView? = null
        InstrumentationRegistry.getInstrumentation().runOnMainSync {
            webView = ActivityLifecycleMonitorRegistry.getInstance().getActivitiesInStage(Stage.RESUMED).firstOrNull()?.findViewById(R.id.web_view)
        }
        assertNotNull("no resumed shell WebView", webView)
        InstrumentationRegistry.getInstrumentation().runOnMainSync { webView!!.evaluateJavascript(source, null) }
    }

    private fun lines(): List<String> = EdgeDeviceSupport.diagnostics().filter { it.first == android.os.Process.myPid() }.map { it.second }
    private fun tail(): String = lines().filterNot { it.startsWith("console") }.takeLast(10).joinToString(" | ") { it.take(100) }
    private fun mark(line: String) = EdgeDeviceSupport.mark(line)

    private fun shell(command: String) {
        val fd = InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(command)
        ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes() }
    }

    private fun visible(limit: Int = 240): String = runCatching {
        device.findObjects(By.textStartsWith("")).mapNotNull { it.text?.trim() }.filter { it.isNotEmpty() }.joinToString(" | ").take(limit)
    }.getOrDefault("<unreadable>")
}
