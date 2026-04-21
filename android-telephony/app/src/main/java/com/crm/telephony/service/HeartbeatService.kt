package com.crm.telephony.service

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Intent
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.telephony.PhoneStateListener
import android.telephony.TelephonyManager
import android.util.Log
import com.crm.telephony.api.ApiResult
import com.crm.telephony.api.CrmApiClient
import com.crm.telephony.api.EventSender
import com.crm.telephony.api.models.HeartbeatRequest
import com.crm.telephony.auth.TelephonyCredentialManager
import com.crm.telephony.call.CallStateTracker
import com.crm.telephony.call.CommandExecutor
import kotlinx.coroutines.*

/**
 * Foreground service that:
 * 1. Listens to phone call state changes
 * 2. Sends heartbeat every 60 seconds
 * 3. Processes commands from CRM
 * 4. Flushes offline event queue
 */
class HeartbeatService : Service() {

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    private val handler = Handler(Looper.getMainLooper())
    private val heartbeatInterval = 60_000L

    private lateinit var credentials: TelephonyCredentialManager
    private lateinit var apiClient: CrmApiClient
    private lateinit var eventSender: EventSender
    private lateinit var callStateTracker: CallStateTracker
    private lateinit var commandExecutor: CommandExecutor

    private var phoneStateListener: PhoneStateListener? = null
    private var heartbeatRunnable: Runnable? = null

    override fun onCreate() {
        super.onCreate()
        Log.d(TAG, "Service created")

        Log.d(TAG, ">>> before credentials")
        try {
            credentials = TelephonyCredentialManager(this)
        } catch (e: Throwable) {
            Log.e(TAG, "Failed to init TelephonyCredentialManager", e)
            stopSelf()
            return
        }
        Log.d(TAG, ">>> after credentials")

        Log.d(TAG, ">>> before apiClient")
        apiClient = CrmApiClient(credentials)
        eventSender = EventSender(apiClient, credentials) {
            // onUnauthorized: re-register will be handled by MainActivity
            Log.w(TAG, "Unauthorized — device may be revoked")
        }
        callStateTracker = CallStateTracker(this, eventSender, scope)
        commandExecutor = CommandExecutor(this, apiClient)

        Log.d(TAG, ">>> before startForeground")
        createNotificationChannel()
        startForeground(NOTIFICATION_ID, buildNotification())
        Log.d(TAG, ">>> before startPhoneStateListener")
        startPhoneStateListener()
        Log.d(TAG, ">>> before scheduleHeartbeat")
        scheduleHeartbeat()
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        return START_STICKY // Restart if killed
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onDestroy() {
        Log.d(TAG, "Service destroyed")
        stopPhoneStateListener()
        heartbeatRunnable?.let { handler.removeCallbacks(it) }
        scope.cancel()
        super.onDestroy()
    }

    // ─── Phone State ────────────────────────────────────

    @Suppress("DEPRECATION")
    private fun startPhoneStateListener() {
        val tm = getSystemService(TELEPHONY_SERVICE) as? TelephonyManager ?: return

        phoneStateListener = object : PhoneStateListener() {
            override fun onCallStateChanged(state: Int, phoneNumber: String?) {
                callStateTracker.onCallStateChanged(state, phoneNumber)
            }
        }

        try {
            tm.listen(phoneStateListener, PhoneStateListener.LISTEN_CALL_STATE)
            Log.d(TAG, "Phone state listener started")
        } catch (e: SecurityException) {
            Log.e(TAG, "READ_PHONE_STATE permission denied", e)
        }
    }

    @Suppress("DEPRECATION")
    private fun stopPhoneStateListener() {
        val tm = getSystemService(TELEPHONY_SERVICE) as? TelephonyManager ?: return
        phoneStateListener?.let { tm.listen(it, PhoneStateListener.LISTEN_NONE) }
        phoneStateListener = null
    }

    // ─── Heartbeat ──────────────────────────────────────

    private fun scheduleHeartbeat() {
        heartbeatRunnable = Runnable {
            scope.launch {
                doHeartbeat()
            }
            scheduleHeartbeat() // reschedule
        }
        handler.postDelayed(heartbeatRunnable!!, heartbeatInterval)
    }

    private suspend fun doHeartbeat() {
        if (!credentials.isRegistered()) return

        // Flush offline queue first
        eventSender.flushQueue()

        val result = apiClient.heartbeat(HeartbeatRequest(
            batteryLevel = getBatteryLevel(),
            signalStrength = null, // TODO: signal strength
        ))

        when (result) {
            is ApiResult.Success -> {
                for (command in result.data.commands) {
                    commandExecutor.execute(command)
                }
            }
            is ApiResult.Unauthorized -> {
                Log.w(TAG, "Heartbeat 401 — device revoked")
                // Could show notification to user
            }
            is ApiResult.NetworkError -> Log.d(TAG, "Heartbeat network error, will retry")
            is ApiResult.Error -> Log.w(TAG, "Heartbeat error: ${result.code} ${result.message}")
        }
    }

    private fun getBatteryLevel(): Int {
        val bm = getSystemService(BATTERY_SERVICE) as? android.os.BatteryManager
        return bm?.getIntProperty(android.os.BatteryManager.BATTERY_PROPERTY_CAPACITY) ?: -1
    }

    // ─── Notification ───────────────────────────────────

    private fun createNotificationChannel() {
        val channel = NotificationChannel(
            CHANNEL_ID,
            "CRM Телефония",
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            description = "Фоновый сервис отслеживания звонков"
            setShowBadge(false)
        }
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(channel)
    }

    private fun buildNotification(): Notification {
        return Notification.Builder(this, CHANNEL_ID)
            .setContentTitle("CRM Телефония")
            .setContentText("Отслеживание звонков активно")
            .setSmallIcon(android.R.drawable.ic_menu_call)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val TAG = "HeartbeatService"
        private const val NOTIFICATION_ID = 1001
        private const val CHANNEL_ID = "crm_telephony_service"
    }
}
