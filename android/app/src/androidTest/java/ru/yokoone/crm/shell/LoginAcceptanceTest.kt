package ru.yokoone.crm.shell

import android.content.Intent
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.Until
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.FixMethodOrder
import org.junit.Test
import org.junit.runner.RunWith
import org.junit.runners.MethodSorters
import java.io.File

/**
 * End-to-end acceptance for the Android shell, driven against a disposable CRM.
 *
 * UI Automator rather than Espresso, because everything the operator sees is
 * inside a WebView. Espresso sees an opaque view; UI Automator reads the
 * accessibility tree the WebView publishes, which is the same thing a screen
 * reader would see, so the assertions are about what a person can actually read
 * on the screen.
 *
 * These tests describe the behaviour the stage promises. They are NOT written to
 * accommodate the defect currently under investigation: the successful-login
 * test asserts that the messenger opens, and it is expected to stay red until
 * that defect is fixed. A test that passes while the product is broken is worse
 * than no test.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class LoginAcceptanceTest {

    private lateinit var device: UiDevice

    private val targetPackage = "ru.yokoone.crm.shell.acceptance"

    /** Credentials for the disposable stand. Never a production secret. */
    private val user = "acceptance"
    private val correctPassword = "yoko acceptance passphrase"
    private val wrongPassword = "definitely-not-the-password"

    @Before
    fun launchFreshApp() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        device.pressHome()

        val context = InstrumentationRegistry.getInstrumentation().context
        val intent = context.packageManager.getLaunchIntentForPackage(targetPackage)
            ?.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
        assertNotNull("launch intent for $targetPackage", intent)
        context.startActivity(intent)

        assertTrue(
            "app did not reach the sign-in screen",
            device.wait(Until.hasObject(By.textContains("Вход в мобильное приложение")), LAUNCH_TIMEOUT),
        )
    }

    @Test
    fun test01_wrongPasswordKeepsTheFormAndExplainsWhy() {
        signIn(wrongPassword)

        assertTrue(
            "no readable rejection message after a wrong password",
            device.wait(Until.hasObject(By.textContains("Неверный логин или пароль")), ACTION_TIMEOUT),
        )
        // The operator has to be able to try again without restarting anything.
        assertTrue(
            "the form was not usable again after the rejection",
            device.findObjects(By.clazz("android.widget.EditText")).size >= 2,
        )
        screenshot("01-wrong-password")
    }

    @Test
    fun test02_correctPasswordAfterRejectionOpensTheMessenger() {
        signIn(wrongPassword)
        device.wait(Until.hasObject(By.textContains("Неверный логин или пароль")), ACTION_TIMEOUT)

        signIn(correctPassword)

        val opened = device.wait(Until.hasObject(By.textContains("Тест · Telegram")), MESSENGER_TIMEOUT)
        screenshot("02-after-correct-password")
        assertTrue(
            "the messenger did not open after a correct password following a rejection; " +
                "if an application error is on screen this is the defect under investigation",
            opened,
        )
    }

    @Test
    fun test03_directCorrectLoginOpensTheMessenger() {
        signIn(correctPassword)

        val opened = device.wait(Until.hasObject(By.textContains("Тест · Telegram")), MESSENGER_TIMEOUT)
        screenshot("03-direct-login")
        assertTrue("the messenger did not open on a direct correct login", opened)
    }

    @Test
    fun test04_allThreeSeededConversationsAreListed() {
        signIn(correctPassword)
        assertTrue(
            "the conversation list never appeared",
            device.wait(Until.hasObject(By.textContains("Тест · Telegram")), MESSENGER_TIMEOUT),
        )

        for (name in listOf("Тест · Telegram", "Тест · WhatsApp", "Тест · MAX")) {
            assertTrue(
                "seeded conversation missing from the list: $name",
                device.wait(Until.hasObject(By.textContains(name)), ACTION_TIMEOUT),
            )
        }
        screenshot("04-conversation-list")
    }

    // ── helpers ──────────────────────────────────────────────────────────

    /**
     * Fill and submit the sign-in form.
     *
     * The operator picker is a native `<select>`, which Chromium surfaces as a
     * dialog rather than an inline list, so it is opened and chosen explicitly
     * instead of being typed into.
     */
    private fun signIn(password: String) {
        val picker = device.wait(Until.findObject(By.textContains("Выберите сотрудника")), ACTION_TIMEOUT)
        if (picker != null) {
            picker.click()
            val option = device.wait(Until.findObject(By.textContains("Мария")), ACTION_TIMEOUT)
            assertNotNull("operator list did not open", option)
            option.click()
        }

        val fields = device.wait(Until.findObjects(By.clazz("android.widget.EditText")), ACTION_TIMEOUT)
        assertNotNull("sign-in fields not found", fields)
        assertTrue("expected a login and a password field, found ${fields.size}", fields.size >= 2)

        fields[0].text = user
        fields[1].text = password

        val submit = device.wait(Until.findObject(By.textContains("Войти")), ACTION_TIMEOUT)
        assertNotNull("submit button not found", submit)
        submit.click()
    }

    /**
     * Screenshots go to the app's external files directory, which the CI job
     * pulls afterwards. A failing assertion is much cheaper to act on with a
     * picture of the screen attached.
     */
    private fun screenshot(name: String) {
        val dir = InstrumentationRegistry.getInstrumentation().targetContext
            .getExternalFilesDir(null) ?: return
        val shots = File(dir, "screenshots").apply { mkdirs() }
        device.takeScreenshot(File(shots, "$name.png"))
    }

    private companion object {
        const val LAUNCH_TIMEOUT = 60_000L
        const val ACTION_TIMEOUT = 20_000L
        const val MESSENGER_TIMEOUT = 45_000L
    }
}
