package ru.yokoone.crm.shell.push

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import ru.yokoone.crm.shell.ShellDiagnostics

/**
 * The acceptance entry into the push path, and the reason it is a receiver.
 *
 * Deterministic acceptance cannot use Firebase: no project, no configuration
 * and no external service may be involved. What it can do is take the EXACT
 * data map the CRM's real FCM adapter emitted — captured from the loopback
 * stand-in the workflow runs — and hand it to the same handler a real message
 * would reach. Nothing about the product path is stood in; only the transport
 * that carried the bytes to the device is.
 *
 * A broadcast rather than a direct call, for two reasons. The system delivers
 * it to the app's own process exactly as it would deliver a message, so the
 * test is not quietly running product code inside the instrumentation's
 * context. And it is the only mechanism that can wake a process the system has
 * killed, which is the lifecycle case that matters most and the one an
 * in-process call cannot reach by construction.
 *
 * Exported, because `adb shell am broadcast` has to reach it after the process
 * is gone. That is a real widening and it is confined by the build: this class
 * exists only in src/acceptance, its declaration only in the acceptance
 * manifest, and the release artifact is asserted to contain neither the class
 * nor the action. The acceptance variant is a separate application id that is
 * never released.
 */
class AcceptancePushInjection : BroadcastReceiver() {

    override fun onReceive(context: Context, intent: Intent) {
        val application = context.applicationContext
        when (intent.action) {
            ACTION_INJECT_PUSH -> {
                val data = LinkedHashMap<String, String>()
                for (key in PAYLOAD_KEYS) intent.getStringExtra(key)?.let { data[key] = it }
                val outcome = RemotePushHandler.handle(application, data)
                // The workflow reads this line out of logcat. It carries the
                // outcome and the keys that were present, never a token.
                Log.i(TAG, "$OUTCOME_PREFIX$outcome keys=${data.keys}")
            }

            ACTION_REPORT_STATE -> {
                // Deliberately shaped like the shell's other network lines: the
                // acceptance job lifts exactly those out of the device log and
                // publishes them, and a job log needs admin rights to read.
                val state = PushTokenState.snapshot(application)
                ShellDiagnostics.write(
                    "YOKO_NET done POST push-state" +
                        " token=${state.newestToken != null}" +
                        " generation=${state.sessionGeneration}" +
                        " registered=${state.isRegistered}" +
                        " needs=${state.needsRegistration}" +
                        " blocked=${state.blockedReason ?: "none"}",
                )
                Log.i(TAG, "$STATE_PREFIX registered=${state.isRegistered} blocked=${state.blockedReason ?: "none"}")
            }

            ACTION_SEED_TOKEN -> {
                val token = intent.getStringExtra(EXTRA_TOKEN).orEmpty()
                if (token.isEmpty()) {
                    Log.w(TAG, "${SEED_PREFIX}refused: no token")
                    return
                }
                // The same entry point FirebaseMessagingService.onNewToken
                // uses. From here on the registration is entirely real: real
                // state machine, real WorkManager, real request, real CRM.
                PushRegistration.onNewToken(application, token)
                Log.i(TAG, "${SEED_PREFIX}accepted length=${token.length}")
            }
        }
    }

    companion object {
        const val TAG = "YokoPushAcceptance"

        const val ACTION_INJECT_PUSH = "ru.yokoone.crm.shell.acceptance.action.INJECT_PUSH"
        const val ACTION_SEED_TOKEN = "ru.yokoone.crm.shell.acceptance.action.SEED_PUSH_TOKEN"
        const val ACTION_REPORT_STATE = "ru.yokoone.crm.shell.acceptance.action.REPORT_PUSH_STATE"

        const val EXTRA_TOKEN = "token"

        const val OUTCOME_PREFIX = "INJECTED_PUSH_OUTCOME="
        const val SEED_PREFIX = "SEEDED_PUSH_TOKEN="
        const val STATE_PREFIX = "PUSH_STATE"

        /** Exactly the five keys P1 sends; nothing else is read from the intent. */
        val PAYLOAD_KEYS = listOf("v", "kind", "chatId", "messageId", "channel")
    }
}
