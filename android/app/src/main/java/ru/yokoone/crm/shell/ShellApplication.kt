package ru.yokoone.crm.shell

import android.app.Application

class ShellApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        ChatNotifications.ensureChannel(this)
    }
}
