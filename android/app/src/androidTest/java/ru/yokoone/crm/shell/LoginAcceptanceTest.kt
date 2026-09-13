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
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TestWatcher
import org.junit.runner.Description
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
 * These tests describe the behaviour the stage promises, never the behaviour
 * that happens to exist. That distinction mattered when they were written: the
 * successful-login test asserted that the messenger opens while the device was
 * still showing a client-side exception, and it stayed red on purpose, because
 * a test that passes while the product is broken is worse than no test.
 *
 * That defect is fixed. The assertions are unchanged — nothing here was
 * loosened to make them pass — so the successful-login test is now expected to
 * go green, and a red result means a real regression.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class LoginAcceptanceTest {

    private lateinit var device: UiDevice

    private val targetPackage = "ru.yokoone.crm.shell.acceptance"

    /**
     * A failing assertion here says only that some text never appeared. It
     * cannot say whether the text was absent from the screen or merely absent
     * from the accessibility tree, and those need very different fixes: one is
     * a product defect, the other is a WebView that did not publish a
     * client-side update. So every failure leaves both a screenshot and the
     * hierarchy it was judged against, captured at the moment it failed rather
     * than after the run has moved on.
     */
    @get:Rule
    val evidenceOnFailure: TestWatcher = object : TestWatcher() {
        override fun failed(e: Throwable, description: Description) {
            val name = "FAIL-${description.methodName}"
            runCatching { screenshot(name) }
            runCatching {
                val out = evidenceDir() ?: return@runCatching
                device.dumpWindowHierarchy(File(out, "$name.xml"))
            }
        }
    }

    /** Credentials for the disposable stand. Never a production secret. */
    private val user = "acceptance"
    private val correctPassword = "yoko acceptance passphrase"
    private val wrongPassword = "definitely-not-the-password"

    @Before
    fun launchFreshApp() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())

        // Android 13 asks for POST_NOTIFICATIONS the first time the shell runs,
        // and that dialog sits in front of everything: a hierarchy dump taken
        // while it is up shows thirteen nodes reading "Allow YOKO CRM to send
        // you notifications?" and no WebView at all. That is why every test
        // failed with "app did not reach the sign-in screen" while the shell's
        // own log showed it loading the login page perfectly well.
        //
        // Granting it here is not a weakening of the acceptance. What is being
        // accepted is the sign-in and messenger flow; an operator grants this
        // once on a real handset and never sees it again. Leaving it to chance
        // would mean the suite measures the timing of an OS dialog rather than
        // the product.
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(
            "pm grant $targetPackage android.permission.POST_NOTIFICATIONS",
        ).close()

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

    @Test
    fun test01_wrongPasswordKeepsTheFormAndExplainsWhy() {
        signIn(wrongPassword)

        assertTrue(
            "no readable rejection message after a wrong password; on screen: ${visibleText()}",
            device.wait(Until.hasObject(By.textContains("Неверный логин или пароль")), ACTION_TIMEOUT),
        )
        // The operator has to be able to try again without restarting anything.
        assertTrue(
            "the form was not usable again after the rejection; on screen: ${visibleText()}",
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
                "on screen: ${visibleText()}",
            opened,
        )
    }

    @Test
    fun test03_directCorrectLoginOpensTheMessenger() {
        signIn(correctPassword)

        val opened = device.wait(Until.hasObject(By.textContains("Тест · Telegram")), MESSENGER_TIMEOUT)
        screenshot("03-direct-login")
        assertTrue("the messenger did not open on a direct correct login; on screen: ${visibleText()}", opened)
    }

    @Test
    fun test04_allThreeSeededConversationsAreListed() {
        signIn(correctPassword)
        assertTrue(
            "the conversation list never appeared; on screen: ${visibleText()}",
            device.wait(Until.hasObject(By.textContains("Тест · Telegram")), MESSENGER_TIMEOUT),
        )

        for (name in listOf("Тест · Telegram", "Тест · WhatsApp", "Тест · MAX")) {
            assertTrue(
                "seeded conversation missing from the list: $name; on screen: ${visibleText()}",
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
    /**
     * Where evidence goes.
     *
     * The instrumentation runs in its own process, and under scoped storage it
     * cannot write into the app-under-test's external directory — which is why
     * the first attempt at this produced no files at all. Its own external
     * directory it can write to, and adb can pull.
     */
    private fun evidenceDir(): File? {
        val dir = InstrumentationRegistry.getInstrumentation().context
            .getExternalFilesDir(null) ?: return null
        return File(dir, "screenshots").apply { mkdirs() }
    }

    /**
     * What the accessibility tree holds right now, for a failure message.
     *
     * Files written by the test have not survived the trip out of the emulator,
     * and the JUnit failure message is the one channel from inside a run that
     * has proved reliable, so the evidence travels in the message itself. It
     * also answers the actual question: an assertion that cannot find its text
     * cannot say whether the text is off-screen or merely unpublished, and this
     * shows what WAS published at that moment.
     */
    private fun visibleText(limit: Int = 220): String {
        val texts = runCatching {
            device.findObjects(By.textStartsWith(""))
                .mapNotNull { it.text }
                .filter { it.isNotBlank() }
                .distinct()
        }.getOrDefault(emptyList())
        val joined = texts.joinToString(" / ")
        return if (joined.isEmpty()) "(tree carries no text)"
        else joined.take(limit).replace('\n', ' ')
    }

    private fun screenshot(name: String) {
        val shots = evidenceDir() ?: return
        device.takeScreenshot(File(shots, "$name.png"))
    }

    private companion object {
        const val LAUNCH_TIMEOUT = 60_000L
        const val ACTION_TIMEOUT = 20_000L
        const val MESSENGER_TIMEOUT = 45_000L
    }
}
