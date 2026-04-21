package com.crm.telephony.api.models

import kotlinx.serialization.Serializable

// ─── Register ─────────────────────────────────────────────

@Serializable
data class RegisterRequest(
    val androidId: String,
    val name: String,
    val phoneNumber: String? = null,
    val simOperator: String? = null,
    val appVersion: String? = null,
)

@Serializable
data class RegisterResponse(
    val deviceId: String,
    val secret: String? = null,
    val isNew: Boolean,
)

// ─── Heartbeat ────────────────────────────────────────────

@Serializable
data class HeartbeatRequest(
    val batteryLevel: Int? = null,
    val signalStrength: Int? = null,
)

@Serializable
data class HeartbeatResponse(
    val ok: Boolean,
    val commands: List<Command> = emptyList(),
)

@Serializable
data class Command(
    val commandId: String,
    val type: String,
    val payload: CommandPayload,
)

@Serializable
data class CommandPayload(
    val phoneNumber: String,
    val contactId: String? = null,
)

// ─── Call Events ──────────────────────────────────────────

@Serializable
data class CallEventRequest(
    val eventType: String,       // ringing | answered | ended
    val direction: String,       // inbound | outbound
    val phoneNumber: String,
    val callSessionId: String? = null,
    val androidCallId: String? = null,
    val timestamp: String,
    val duration: Int? = null,
    val disposition: String? = null,
)

@Serializable
data class CallEventResponse(
    val callSessionId: String,
    val contactId: String? = null,
    val contactName: String? = null,
    val chatId: String? = null,
    val messageId: String? = null,
    val idempotent: Boolean? = null,
)

// ─── Command Confirm ──────────────────────────────────────

@Serializable
data class ConfirmRequest(
    val success: Boolean,
    val failReason: String? = null,
)

// ─── Error ────────────────────────────────────────────────

@Serializable
data class ErrorResponse(
    val error: String,
)
