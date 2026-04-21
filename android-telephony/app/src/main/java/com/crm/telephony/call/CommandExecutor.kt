package com.crm.telephony.call

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.util.Log
import com.crm.telephony.api.CrmApiClient
import com.crm.telephony.api.ApiResult
import com.crm.telephony.api.models.Command
import com.crm.telephony.api.models.ConfirmRequest

/**
 * Executes commands from CRM (e.g. initiate outbound call).
 */
class CommandExecutor(
    private val context: Context,
    private val apiClient: CrmApiClient,
) {
    suspend fun execute(command: Command) {
        when (command.type) {
            "call" -> executeCall(command)
            else -> Log.w(TAG, "Unknown command type: ${command.type}")
        }
    }

    private suspend fun executeCall(command: Command) {
        val phoneNumber = command.payload.phoneNumber

        try {
            val intent = Intent(Intent.ACTION_CALL).apply {
                data = Uri.parse("tel:$phoneNumber")
                flags = Intent.FLAG_ACTIVITY_NEW_TASK
            }
            context.startActivity(intent)
            Log.d(TAG, "Call intent launched: $phoneNumber")

            // Confirm success — CallStateTracker will handle the actual call events
            apiClient.confirmCommand(command.commandId, ConfirmRequest(success = true))
        } catch (e: SecurityException) {
            Log.e(TAG, "CALL_PHONE permission denied", e)
            apiClient.confirmCommand(command.commandId, ConfirmRequest(success = false, failReason = "permission_denied"))
        } catch (e: Exception) {
            Log.e(TAG, "Call intent failed", e)
            apiClient.confirmCommand(command.commandId, ConfirmRequest(success = false, failReason = e.message ?: "intent_failed"))
        }
    }

    companion object {
        private const val TAG = "CommandExecutor"
    }
}
