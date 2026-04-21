package com.crm.telephony.auth

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

class TelephonyCredentialManager(context: Context) {

    private val masterKey = MasterKey.Builder(context)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context,
        "crm_telephony_credentials",
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
    )

    fun getDeviceId(): String? = prefs.getString(KEY_DEVICE_ID, null)
    fun getSecret(): String? = prefs.getString(KEY_SECRET, null)
    fun getServerUrl(): String? = prefs.getString(KEY_SERVER_URL, null)

    fun store(deviceId: String, secret: String): Boolean {
        return prefs.edit()
            .putString(KEY_DEVICE_ID, deviceId)
            .putString(KEY_SECRET, secret)
            .commit()
    }

    fun setServerUrl(url: String) {
        prefs.edit().putString(KEY_SERVER_URL, url.trimEnd('/')).apply()
    }

    fun clear() {
        val serverUrl = getServerUrl() // preserve server URL
        prefs.edit().clear().apply()
        if (serverUrl != null) setServerUrl(serverUrl)
    }

    fun isRegistered(): Boolean = getDeviceId() != null && getSecret() != null
    fun isConfigured(): Boolean = getServerUrl() != null

    companion object {
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_SECRET = "device_secret"
        private const val KEY_SERVER_URL = "server_url"
    }
}
