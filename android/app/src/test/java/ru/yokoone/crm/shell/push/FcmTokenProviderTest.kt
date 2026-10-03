package ru.yokoone.crm.shell.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * What a build with no Firebase configuration does, which is nothing.
 *
 * This is the state of every artifact produced from this repository, including
 * the one emulator acceptance installs, because no google-services.json is
 * committed and none may be. The assertion is that the absence is a normal,
 * closed state rather than a crash or a half-configured one: no default app, no
 * token fetched, no registration attempted, and no exception escaping into
 * Application.onCreate, which runs this on every process start.
 */
@RunWith(RobolectricTestRunner::class)
class FcmTokenProviderTest {

    private val context: Context get() = ApplicationProvider.getApplicationContext()

    private val scheduled = mutableListOf<Pair<Long, String>>()
    private val realScheduler = PushRegistration.scheduler

    @Before
    fun isolate() {
        context.getSharedPreferences(PushTokenState.PREFS_NAME, Context.MODE_PRIVATE)
            .edit().clear().commit()
        scheduled.clear()
        FcmTokenProvider.forgetAcquisition()
        PushRegistration.scheduler = PushRegistration.Scheduler { _, generation, token ->
            scheduled += generation to token
        }
    }

    @After
    fun restore() {
        PushRegistration.scheduler = realScheduler
        FcmTokenProvider.forgetAcquisition()
    }

    @Test
    fun `a build carrying no configuration has no firebase app`() {
        assertFalse(FcmTokenProvider.isConfigured(context))
    }

    @Test
    fun `acquiring a token without configuration neither throws nor registers`() {
        FcmTokenProvider.acquireCurrentToken(context)

        assertNull("no token may be remembered", PushTokenState.snapshot(context).newestToken)
        assertTrue("and nothing may be enqueued", scheduled.isEmpty())
    }

    @Test
    fun `acquisition happens at most once per process`() {
        // Application.onCreate calls this on every process start; a second call
        // inside one process must not become a second fetch.
        FcmTokenProvider.acquireCurrentToken(context)
        FcmTokenProvider.acquireCurrentToken(context)
        FcmTokenProvider.acquireCurrentToken(context)

        assertTrue(scheduled.isEmpty())
    }
}
