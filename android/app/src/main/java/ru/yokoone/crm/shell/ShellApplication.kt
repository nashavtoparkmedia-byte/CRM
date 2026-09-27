package ru.yokoone.crm.shell

import android.app.Application
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
        ChatNotifications.ensureChannel(this)
        // Every process start, including the ones the system makes in the
        // background to deliver a message. It is a no-op unless an Owner has
        // supplied Firebase configuration, and never runs more than once here.
        FcmTokenProvider.acquireCurrentToken(this)
    }
}
