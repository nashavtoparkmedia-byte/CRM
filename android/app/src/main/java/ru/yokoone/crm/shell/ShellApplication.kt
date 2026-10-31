package ru.yokoone.crm.shell

import android.app.ActivityManager
import android.app.Application
import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.os.Build
import android.os.Process
import android.util.Log
import androidx.work.Configuration
import ru.yokoone.crm.shell.push.FcmTokenProvider
import ru.yokoone.crm.shell.push.TokenActor

/**
 * Process start.
 *
 * WorkManager is configured here and initialized on demand rather than by
 * androidx startup, because most processes this app runs in never schedule
 * anything: a process the system creates to deliver a push would otherwise
 * open WorkManager's database and start its threads before finding out there
 * is nothing to do.
 *
 * The `:reset` process (edge context reset trampoline, R5.1 §5.3 step 7, N3) is
 * inert: no notification channel, no token, no WorkManager, no WebView, no
 * diagnostics. It only waits for the main process to end and relaunches it.
 */
class ShellApplication : Application(), Configuration.Provider {

    override val workManagerConfiguration: Configuration
        get() = Configuration.Builder()
            .setMinimumLoggingLevel(Log.INFO)
            .build()

    override fun onCreate() {
        super.onCreate()
        if (isResetProcess()) return
        ChatNotifications.ensureChannel(this)
        // Every main-process start, including the ones the system makes in the
        // background to deliver a message. The token actor reads the provider
        // itself (ROTATE when a rotation is owed, otherwise one REFRESH); it is
        // a no-op unless a provider exists, and never runs twice per process.
        FcmTokenProvider.acquireCurrentToken(this)
        watchConnectivity()
    }

    /** Connectivity regained drives an owed token rotation (§5.7.2). */
    private fun watchConnectivity() {
        runCatching {
            val manager = getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
            manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) {
                    TokenActor.onRotationTrigger(this@ShellApplication)
                }
            })
        }
    }

    private fun isResetProcess(): Boolean {
        val name = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            Application.getProcessName()
        } else {
            val manager = getSystemService(Context.ACTIVITY_SERVICE) as? ActivityManager
            manager?.runningAppProcesses?.firstOrNull { it.pid == Process.myPid() }?.processName
        }
        return name?.endsWith(RESET_PROCESS_SUFFIX) == true
    }

    companion object {
        const val RESET_PROCESS_SUFFIX = ":reset"
    }
}
