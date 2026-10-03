package ru.yokoone.crm.shell.push

import android.content.Context
import android.util.Log
import androidx.annotation.VisibleForTesting
import com.google.firebase.FirebaseApp
import com.google.firebase.messaging.FirebaseMessaging
import java.util.concurrent.atomic.AtomicBoolean

/**
 * The only place in the shell that knows Firebase exists, besides the service.
 *
 * Two paths deliver a token and the shell needs both. onNewToken fires when the
 * provider rotates one, which may be never; it says nothing about the token the
 * installation already has. A device that installed the app, was granted a
 * token, and then had its registration revoked server-side would wait for ever
 * on a rotation that is not coming. So the current token is also fetched
 * directly, once per process.
 *
 * Once per process is the whole scheduling policy. It covers a fresh install,
 * an app-data clear, and every process the system recreates in the background,
 * and it cannot become a poll: there is no timer, no retry and no second fetch.
 * A fetch that fails is left to the next process start, and rotation is still
 * covered by the callback.
 *
 * When Firebase is not configured — which is the state of every build made from
 * this repository, because no google-services.json is committed — there is no
 * default app, nothing is fetched, nothing throws, and no registration is ever
 * attempted. The deterministic build stays closed rather than half-open.
 *
 * PushRegistration is deliberately on the other side of this boundary: it takes
 * a String and imports nothing from the provider, so the state machine stays
 * provable on the JVM.
 */
object FcmTokenProvider {

    private const val TAG = "YokoPush"

    private val acquired = AtomicBoolean(false)

    /** Whether a default Firebase app exists, i.e. whether config was supplied. */
    fun isConfigured(context: Context): Boolean =
        runCatching { FirebaseApp.getApps(context).isNotEmpty() }.getOrDefault(false)

    /**
     * Ask the provider for the token this installation already holds.
     *
     * Safe to call from Application.onCreate on every start; the second and
     * later calls in one process do nothing.
     */
    fun acquireCurrentToken(context: Context) {
        val application = context.applicationContext
        if (!acquired.compareAndSet(false, true)) return
        if (!isConfigured(application)) {
            Log.i(TAG, "no firebase configuration in this build; push stays inactive")
            return
        }

        runCatching {
            FirebaseMessaging.getInstance().token
                .addOnSuccessListener { token ->
                    // The value itself is never logged: it is a bearer
                    // credential for this device's notifications.
                    if (token.isNullOrEmpty()) {
                        Log.w(TAG, "provider returned an empty token")
                    } else {
                        PushRegistration.onNewToken(application, token)
                    }
                }
                .addOnFailureListener { error ->
                    Log.w(TAG, "current token unavailable: ${error.javaClass.simpleName}")
                }
        }.onFailure {
            Log.w(TAG, "token acquisition refused: ${it.javaClass.simpleName}")
        }
    }

    @VisibleForTesting
    fun forgetAcquisition() {
        acquired.set(false)
    }
}
