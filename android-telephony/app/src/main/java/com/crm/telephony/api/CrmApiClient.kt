package com.crm.telephony.api

import android.util.Log
import com.crm.telephony.api.models.*
import com.crm.telephony.auth.TelephonyCredentialManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit

class CrmApiClient(private val credentials: TelephonyCredentialManager) {

    private val json = Json { ignoreUnknownKeys = true; encodeDefaults = true }
    private val mediaType = "application/json".toMediaType()

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(30, TimeUnit.SECONDS)
        .writeTimeout(15, TimeUnit.SECONDS)
        .build()

    private fun baseUrl(): String = credentials.getServerUrl() ?: throw IllegalStateException("Server URL not configured")
    private fun authHeader(): String = "Bearer ${credentials.getSecret() ?: throw IllegalStateException("Not registered")}"

    // ─── Register (no auth) ──────────────────────────────

    suspend fun register(request: RegisterRequest): ApiResult<RegisterResponse> = withContext(Dispatchers.IO) {
        try {
            val body = json.encodeToString(request).toRequestBody(mediaType)
            val httpRequest = Request.Builder()
                .url("${baseUrl()}/api/telephony/devices/register")
                .post(body)
                .build()

            val response = client.newCall(httpRequest).execute()
            val responseBody = response.body?.string() ?: ""

            if (response.isSuccessful) {
                ApiResult.Success(json.decodeFromString<RegisterResponse>(responseBody))
            } else {
                val error = try { json.decodeFromString<ErrorResponse>(responseBody).error } catch (_: Exception) { "http_${response.code}" }
                ApiResult.Error(response.code, error)
            }
        } catch (e: Exception) {
            Log.e(TAG, "register failed", e)
            ApiResult.NetworkError(e)
        }
    }

    // ─── Heartbeat (auth required) ───────────────────────

    suspend fun heartbeat(request: HeartbeatRequest): ApiResult<HeartbeatResponse> = withContext(Dispatchers.IO) {
        try {
            val body = json.encodeToString(request).toRequestBody(mediaType)
            val httpRequest = Request.Builder()
                .url("${baseUrl()}/api/telephony/devices/heartbeat")
                .post(body)
                .header("Authorization", authHeader())
                .build()

            val response = client.newCall(httpRequest).execute()
            val responseBody = response.body?.string() ?: ""

            when {
                response.isSuccessful -> ApiResult.Success(json.decodeFromString<HeartbeatResponse>(responseBody))
                response.code == 401 -> ApiResult.Unauthorized
                else -> {
                    val error = try { json.decodeFromString<ErrorResponse>(responseBody).error } catch (_: Exception) { "http_${response.code}" }
                    ApiResult.Error(response.code, error)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "heartbeat failed", e)
            ApiResult.NetworkError(e)
        }
    }

    // ─── Call Event (auth required) ──────────────────────

    suspend fun sendCallEvent(request: CallEventRequest): ApiResult<CallEventResponse> = withContext(Dispatchers.IO) {
        try {
            val body = json.encodeToString(request).toRequestBody(mediaType)
            val httpRequest = Request.Builder()
                .url("${baseUrl()}/api/telephony/events/call")
                .post(body)
                .header("Authorization", authHeader())
                .build()

            val response = client.newCall(httpRequest).execute()
            val responseBody = response.body?.string() ?: ""

            when {
                response.isSuccessful -> ApiResult.Success(json.decodeFromString<CallEventResponse>(responseBody))
                response.code == 401 -> ApiResult.Unauthorized
                else -> {
                    val error = try { json.decodeFromString<ErrorResponse>(responseBody).error } catch (_: Exception) { "http_${response.code}" }
                    ApiResult.Error(response.code, error)
                }
            }
        } catch (e: Exception) {
            Log.e(TAG, "sendCallEvent failed", e)
            ApiResult.NetworkError(e)
        }
    }

    // ─── Command Confirm (auth required) ─────────────────

    suspend fun confirmCommand(commandId: String, request: ConfirmRequest): ApiResult<Unit> = withContext(Dispatchers.IO) {
        try {
            val body = json.encodeToString(request).toRequestBody(mediaType)
            val httpRequest = Request.Builder()
                .url("${baseUrl()}/api/telephony/commands/$commandId/confirm")
                .post(body)
                .header("Authorization", authHeader())
                .build()

            val response = client.newCall(httpRequest).execute()
            if (response.isSuccessful) ApiResult.Success(Unit)
            else if (response.code == 401) ApiResult.Unauthorized
            else ApiResult.Error(response.code, "confirm_failed")
        } catch (e: Exception) {
            Log.e(TAG, "confirmCommand failed", e)
            ApiResult.NetworkError(e)
        }
    }

    companion object {
        private const val TAG = "CrmApiClient"
    }
}

// ─── Result type ─────────────────────────────────────────

sealed class ApiResult<out T> {
    data class Success<T>(val data: T) : ApiResult<T>()
    data class Error(val code: Int, val message: String) : ApiResult<Nothing>()
    data class NetworkError(val exception: Exception) : ApiResult<Nothing>()
    data object Unauthorized : ApiResult<Nothing>()
}
