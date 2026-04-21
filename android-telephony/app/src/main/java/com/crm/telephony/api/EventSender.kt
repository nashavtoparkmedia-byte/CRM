package com.crm.telephony.api

import android.util.Log
import com.crm.telephony.api.models.CallEventRequest
import com.crm.telephony.api.models.CallEventResponse
import com.crm.telephony.auth.TelephonyCredentialManager
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.util.concurrent.ConcurrentLinkedQueue

/**
 * Sends call events to CRM with offline queue and retry.
 *
 * For MVP: in-memory queue (lost on process death).
 * Room-based persistence deferred to hardening phase.
 */
class EventSender(
    private val apiClient: CrmApiClient,
    private val credentials: TelephonyCredentialManager,
    private val onUnauthorized: () -> Unit,
) {
    private val pendingQueue = ConcurrentLinkedQueue<CallEventRequest>()
    private val flushMutex = Mutex()

    suspend fun send(event: CallEventRequest): CallEventResponse? {
        val result = apiClient.sendCallEvent(event)
        return when (result) {
            is ApiResult.Success -> result.data
            is ApiResult.Unauthorized -> {
                Log.w(TAG, "Unauthorized, triggering re-register")
                onUnauthorized()
                null
            }
            is ApiResult.NetworkError -> {
                Log.w(TAG, "Network error, queuing event: ${event.eventType}")
                enqueue(event)
                null
            }
            is ApiResult.Error -> {
                if (result.code >= 500) {
                    Log.w(TAG, "Server error ${result.code}, queuing event")
                    enqueue(event)
                } else {
                    Log.e(TAG, "Client error ${result.code}: ${result.message}, dropping event")
                }
                null
            }
        }
    }

    private fun enqueue(event: CallEventRequest) {
        pendingQueue.add(event)
        // Cap queue at 100
        while (pendingQueue.size > 100) pendingQueue.poll()
    }

    suspend fun flushQueue() = flushMutex.withLock {
        if (pendingQueue.isEmpty()) return

        val toRetry = mutableListOf<CallEventRequest>()
        var count = 0

        while (pendingQueue.isNotEmpty() && count < 10) { // batch limit per flush
            val event = pendingQueue.poll() ?: break
            val result = apiClient.sendCallEvent(event)
            when (result) {
                is ApiResult.Success -> Log.d(TAG, "Flushed queued event: ${event.eventType}")
                is ApiResult.Unauthorized -> { onUnauthorized(); return }
                is ApiResult.NetworkError -> { toRetry.add(event); break } // stop flush, re-queue rest
                is ApiResult.Error -> {
                    if (result.code >= 500) toRetry.add(event)
                    // 4xx dropped
                }
            }
            count++
        }

        // Re-queue failed items at front
        for (event in toRetry.reversed()) {
            val temp = mutableListOf(event)
            temp.addAll(pendingQueue)
            pendingQueue.clear()
            pendingQueue.addAll(temp)
        }
    }

    fun queueSize(): Int = pendingQueue.size

    companion object {
        private const val TAG = "EventSender"
    }
}
