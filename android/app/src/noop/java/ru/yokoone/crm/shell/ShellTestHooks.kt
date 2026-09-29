package ru.yokoone.crm.shell

import android.content.Context

/**
 * Shipped implementation of the shell's test seam: it does nothing.
 *
 * Compiled into debug and release (see the sourceSets wiring in
 * app/build.gradle.kts). Its acceptance counterpart in src/acceptance posts the
 * diagnostics notification; this one exists so that neither TestNotificationSeed
 * nor its receiver is reachable — or even present — outside acceptance.
 */
object ShellTestHooks {

    fun onNotificationsReady(context: Context) = Unit
}
