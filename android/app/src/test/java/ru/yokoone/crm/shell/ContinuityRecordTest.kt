package ru.yokoone.crm.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64
import javax.crypto.Mac
import javax.crypto.spec.SecretKeySpec

/**
 * The canonical continuity record v1 (R5.1 §5.8.2, C-2): T95–T98 and the
 * IMPL-1 sentinel. Pure JVM: the HMAC is a plain key, the format is the
 * production code.
 */
class ContinuityRecordTest {

    private fun hmac(key: String): (ByteArray) -> ByteArray = { data ->
        Mac.getInstance("HmacSHA256").run {
            init(SecretKeySpec(key.toByteArray(), "HmacSHA256"))
            doFinal(data)
        }
    }

    private val kCtx = hmac("k_ctx-generation-1")
    private val epoch = 3L

    private fun fields(fp: String = ContinuityRecord.fingerprint(kCtx, "staff.a")) =
        ContinuityRecord.Fields(fp, generation = 7L, resetEpoch = epoch, createdWallMs = 1_761_500_000_000L)

    private fun sealedBody(raw: String): Pair<String, String> {
        val bytes = raw.toByteArray(Charsets.US_ASCII)
        return Base64.getEncoder().encodeToString(bytes) to ContinuityRecord.macOf(kCtx, bytes)
    }

    private fun invalidReason(stored: Pair<String, String>, currentEpoch: Long = epoch): String {
        val result = ContinuityRecord.verify(kCtx, stored.first, stored.second, currentEpoch)
        assertTrue("expected invalid, got $result", result is ContinuityRecord.Verification.Invalid)
        return (result as ContinuityRecord.Verification.Invalid).reason
    }

    @Test
    fun `a record round-trips and the fingerprint is 64 lowercase hex`() {
        val f = fields()
        assertTrue(Regex("^[0-9a-f]{64}$").matches(f.fp))
        val stored = ContinuityRecord.encode(kCtx, f)
        assertEquals(ContinuityRecord.Verification.Valid(f), ContinuityRecord.verify(kCtx, stored.first, stored.second, epoch))
    }

    @Test
    fun `the body is exactly the five canonical fields`() {
        val f = fields()
        val text = String(ContinuityRecord.body(f), Charsets.US_ASCII)
        assertEquals("yoko.crmctx.v1\u0000${f.fp}\u00007\u00003\u00001761500000000", text)
    }

    @Test
    fun `T95 one changed byte in body or MAC is a mismatch`() {
        val (body, mac) = ContinuityRecord.encode(kCtx, fields())
        val raw = Base64.getDecoder().decode(body)
        raw[raw.size - 1] = (raw[raw.size - 1] + 1).toByte()
        assertEquals("mac", invalidReason(Base64.getEncoder().encodeToString(raw) to mac))

        val flipped = mac.toCharArray().also { it[0] = if (it[0] == 'a') 'b' else 'a' }.concatToString()
        assertEquals("mac", invalidReason(body to flipped))
    }

    @Test
    fun `T96 malformed records are each invalid`() {
        val fp = ContinuityRecord.fingerprint(kCtx, "staff.a")
        val cases = mapOf(
            "unknown version" to "yoko.crmctx.v2\u0000$fp\u00007\u00003\u00001",
            "four fields" to "yoko.crmctx.v1\u0000$fp\u00007\u00003",
            "six fields" to "yoko.crmctx.v1\u0000$fp\u00007\u00003\u00001\u00009",
            "non-hex fp" to "yoko.crmctx.v1\u0000${"z".repeat(64)}\u00007\u00003\u00001",
            "uppercase fp" to "yoko.crmctx.v1\u0000${fp.uppercase()}\u00007\u00003\u00001",
            "short fp" to "yoko.crmctx.v1\u0000${fp.take(63)}\u00007\u00003\u00001",
            "leading zero" to "yoko.crmctx.v1\u0000$fp\u000007\u00003\u00001",
            "signed decimal" to "yoko.crmctx.v1\u0000$fp\u0000+7\u00003\u00001",
            "trailing bytes" to "yoko.crmctx.v1\u0000$fp\u00007\u00003\u00001x",
            "empty value" to "yoko.crmctx.v1\u0000$fp\u0000\u00003\u00001",
            "trailing separator" to "yoko.crmctx.v1\u0000$fp\u00007\u00003\u00001\u0000",
        )
        for ((name, raw) in cases) {
            val result = ContinuityRecord.verify(kCtx, sealedBody(raw).first, sealedBody(raw).second, epoch)
            assertTrue("$name must be invalid, got $result", result is ContinuityRecord.Verification.Invalid)
        }
        assertEquals("missing", invalidReason("" to "abc"))
        assertEquals("missing", invalidReason("abc" to ""))
        assertEquals("encoding", invalidReason("***" to "abc"))
    }

    @Test
    fun `T97 a record written under a previous K_ctx is a mismatch`() {
        val old = hmac("k_ctx-generation-0")
        val stored = ContinuityRecord.encode(old, fields(ContinuityRecord.fingerprint(old, "staff.a")))
        assertEquals("mac", invalidReason(stored))
    }

    @Test
    fun `T98 a record from before a reset is a replay`() {
        val stored = ContinuityRecord.encode(kCtx, fields())
        assertEquals("epoch", invalidReason(stored, currentEpoch = epoch + 1))
    }

    @Test
    fun `fingerprints are case-sensitive, keyed and domain-separated`() {
        val a = ContinuityRecord.fingerprint(kCtx, "staff.a")
        assertNotEquals(a, ContinuityRecord.fingerprint(kCtx, "Staff.A"))
        assertNotEquals(a, ContinuityRecord.fingerprint(hmac("other"), "staff.a"))
        // The gate-less sentinel can never equal a username fingerprint, not even an empty one.
        val sentinel = ContinuityRecord.noEdgeFingerprint(kCtx)
        assertNotEquals(sentinel, ContinuityRecord.fingerprint(kCtx, ""))
        assertNotEquals(sentinel, a)
        assertTrue(ContinuityRecord.sameFingerprint(a, ContinuityRecord.fingerprint(kCtx, "staff.a")))
        assertFalse(ContinuityRecord.sameFingerprint(a, sentinel))
    }
}
