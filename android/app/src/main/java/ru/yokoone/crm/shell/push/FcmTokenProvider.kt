package ru.yokoone.crm.shell.push

import android.content.Context
import android.util.Log
import androidx.annotation.VisibleForTesting
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import java.util.concurrent.Executors

/**
 * The only place in the shell that knows Firebase exists, besides the service.
 *
 * Two paths tell the shell that the provider may hold a token, and the shell
 * needs both. onNewToken fires when the provider rotates one, which may be
 * never; it says nothing about the token the installation already has. So the
 * current token is also read once per process start.
 *
 * Revision 5.1 of the edge design changes what both paths do with a token: they
 * no longer carry it anywhere. Each only signals the token actor, which reads
 * the provider itself and commits under the reset epoch and the retired set
 * (§5.7.2). The [Firebase] adapter below is the actor's provider and is never
 * called from anywhere else.
 *
 * When Firebase is not configured — which is the state of every build made from
 * this repository, because no google-services.json is committed — there is no
 * default app, nothing is fetched, nothing throws, and no registration is ever
 * attempted. The deterministic build stays closed rather than half-open.
 */
object FcmTokenProvider {

    private const val TAG = "YokoPush"

    /** Whether a default Firebase app exists, i.e. whether config was supplied. */
    fun isConfigured(context: Context): Boolean =
        runCatching { FirebaseApp.getApps(context).isNotEmpty() }.getOrDefault(false)

    /**
     * Process start: let the actor read the provider (ROTATE if a rotation is
     * owed, otherwise one REFRESH). Safe on every start; later calls in one
     * process do nothing.
     */
    fun acquireCurrentToken(context: Context) {
        if (!isConfigured(context.applicationContext)) {
            Log.i(TAG, "no firebase configuration in this build; push uses only a test provider if one exists")
        }
        TokenActor.onMainProcessStart(context.applicationContext)
    }

    @VisibleForTesting
    fun forgetAcquisition() {
        TokenActor.resetForTest()
    }

    /**
     * The actor's provider. Task listeners run on a dedicated thread so a
     * caller blocked on the main thread can never hold up a completion. Token
     * values are never logged: a token is a bearer credential for this
     * device's notifications.
     */
    object Firebase : TokenActor.Provider {

        private val listeners = Executors.newSingleThreadExecutor { runnable ->
            Thread(runnable, "yoko-fcm-listener").apply { isDaemon = true }
        }

        override fun getToken(listener: (String?) -> Unit) {
            FirebaseMessaging.getInstance().token.addOnCompleteListener(listeners) { task ->
                if (!task.isSuccessful) Log.w(TAG, "current token unavailable: ${task.exception?.javaClass?.simpleName}")
                listener(if (task.isSuccessful) task.result else null)
            }
        }

        override fun deleteToken(listener: (Boolean) -> Unit) {
            FirebaseMessaging.getInstance().deleteToken().addOnCompleteListener(listeners) { task ->
                listener(task.isSuccessful)
            }
        }
    }
}
