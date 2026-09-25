package ru.yokoone.crm.shell

import android.content.Intent
import android.os.ParcelFileDescriptor
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.uiautomator.By
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
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
 * Push acceptance on a real Android system, against a disposable CRM.
 *
 * What these prove and what they do not. The payload every scenario injects is
 * not invented here: the workflow drives a real inbound message into the CRM,
 * the real P1 outbox fans it out, the real FCM adapter sends it to a loopback
 * stand-in, and the EXACT data map that stand-in received is handed to this
 * suite as instrumentation arguments. Only the wire between Google and the
 * handset is stood in. Everything after the payload arrives is the product.
 *
 * Injection is a broadcast rather than a direct call so that the system
 * delivers it to the app's own process the way a message would, and so that
 * the process-dead case is reachable at all.
 *
 * Scenarios that assert "nothing happens" — a duplicate, a malformed payload, a
 * denied permission — live in the workflow instead, because the shell collapses
 * notifications for one conversation onto a single id: two deliveries and one
 * delivery look identical on screen, so the honest evidence is the handler's
 * own outcome in logcat, not a count of what the shade shows.
 */
@RunWith(AndroidJUnit4::class)
@FixMethodOrder(MethodSorters.NAME_ASCENDING)
class PushAcceptanceTest {

    private lateinit var device: UiDevice

    private val targetPackage = "ru.yokoone.crm.shell.acceptance"

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

    private val user = "acceptance"
    private val password = "yoko acceptance passphrase"

    /** The captured payload, handed in by the workflow with -e arguments. */
    private val arguments get() = InstrumentationRegistry.getArguments()
    private val chatId: String get() = required("chatId")
    private val messageId: String get() = required("messageId")
    private val channel: String get() = arguments.getString("channel").orEmpty()
    private val inboundText: String get() = required("inboundText")
    private val pushToken: String get() = required("pushToken")

    private fun required(name: String): String {
        val value = arguments.getString(name)
        assertNotNull("instrumentation argument -e $name is required", value)
        assertTrue("instrumentation argument -e $name is empty", value!!.isNotEmpty())
        return value
    }

    @Before
    fun prepare() {
        device = UiDevice.getInstance(InstrumentationRegistry.getInstrumentation())
        grantNotifications()
    }

    /**
     * Sign in, seed the token the workflow will look for in the CRM's database,
     * and leave the app signed in.
     *
     * The proof of registration is deliberately not made here. What matters is
     * that a row reached the CRM through the real endpoint, and this process
     * cannot see the server; the workflow asserts it against the database.
     */
    @Test
    fun test07_signInAndSeedThePushToken() {
        launchApp()
        signIn()
        assertMessengerOpen()

        broadcast(Intent(ACTION_SEED_TOKEN).putExtra("token", pushToken))

        // Wait for the registration to actually land rather than sleeping a
        // fixed interval and hoping. The shell reports the one request it makes
        // in its diagnostics, so this waits for that line instead of guessing
        // how long WorkManager, a cold database and an emulator need.
        val registered = waitUntil(REGISTRATION_TIMEOUT) {
            deviceLog().contains("push-registration status=200")
        }

        // Either way, leave the derived state in the log: the acceptance job
        // publishes these lines, and a run that fails here is otherwise a
        // silence that could mean the device never asked or the CRM never
        // answered.
        broadcast(Intent(ACTION_REPORT_STATE))
        SystemClock.sleep(SETTLE_MS)

        assertTrue(
            "the device did not register with the CRM; shell diagnostics: ${pushDiagnostics()}",
            registered,
        )
    }

    @Test
    fun test08_aPushInTheForegroundOpensTheExactConversation() {
        launchApp()
        signIn()
        assertMessengerOpen()

        injectCapturedPush()
        tapPushNotification()
        assertConversationOpen()
    }

