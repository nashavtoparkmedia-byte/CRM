package ru.yokoone.crm.shell

import android.app.Application
import ru.yokoone.crm.shell.push.FcmTokenProvider

class ShellApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        ChatNotifications.ensureChannel(this)
        // Every process start, including the ones the system makes in the
        // background to deliver a message. It is a no-op unless an Owner has
        // supplied Firebase configuration, and never runs more than once here.
        FcmTokenProvider.acquireCurrentToken(this)
    }
}
