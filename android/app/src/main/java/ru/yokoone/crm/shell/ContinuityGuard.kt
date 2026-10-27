package ru.yokoone.crm.shell

import android.content.Context
import androidx.annotation.VisibleForTesting
import ru.yokoone.crm.shell.push.PushTokenState
import java.security.MessageDigest
import java.util.Base64

/**
 * The continuity record, canonical format version 1 (R5.1 §5.8.2, C-2).
 *
 * `fp   = hex(HMAC(K_ctx, "yoko.crmctx.fp.v1"  ‖ 0x00 ‖ UTF-8(username)))`
 * `body = "yoko.crmctx.v1" ‖ 0x00 ‖ fp ‖ 0x00 ‖ generation ‖ 0x00 ‖ resetEpoch ‖ 0x00 ‖ createdWallMs`
 * `mac  = hex(HMAC(K_ctx, "yoko.crmctx.mac.v1" ‖ 0x00 ‖ body))`
 *
 * Verification is MAC first (constant time), then a strict parse; anything
 * unexpected is invalid and an invalid record is never partially used.
 *
 * IMPL-1 (implementation erratum): a CRM session established while the edge
 * gate was absent is recorded with the domain-separated sentinel fingerprint
 * `hex(HMAC(K_ctx, "yoko.crmctx.noedge.v1" ‖ 0x00))` in the same canonical body.
 * No username fingerprint can equal it (different HMAC input domain). Such a
 * record lets the session continue only while the gate is still known to be
 * absent; any staff challenge in a process whose session is gate-less resets
 * the context before a credential is sent (§5.8.4 "reset when the gate appears").
 */
object ContinuityRecord {

    const val VERSION = "yoko.crmctx.v1"
    const val FP_PREFIX = "yoko.crmctx.fp.v1"
    const val MAC_PREFIX = "yoko.crmctx.mac.v1"
    const val NO_EDGE_PREFIX = "yoko.crmctx.noedge.v1"

    private val FP_SHAPE = Regex("^[0-9a-f]{64}$")
    private val CANONICAL_DECIMAL = Regex("^(0|[1-9][0-9]{0,17})$")

    data class Fields(val fp: String, val generation: Long, val resetEpoch: Long, val createdWallMs: Long)

    sealed interface Verification {
        data class Valid(val fields: Fields) : Verification
        data class Invalid(val reason: String) : Verification
    }

    fun fingerprint(mac: (ByteArray) -> ByteArray, username: String): String =
        ShellKeys.hex(mac(prefixed(FP_PREFIX, username.toByteArray(Charsets.UTF_8))))

    fun noEdgeFingerprint(mac: (ByteArray) -> ByteArray): String =
        ShellKeys.hex(mac(prefixed(NO_EDGE_PREFIX, ByteArray(0))))

    fun body(fields: Fields): ByteArray =
        listOf(VERSION, fields.fp, fields.generation.toString(), fields.resetEpoch.toString(), fields.createdWallMs.toString())
            .joinToString("\u0000")
            .toByteArray(Charsets.US_ASCII)

    fun macOf(mac: (ByteArray) -> ByteArray, body: ByteArray): String =
        ShellKeys.hex(mac(prefixed(MAC_PREFIX, body)))

    /** (base64 body, hex mac) as stored in `crm_ctx_body` / `crm_ctx_mac`. */
    fun encode(mac: (ByteArray) -> ByteArray, fields: Fields): Pair<String, String> {
        require(FP_SHAPE.matches(fields.fp))
        require(fields.generation >= 0 && fields.resetEpoch >= 0 && fields.createdWallMs >= 0)
        val raw = body(fields)
        return Base64.getEncoder().encodeToString(raw) to macOf(mac, raw)
    }

    fun verify(
        mac: (ByteArray) -> ByteArray,
        storedBody: String?,
        storedMac: String?,
        currentResetEpoch: Long,
    ): Verification {
        if (storedBody.isNullOrEmpty() || storedMac.isNullOrEmpty()) return Verification.Invalid("missing")
        val raw = runCatching { Base64.getDecoder().decode(storedBody) }.getOrNull()
            ?: return Verification.Invalid("encoding")
        val expected = runCatching { macOf(mac, raw) }.getOrNull()
            ?: return Verification.Invalid("key")
        if (!MessageDigest.isEqual(expected.toByteArray(Charsets.US_ASCII), storedMac.toByteArray(Charsets.US_ASCII))) {
            return Verification.Invalid("mac")
        }
        if (raw.any { it.toInt() != 0 && (it < 0x20 || it > 0x7e) }) return Verification.Invalid("bytes")
        val parts = String(raw, Charsets.US_ASCII).split('\u0000')
        if (parts.size != 5) return Verification.Invalid("fields")
        if (parts[0] != VERSION) return Verification.Invalid("version")
        if (!FP_SHAPE.matches(parts[1])) return Verification.Invalid("fp")
        val numbers = parts.subList(2, 5).map { if (CANONICAL_DECIMAL.matches(it)) it.toLongOrNull() else null }
        if (numbers.any { it == null }) return Verification.Invalid("decimal")
        val fields = Fields(parts[1], numbers[0]!!, numbers[1]!!, numbers[2]!!)
        if (fields.resetEpoch != currentResetEpoch) return Verification.Invalid("epoch")
        return Verification.Valid(fields)
    }

