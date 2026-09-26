package ru.yokoone.crm.shell

import android.app.Activity
import android.app.Application
import android.os.Bundle
import android.util.Log
import androidx.work.Configuration
import ru.yokoone.crm.shell.push.FcmTokenProvider

/**
 * Process start.
 *
 * WorkManager is configured here and initialized on demand rather than by
 * androidx startup, because most processes this app runs in never schedule
 * anything: a process the system creates to deliver a push would otherwise
 * open WorkManager's database and start its threads before finding out there
 * is nothing to do.
 */
class ShellApplication : Application(), Configuration.Provider {

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setMinimumLoggingLevel(Log.INFO)
            .build()

    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(LiveActivities)
        ChatNotifications.ensureChannel(this)
        // Every process start, including the ones the system makes in the
        // background to deliver a message. It is a no-op unless an Owner has
        // supplied Firebase configuration, and never runs more than once here.
        FcmTokenProvider.acquireCurrentToken(this)
    }
}

/**
 * Whether this process is holding an Activity at all.
 *
 * A notification has to be aimed differently depending on the answer, and the
 * answer is not guessable from outside: the system can destroy the shell's
 * Activity and keep, or later recreate, the process - which is exactly what
 * happens when a push arrives after the Activity is gone.
 *
 * Counts created-but-not-destroyed Activities. Not a foreground check: an
 * Activity that is merely stopped still exists, still holds the WebView's
 * history, and still receives a new Intent.
 */
object LiveActivities : Application.ActivityLifecycleCallbacks {

    @Volatile
    private var count: Int = 0

    /** True while at least one Activity of this process exists. */
    val any: Boolean get() = count > 0

    /** Separated from the callback so the arithmetic is reachable from a test. */
    internal fun entered() {
        count++
    }

    internal fun left() {
        if (count > 0) count--
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = entered()

    override fun onActivityDestroyed(activity: Activity) = left()

    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityResumed(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
}
