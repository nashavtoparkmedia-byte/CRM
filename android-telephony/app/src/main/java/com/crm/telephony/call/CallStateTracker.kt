package com.crm.telephony.call

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.telephony.TelephonyManager
import android.util.Log
import com.crm.telephony.api.EventSender
import com.crm.telephony.api.models.CallEventRequest
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import java.time.Instant

/**
 * Tracks phone call state and sends events to CRM.
 *
 * State machine:
 *   RINGING (incoming) → POST ringing → store callSessionId
 *   OFFHOOK (answered or outgoing) → POST answered (or ringing+answered for outgoing)
 *   IDLE → query CallLog → POST ended
 */
class CallStateTracker(
    private val context: Context,
    private val eventSender: EventSender,
    private val scope: CoroutineScope,
) {
    private var currentCallSessionId: String? = null
    private var currentDirection: String? = null
    private var currentNumber: String? = null
    private var callActive = false

    private val handler = Handler(Looper.getMainLooper())

    fun onCallStateChanged(state: Int, phoneNumber: String?) {
        when (state) {
            TelephonyManager.CALL_STATE_RINGING -> handleRinging(phoneNumber)
            TelephonyManager.CALL_STATE_OFFHOOK -> handleOffhook(phoneNumber)
            TelephonyManager.CALL_STATE_IDLE -> handleIdle()
        }
    }

    private fun handleRinging(phoneNumber: String?) {
        val number = phoneNumber?.takeIf { it.isNotBlank() } ?: return
        currentNumber = number
        currentDirection = "inbound"
        callActive = true

        Log.d(TAG, "RINGING: $number")

        scope.launch(Dispatchers.IO) {
            val response = eventSender.send(CallEventRequest(
                eventType = "ringing",
                direction = "inbound",
                phoneNumber = number,
                timestamp = Instant.now().toString(),
            ))
            if (response != null) {
                currentCallSessionId = response.callSessionId
                Log.d(TAG, "Ringing sent: sessionId=${response.callSessionId}, contact=${response.contactName}")
            }
        }
    }

    private fun handleOffhook(phoneNumber: String?) {
        if (callActive && currentDirection == "inbound" && currentCallSessionId != null) {
            // Incoming call answered
            Log.d(TAG, "OFFHOOK: incoming answered")
            scope.launch(Dispatchers.IO) {
                eventSender.send(CallEventRequest(
                    eventType = "answered",
                    direction = "inbound",
                    phoneNumber = currentNumber ?: "",
                    callSessionId = currentCallSessionId,
                    timestamp = Instant.now().toString(),
                ))
            }
        } else if (!callActive) {
            // Outgoing call started
            val number = phoneNumber?.takeIf { it.isNotBlank() }
            if (number != null) {
                currentNumber = number
                currentDirection = "outbound"
                callActive = true

                Log.d(TAG, "OFFHOOK: outgoing to $number")

                scope.launch(Dispatchers.IO) {
                    // Send ringing for outbound
                    val response = eventSender.send(CallEventRequest(
                        eventType = "ringing",
                        direction = "outbound",
                        phoneNumber = number,
                        timestamp = Instant.now().toString(),
                    ))
                    if (response != null) {
                        currentCallSessionId = response.callSessionId
                        // Immediately send answered
                        eventSender.send(CallEventRequest(
                            eventType = "answered",
                            direction = "outbound",
                            phoneNumber = number,
                            callSessionId = response.callSessionId,
                            timestamp = Instant.now().toString(),
                        ))
                    }
                }
            } else {
                // Outgoing but number unknown — wait for IDLE, send recovery ended
                Log.w(TAG, "OFFHOOK: outgoing but number unknown, will recover on IDLE")
                currentDirection = "outbound"
                callActive = true
            }
        }
    }

    private fun handleIdle() {
        if (!callActive) return
        Log.d(TAG, "IDLE: call ended")

        val sessionId = currentCallSessionId
        val direction = currentDirection ?: "inbound"
        val number = currentNumber

        // Reset state immediately
        callActive = false
        currentCallSessionId = null
        currentDirection = null
        currentNumber = null

        // Wait 500ms for CallLog to update, then query
        handler.postDelayed({
            scope.launch(Dispatchers.IO) {
                val logEntry = CallLogReader.getLatestEntry(context)

                val finalNumber = number ?: logEntry?.number ?: ""
                val duration = logEntry?.duration ?: 0
                val disposition = logEntry?.disposition ?: "no_answer"

                if (finalNumber.isBlank()) {
                    Log.w(TAG, "No phone number available for ended event, skipping")
                    return@launch
                }

                eventSender.send(CallEventRequest(
                    eventType = "ended",
                    direction = direction,
                    phoneNumber = finalNumber,
                    callSessionId = sessionId,
                    timestamp = Instant.now().toString(),
                    duration = duration,
                    disposition = disposition,
                ))

                Log.d(TAG, "Ended sent: disposition=$disposition, duration=$duration")
            }
        }, 500)
    }

    companion object {
        private const val TAG = "CallStateTracker"
    }
}