    fun sameFingerprint(a: String, b: String): Boolean =
        MessageDigest.isEqual(a.toByteArray(Charsets.US_ASCII), b.toByteArray(Charsets.US_ASCII))

    private fun prefixed(prefix: String, payload: ByteArray): ByteArray {
        val head = prefix.toByteArray(Charsets.US_ASCII)
        val out = ByteArray(head.size + 1 + payload.size)
        System.arraycopy(head, 0, out, 0, head.size)
        out[head.size] = 0
        System.arraycopy(payload, 0, out, head.size + 1, payload.size)
        return out
    }
}

/**
 * The edge-principal continuity barrier (R5.1 §5.8.3), its process state and
 * its durable record.
 *
 * The barrier proves only that the edge login nginx accepted in this process is
 * the edge login the device's CRM session was established under. It never
 * stands for CRM identity and never sends the old cookies to find out.
 */
object ContinuityGuard {

    /** Process-scoped. UNDECIDED until MainActivity has run the barrier in this process. */
    enum class State { UNDECIDED, NONE, PENDING, CONFIRMED, MISMATCH }

    /** Durable tri-state of `edge_gate_seen` (IMPL-1). */
    enum class EdgeGate { UNKNOWN, ABSENT, PRESENT }

    sealed interface Precheck {
        /** No residual CRM context: no barrier. */
        data object None : Precheck

        /** A session established while the gate was absent, gate still absent (IMPL-1). */
        data object ConfirmedNoEdge : Precheck

        /** Prompt and run the cookie-less probe; decide against [recordFp]. */
        data class Probe(val recordFp: String) : Precheck

        data class Mismatch(val reason: String) : Precheck
    }

    enum class ProbeOutcome { ACCEPTED, REFUSED, UNVERIFIED, UNDECIDED }

    enum class WriteResult { WRITTEN, SAME, MISMATCH, KEY_UNAVAILABLE }

    @Volatile
    var state: State = State.UNDECIDED

    /** The registrar may send only once continuity is decided in this process (§4.1 item 8). */
    val allowsRegistration: Boolean get() = state == State.NONE || state == State.CONFIRMED

    /** Whether the CRM session of this process was established without an edge principal. */
    @Volatile
    var sessionIsGateless: Boolean = false

    @VisibleForTesting
    fun resetForTest() {
        state = State.UNDECIDED
        sessionIsGateless = false
    }

    /**
     * Step 3, no network. Pure: every input is passed in.
     *
     * [installKeyAvailable] covers K_install (C-1); K_ctx availability is part
     * of [verification] (a key failure verifies as invalid).
     */
    fun precheck(
        sessionCookiePresent: Boolean,
        recordStored: Boolean,
        verification: ContinuityRecord.Verification?,
        installKeyAvailable: Boolean,
        gate: EdgeGate,
        noEdgeFingerprint: String?,
    ): Precheck {
        if (!sessionCookiePresent && !recordStored) return Precheck.None
        if (!installKeyAvailable) return Precheck.Mismatch("install-key")
        if (!recordStored) return Precheck.Mismatch("no-record")
        val fields = when (verification) {
            is ContinuityRecord.Verification.Valid -> verification.fields
            is ContinuityRecord.Verification.Invalid -> return Precheck.Mismatch("record-${verification.reason}")
            null -> return Precheck.Mismatch("record-missing")
        }
        if (noEdgeFingerprint != null && ContinuityRecord.sameFingerprint(fields.fp, noEdgeFingerprint)) {
            return if (gate == EdgeGate.ABSENT) Precheck.ConfirmedNoEdge else Precheck.Mismatch("gate-appeared")
        }
        if (gate != EdgeGate.PRESENT) return Precheck.Mismatch("gate-unknown")
        return Precheck.Probe(fields.fp)
    }

    /**
     * The probe's own response, read directly (Security R5.1-1).
     *
     * An edge 401 (Basic) is a refusal. Any other HTTP answer to the probe is
     * edge acceptance only if a credential was actually sent for it; without a
     * proceed() nothing was verified and the answer counts as UNVERIFIED (→
     * mismatch). A network or TLS failure decides nothing.
     */
    fun classifyProbe(status: Int?, wwwAuthenticate: String?, proceeded: Boolean, transportFailed: Boolean): ProbeOutcome {
        if (transportFailed || status == null) return ProbeOutcome.UNDECIDED
        val basic = wwwAuthenticate?.trim()?.regionMatches(0, "Basic", 0, 5, ignoreCase = true) == true
        if (status == 401 && basic) return ProbeOutcome.REFUSED
        return if (proceeded) ProbeOutcome.ACCEPTED else ProbeOutcome.UNVERIFIED
    }

