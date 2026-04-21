package com.crm.telephony.call

import android.content.Context
import android.provider.CallLog
import android.util.Log

data class CallLogEntry(
    val number: String,
    val duration: Int,       // seconds
    val disposition: String, // answered | missed | no_answer | rejected
    val type: Int,           // CallLog.Calls.TYPE value
)

object CallLogReader {

    private const val TAG = "CallLogReader"

    /**
     * Query most recent CallLog entry. Call after IDLE with 500ms delay.
     */
    fun getLatestEntry(context: Context): CallLogEntry? {
        return try {
            val cursor = context.contentResolver.query(
                CallLog.Calls.CONTENT_URI,
                arrayOf(
                    CallLog.Calls.NUMBER,
                    CallLog.Calls.DURATION,
                    CallLog.Calls.TYPE,
                ),
                null,
                null,
                "${CallLog.Calls.DATE} DESC",
            )

            cursor?.use {
                if (it.moveToFirst()) {
                    val number = it.getString(0) ?: ""
                    val duration = it.getInt(1)
                    val type = it.getInt(2)

                    CallLogEntry(
                        number = number,
                        duration = duration,
                        disposition = mapDisposition(type, duration),
                        type = type,
                    )
                } else null
            }
        } catch (e: SecurityException) {
            Log.e(TAG, "READ_CALL_LOG permission denied", e)
            null
        } catch (e: Exception) {
            Log.e(TAG, "CallLog query failed", e)
            null
        }
    }

    private fun mapDisposition(type: Int, duration: Int): String = when (type) {
        CallLog.Calls.INCOMING_TYPE -> if (duration > 0) "answered" else "missed"
        CallLog.Calls.OUTGOING_TYPE -> if (duration > 0) "answered" else "no_answer"
        CallLog.Calls.MISSED_TYPE -> "missed"
        CallLog.Calls.REJECTED_TYPE -> "rejected"
        else -> "no_answer"
    }
}
