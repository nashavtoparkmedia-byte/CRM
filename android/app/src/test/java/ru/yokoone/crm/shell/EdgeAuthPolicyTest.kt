package ru.yokoone.crm.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * Which staff challenges the shell may answer (R5.1 §3.1–§3.3 rule A).
 *
 * Runs against the release variant (`testReleaseUnitTest`), whose pinned origin
 * is `https://yokoone.ru`.
 */
@RunWith(RobolectricTestRunner::class)
class EdgeAuthPolicyTest {

    private val host = EdgeAuthPolicy.PINNED_HOST

    @Test
    fun `T1 the pinned host and the staff realm are accepted, host case-insensitively`() {
        assertEquals("yokoone.ru", host)
        assertTrue(EdgeAuthPolicy.acceptsChallenge(host, "YOKO CRM", preconditionsMet = true))
        assertTrue(EdgeAuthPolicy.acceptsChallenge("YokoOne.RU", "YOKO CRM", preconditionsMet = true))
    }

    @Test
    fun `T2 everything else is refused, each for its own reason`() {
        val refusedHosts = listOf("www.yokoone.ru", "app.yokoone.ru", "yokoone.ru:443", "yokoone.ru:8080", "proxy.local", "evil.example", "", null)
        for (candidate in refusedHosts) {
            assertEquals("host $candidate", EdgeAuthPolicy.Refusal.HOST, EdgeAuthPolicy.refusal(candidate, "YOKO CRM", true))
        }
        for (realm in listOf("YOKO compensation", "YOKO Cash", "yoko crm", "YOKO CRM ", "", null)) {
            assertEquals("realm $realm", EdgeAuthPolicy.Refusal.REALM, EdgeAuthPolicy.refusal(host, realm, true))
        }
        // Unconfirmed proxy override or a non-https origin: nothing is answered at all.
        assertEquals(EdgeAuthPolicy.Refusal.PRECONDITION, EdgeAuthPolicy.refusal(host, "YOKO CRM", false))
        assertFalse(EdgeAuthPolicy.preconditions(proxyOverrideConfirmed = false))
        assertFalse(EdgeAuthPolicy.preconditions(proxyOverrideConfirmed = true, originIsHttps = false))
        assertTrue(EdgeAuthPolicy.preconditions(proxyOverrideConfirmed = true, originIsHttps = true))
    }

    @Test
    fun `T46 a non-https origin refuses every challenge`() {
        val met = EdgeAuthPolicy.preconditions(proxyOverrideConfirmed = true, originIsHttps = false)
        assertFalse(EdgeAuthPolicy.acceptsChallenge(host, "YOKO CRM", met))
        assertEquals(EdgeAuthPolicy.Refusal.PRECONDITION, EdgeAuthPolicy.refusal(host, "YOKO CRM", met))
    }

    @Test
    fun `T3 classify401 tells nginx from the CRM`() {
        val api = "${CrmOrigin.ORIGIN}/api/mobile/push-registration"
        val page = "${CrmOrigin.ORIGIN}/messages"
        assertEquals(EdgeAuthPolicy.Kind401.EDGE, EdgeAuthPolicy.classify401(mapOf("WWW-Authenticate" to "Basic realm=\"YOKO CRM\""), page))
        assertEquals(EdgeAuthPolicy.Kind401.EDGE, EdgeAuthPolicy.classify401(mapOf("www-authenticate" to "basic realm=\"x\""), api))
        assertEquals(EdgeAuthPolicy.Kind401.MOBILE_SESSION, EdgeAuthPolicy.classify401(emptyMap(), api))
        assertEquals(EdgeAuthPolicy.Kind401.MOBILE_SESSION, EdgeAuthPolicy.classify401(null, api))
        assertEquals(EdgeAuthPolicy.Kind401.OTHER, EdgeAuthPolicy.classify401(emptyMap(), page))
        assertEquals(EdgeAuthPolicy.Kind401.OTHER, EdgeAuthPolicy.classify401(mapOf("WWW-Authenticate" to "Bearer"), page))
        assertEquals(EdgeAuthPolicy.Kind401.OTHER, EdgeAuthPolicy.classify401(emptyMap(), "https://evil.example/api/x"))
    }

    @Test
    fun `T36 release pins the 12 h limit and the 5 min unaccepted limit`() {
        assertEquals(43_200_000L, EdgeAuthPolicy.RELEASE_EDGE_MAX_AGE_MS)
        assertEquals(43_200_000L, EdgeAuthPolicy.EDGE_MAX_AGE_MS)
        assertEquals(43_200_000L, BuildConfig.EDGE_MAX_AGE_MS)
        assertEquals(300_000L, EdgeAuthPolicy.UNACCEPTED_MAX_MS)
        assertEquals(3, EdgeAuthPolicy.MAX_PROMPTS_PER_NAVIGATION)
        assertEquals(8, EdgeAuthPolicy.MAX_AUTO_ANSWERS_PER_NAVIGATION)
    }

    @Test
    fun `T45 the release origin is https and answers challenges`() {
        assertTrue(CrmOrigin.ORIGIN.startsWith("https://"))
        assertTrue(EdgeAuthPolicy.ORIGIN_IS_HTTPS)
    }

    @Test
    fun `the native header goes only to https on exactly the pinned host`() {
        assertTrue(EdgeAuthPolicy.isPinnedHttpsEndpoint("https://yokoone.ru/api/mobile/push-registration"))
        assertFalse(EdgeAuthPolicy.isPinnedHttpsEndpoint("http://yokoone.ru/api/mobile/push-registration"))
        assertFalse(EdgeAuthPolicy.isPinnedHttpsEndpoint("https://www.yokoone.ru/api/mobile/push-registration"))
        assertFalse(EdgeAuthPolicy.isPinnedHttpsEndpoint("https://yokoone.ru:8443/api"))
        assertFalse(EdgeAuthPolicy.isPinnedHttpsEndpoint("http://127.0.0.1:3002/api"))
        assertFalse(EdgeAuthPolicy.isPinnedHttpsEndpoint(null))
    }

    @Test
    fun `the probe is the pinned origin's favicon and nothing else`() {
        assertEquals("https://yokoone.ru/favicon.ico", EdgeAuthPolicy.probeUrl())
        assertTrue(EdgeAuthPolicy.isProbeUrl(EdgeAuthPolicy.probeUrl()))
        assertFalse(EdgeAuthPolicy.isProbeUrl("https://www.yokoone.ru/favicon.ico"))
        assertFalse(EdgeAuthPolicy.isProbeUrl("https://yokoone.ru/messages"))
        assertFalse(EdgeAuthPolicy.isProbeUrl("https://evil.example/favicon.ico"))
        assertFalse(EdgeAuthPolicy.isProbeUrl(null))
    }

    @Test
    fun `the staff gate is recognised whatever the preconditions`() {
        assertTrue(EdgeAuthPolicy.isStaffGate(host, "YOKO CRM"))
        assertFalse(EdgeAuthPolicy.isStaffGate(host, "YOKO Cash"))
        assertFalse(EdgeAuthPolicy.isStaffGate("www.yokoone.ru", "YOKO CRM"))
        assertNull(EdgeAuthPolicy.refusal(host, "YOKO CRM", true))
    }
}