    /**
     * Step 5: decide on the username nginx accepted, never on what was typed
     * last. Returns true for CONFIRMED.
     */
    fun decide(
        acceptedUsername: String?,
        pinnedUsername: String?,
        recordFp: String,
        installKeyAvailable: Boolean,
        fingerprintOf: (String) -> String?,
    ): Boolean {
        if (!installKeyAvailable) return false
        if (acceptedUsername == null || pinnedUsername == null) return false
        if (acceptedUsername != pinnedUsername) return false
        val fp = fingerprintOf(acceptedUsername) ?: return false
        return ContinuityRecord.sameFingerprint(fp, recordFp)
    }

    // ── durable record, stored in PushTokenState's file so reset step 0 deletes it atomically ──

    private fun contextMac(alias: String): (ByteArray) -> ByteArray = { data -> ShellKeys.backend.hmac(alias, data) }

    /** Verify the stored record against the current K_ctx and reset epoch. */
    fun verifyStored(context: Context): Pair<Boolean, ContinuityRecord.Verification?> {
        val stored = PushTokenState.continuityRecord(context)
        if (stored.body == null && stored.mac == null) return false to null
        val alias = stored.keyAlias ?: return true to ContinuityRecord.Verification.Invalid("key")
        val present = runCatching { ShellKeys.backend.exists(alias) }.getOrDefault(false)
        if (!present) return true to ContinuityRecord.Verification.Invalid("key")
        return true to ContinuityRecord.verify(contextMac(alias), stored.body, stored.mac, stored.resetEpoch)
    }

    fun noEdgeFingerprint(context: Context): String? {
        val alias = PushTokenState.continuityRecord(context).keyAlias ?: return null
        return runCatching { ContinuityRecord.noEdgeFingerprint(contextMac(alias)) }.getOrNull()
    }

    fun fingerprintOf(context: Context, username: String): String? {
        val alias = PushTokenState.continuityRecord(context).keyAlias ?: return null
        return runCatching { ContinuityRecord.fingerprint(contextMac(alias), username) }.getOrNull()
    }

    /**
     * Rule G record write with R4-IA-1 protection: written only when no valid
     * record exists or the fingerprint is identical; a different fingerprint is
     * a MISMATCH and nothing is written. [username] null writes the gate-less
     * sentinel (IMPL-1).
     */
    fun writeRecord(context: Context, username: String?, wallMs: Long = System.currentTimeMillis()): WriteResult {
        return synchronized(PushTokenState.LOCK) {
            val stored = PushTokenState.continuityRecordLocked(context)
            var alias = stored.keyAlias
            if (alias != null && (stored.body != null || stored.mac != null)) {
                val mac = contextMac(alias)
                val existing = ContinuityRecord.verify(mac, stored.body, stored.mac, stored.resetEpoch)
                if (existing is ContinuityRecord.Verification.Valid) {
                    val wanted = runCatching {
                        if (username == null) ContinuityRecord.noEdgeFingerprint(mac) else ContinuityRecord.fingerprint(mac, username)
                    }.getOrNull() ?: return WriteResult.KEY_UNAVAILABLE
                    return if (ContinuityRecord.sameFingerprint(existing.fields.fp, wanted)) WriteResult.SAME else WriteResult.MISMATCH
                }
            }
            // No valid record: write under the current key, creating one if needed.
            val usable = alias != null && runCatching {
                ShellKeys.backend.exists(alias!!) && ShellKeys.backend.hmac(alias!!, ByteArray(1)).isNotEmpty()
            }.getOrDefault(false)
            if (!usable) {
                val next = PushTokenState.nextContextKeyAliasLocked(context)
                val created = runCatching {
                    runCatching { ShellKeys.backend.delete(next) }
                    ShellKeys.backend.create(next)
                    ShellKeys.backend.hmac(next, ByteArray(1)).isNotEmpty()
                }.getOrDefault(false)
                if (!created) {
                    ShellDiagnostics.write("YOKO_NET fail continuity keystore-unavailable")
                    return WriteResult.KEY_UNAVAILABLE
                }
                alias = next
            }
            val mac = contextMac(alias!!)
            val encoded = runCatching {
                val fp = if (username == null) ContinuityRecord.noEdgeFingerprint(mac) else ContinuityRecord.fingerprint(mac, username)
                ContinuityRecord.encode(
                    mac,
                    ContinuityRecord.Fields(fp, stored.generation, stored.resetEpoch, wallMs.coerceAtLeast(0)),
                )
            }.getOrNull() ?: return WriteResult.KEY_UNAVAILABLE
            PushTokenState.storeContinuityRecordLocked(context, alias!!, encoded.first, encoded.second)
            WriteResult.WRITTEN
        }
    }
}
