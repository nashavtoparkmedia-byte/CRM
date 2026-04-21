package com.crm.telephony.service

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import com.crm.telephony.auth.TelephonyCredentialManager

class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED) {
            val credentials = TelephonyCredentialManager(context)
            if (credentials.isRegistered()) {
                Log.d("BootReceiver", "Boot completed, starting HeartbeatService")
                val serviceIntent = Intent(context, HeartbeatService::class.java)
                context.startForegroundService(serviceIntent)
            }
        }
    }
}