    @Test
    fun test09_aPushWithTheAppInTheBackgroundOpensTheExactConversation() {
        launchApp()
        signIn()
        assertMessengerOpen()

        device.pressHome()
        assertTrue(
            "the shell did not go to the background",
            device.wait(Until.gone(By.pkg(targetPackage).depth(0)), ACTION_TIMEOUT),
        )

        injectCapturedPush()
        tapPushNotification()
        assertConversationOpen()
    }

    /** Leaves a signed-in, backgrounded app for the workflow to kill. */
    @Test
    fun test10_signInThenLeaveTheAppInTheBackground() {
        launchApp()
        signIn()
        assertMessengerOpen()
        device.pressHome()
        SystemClock.sleep(SETTLE_MS)
    }

    /**
     * Runs after the workflow has killed the process and broadcast the payload
     * into it, so the notification on screen was posted by a process that did
     * not exist a moment earlier. Nothing is cleared before this scenario: the
     * session it signs into is the one test10 established.
     */
    @Test
    fun test11_aPushAfterProcessDeathOpensTheExactConversation() {
        tapPushNotification()
        assertConversationOpen()
    }

    // ── steps ────────────────────────────────────────────────────────────

    private fun injectCapturedPush() {
        broadcast(
            Intent(ACTION_INJECT_PUSH)
                .putExtra("v", "1")
                .putExtra("kind", "chat_message")
                .putExtra("chatId", chatId)
                .putExtra("messageId", messageId)
                .putExtra("channel", channel),
        )
    }

    private fun broadcast(intent: Intent) {
        InstrumentationRegistry.getInstrumentation().context.sendBroadcast(
            intent.setPackage(targetPackage),
        )
    }

    private fun tapPushNotification() {
        device.openNotification()
        val posted = device.wait(Until.findObject(By.textContains(PUSH_TITLE)), NOTIFICATION_TIMEOUT)
        assertNotNull(
            "no push notification appeared; on screen: ${visibleText()}",
            posted,
        )
        posted!!.click()
    }

    private fun assertConversationOpen() {
        assertTrue(
            "the tap did not open the conversation carrying the pushed message; " +
                "expected «$inboundText»; on screen: ${visibleText()}; tree: ${treeShape(300)}",
            device.wait(Until.hasObject(By.textContains(inboundText)), MESSENGER_TIMEOUT),
        )
        assertTrue(
            "the conversation header is missing; on screen: ${visibleText()}",
            device.hasObject(By.desc(BACK_TO_LIST)) || device.hasObject(By.text(BACK_TO_LIST)),
        )
    }

    private fun assertMessengerOpen() {
        assertTrue(
            "the messenger did not open after sign-in; on screen: ${visibleText()}; tree: ${treeShape(300)}",
            device.wait(Until.hasObject(By.textContains(MAX_CHAT)), MESSENGER_TIMEOUT),
        )
    }

    /** Everything the shell has written to its diagnostics tag this run. */
    private fun deviceLog(): String = runCatching {
        val fd = InstrumentationRegistry.getInstrumentation().uiAutomation
            .executeShellCommand("logcat -d -s ${ShellDiagnostics.TAG}:E")
        ParcelFileDescriptor.AutoCloseInputStream(fd).use { it.readBytes().toString(Charsets.UTF_8) }
    }.getOrDefault("")

    /** The push lines only, newest last, for a failure message worth reading. */
    private fun pushDiagnostics(): String = deviceLog()
        .lineSequence()
        .filter { it.contains("push-") }
        .toList()
        .takeLast(6)
        .joinToString(" | ")
        .ifEmpty { "<the shell wrote no push diagnostics at all>" }

    private fun waitUntil(timeoutMs: Long, condition: () -> Boolean): Boolean {
        val deadline = SystemClock.uptimeMillis() + timeoutMs
        while (true) {
            if (condition()) return true
            if (SystemClock.uptimeMillis() >= deadline) return false
            SystemClock.sleep(POLL_MS)
        }
    }

