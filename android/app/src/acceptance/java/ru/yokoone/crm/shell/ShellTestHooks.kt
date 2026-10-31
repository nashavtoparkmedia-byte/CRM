package ru.yokoone.crm.shell

import android.content.Context
import ru.yokoone.crm.shell.push.AcceptanceTokenProvider
import ru.yokoone.crm.shell.push.TokenActor

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

    /**
     * The token actor's provider in acceptance: the token the workflow seeded,
     * standing in for Firebase, which deterministic acceptance may not use.
     * The actor still reads it, serially, and commits it under the reset epoch
     * and the retired set exactly as it would a Firebase token (R5.1 §5.7.2).
     */
    fun tokenProviderOverride(context: Context): TokenActor.Provider? = AcceptanceTokenProvider.forContext(context)
}
