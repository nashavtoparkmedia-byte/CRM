package ru.yokoone.crm.shell

import android.content.Context

/**
 * Acceptance implementation of the shell's only test seam.
 *
 * The seam exists so that MainActivity can name a test aid without the aid
 * itself existing in a shipped build. There are exactly two implementations —
 * this one, compiled only into the acceptance variant, and the no-op in
 * src/noop that debug and release compile instead. Nothing selects between them
 * at runtime: the release artifact contains no branch, no flag, and no class.
 */
object ShellTestHooks {

    /**
     * Called once notifications are known to be permitted. In acceptance this
     * posts the ongoing diagnostics notification whose action button seeds a
     * local test notification.
     */
    fun onNotificationsReady(context: Context) {
        TestNotificationSeed.ensureDiagnosticsNotification(context)
    }
}