    // ── plumbing, mirrored from LoginAcceptanceTest ──────────────────────

    private fun grantNotifications() {
        InstrumentationRegistry.getInstrumentation().uiAutomation.executeShellCommand(
            "pm grant $targetPackage android.permission.POST_NOTIFICATIONS",
        ).close()
    }

    private fun launchApp() {
        device.pressHome()
        val context = InstrumentationRegistry.getInstrumentation().context
        val intent = context.packageManager.getLaunchIntentForPackage(targetPackage)
            ?.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)
        assertNotNull("launch intent for $targetPackage", intent)
        context.startActivity(intent)

        assertTrue(
            "app did not reach the sign-in screen; on screen: ${visibleText()}; tree: ${treeShape(200)}",
            device.wait(Until.hasObject(By.textContains("Вход в мобильное приложение")), LAUNCH_TIMEOUT),
        )
    }

    /**
     * The same form, filled the same way as in LoginAcceptanceTest: the
     * operator control is a WebView `<select>` that Chromium publishes as a
     * plain View next to a label carrying the same word, so it is picked by
     * being clickable rather than by text order, and the submit button is
     * matched on exact text because the CRM chrome carries its own "Войти…".
     */
    private fun signIn() {
        device.wait(Until.hasObject(By.textContains("Сотрудник")), ACTION_TIMEOUT)
        val candidates = (
            device.findObjects(By.textContains("Выберите")) +
                device.findObjects(By.textContains("Сотрудник"))
            ).distinct()
        val picker = candidates.firstOrNull { it.isClickable }
            ?: candidates.firstOrNull { it.className != "android.widget.TextView" }
        assertNotNull("no clickable operator select; tree: ${treeShape(300)}", picker)
        picker!!.click()

        val option = device.wait(Until.findObject(By.textContains("Мария")), ACTION_TIMEOUT)
        assertNotNull("the operator list did not open; tree: ${treeShape(460)}", option)
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

    private fun evidenceDir(): File? {
        val dir = InstrumentationRegistry.getInstrumentation().context
            .getExternalFilesDir(null) ?: return null
        return File(dir, "screenshots").apply { mkdirs() }
    }

    private fun screenshot(name: String) {
        val out = evidenceDir() ?: return
        device.takeScreenshot(File(out, "$name.png"))
    }

    private fun visibleText(limit: Int = 260): String = runCatching {
        device.findObjects(By.textStartsWith(""))
            .mapNotNull { it.text?.trim() }
            .filter { it.isNotEmpty() }
            .joinToString(" | ")
            .take(limit)
    }.getOrDefault("<unreadable>")

    private fun treeShape(limit: Int = 400): String = runCatching {
        device.findObjects(By.textStartsWith(""))
            .joinToString(" | ") { "${it.className?.substringAfterLast('.')}='${it.text?.take(24)}'" }
            .take(limit)
    }.getOrDefault("<unreadable>")

    private companion object {
        const val LAUNCH_TIMEOUT = 60_000L
        const val ACTION_TIMEOUT = 20_000L
        const val MESSENGER_TIMEOUT = 45_000L
        const val NOTIFICATION_TIMEOUT = 20_000L
        const val SETTLE_MS = 2_000L
        const val POLL_MS = 1_000L
        const val REGISTRATION_TIMEOUT = 90_000L

        const val MAX_CHAT = "Тест · MAX"
        const val BACK_TO_LIST = "Назад к списку"

        /** Exactly the copy in res/values/strings.xml. */
        const val PUSH_TITLE = "Новое сообщение"

        const val ACTION_INJECT_PUSH = "ru.yokoone.crm.shell.acceptance.action.INJECT_PUSH"
        const val ACTION_SEED_TOKEN = "ru.yokoone.crm.shell.acceptance.action.SEED_PUSH_TOKEN"
        const val ACTION_REPORT_STATE = "ru.yokoone.crm.shell.acceptance.action.REPORT_PUSH_STATE"
    }
}
