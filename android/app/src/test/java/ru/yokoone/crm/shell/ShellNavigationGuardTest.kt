package ru.yokoone.crm.shell

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * The legacy `/login` interception (R5.1 §5.9, INV-21, Security R5-1) and the
 * client-side operator fence for the external BR-4 dependency.
 */
@RunWith(RobolectricTestRunner::class)
class ShellNavigationGuardTest {

    private val origin = CrmOrigin.ORIGIN

    @Test
    fun `exactly the legacy login path is recognised, with any query, on the pinned origin`() {
        for (url in listOf("$origin/login", "$origin/login?next=%2F", "$origin/login?_rsc=1a2b", "$origin/login/", "https://www.yokoone.ru/login")) {
            assertTrue(url, ShellNavigationGuard.isLegacyLogin(url))
        }
        for (url in listOf(
            "$origin${CrmOrigin.LOGIN_PATH}",
            "$origin${CrmOrigin.LOGIN_PATH}?next=%2Fmessages",
            "$origin/loginx",
            "$origin/messages?next=/login",
            "$origin/api/login",
            "https://evil.example/login",
            "http://yokoone.ru/login",
            null,
        )) {
            assertFalse(url.toString(), ShellNavigationGuard.isLegacyLogin(url))
        }
    }

    @Test
    fun `T107 unit part - the legacy login is refused whenever a mobile session exists`() {
        val url = "$origin/login"
        assertTrue("session cookie present", ShellNavigationGuard.refusesLegacyLogin(url, sessionCookiePresent = true, sessionWasValid = false))
        assertTrue("valid earlier in this process", ShellNavigationGuard.refusesLegacyLogin(url, sessionCookiePresent = false, sessionWasValid = true))
        assertFalse("no session at all: nothing to protect", ShellNavigationGuard.refusesLegacyLogin(url, sessionCookiePresent = false, sessionWasValid = false))
        assertFalse(ShellNavigationGuard.refusesLegacyLogin("$origin/messages", true, true))
    }

    @Test
    fun `cookie values are read by exact name`() {
        val jar = "yoko_mobile_session=abc; crm_user_id=op_7; crm_user_id_shadow=x"
        assertEquals("op_7", ShellNavigationGuard.cookieValue(jar, "crm_user_id"))
        assertNull(ShellNavigationGuard.cookieValue(jar, "crm_user"))
        assertNull(ShellNavigationGuard.cookieValue(null, "crm_user_id"))
    }

    @Test
    fun `BR-4 fence - a rewritten or deleted operator after the first VALID page is a violation`() {
        val fence = ShellNavigationGuard.OperatorFence()
        assertFalse("unarmed fences never fire", fence.isViolated("crm_user_id=op_9"))

        fence.bind("yoko_mobile_session=abc")
        assertFalse("no operator yet: binds when one appears", fence.isArmed)
        fence.bind("yoko_mobile_session=abc; crm_user_id=op_7")
        assertTrue(fence.isArmed)
        fence.bind("yoko_mobile_session=abc; crm_user_id=op_9")

        assertFalse(fence.isViolated("yoko_mobile_session=abc; crm_user_id=op_7"))
        assertTrue("TopBar dropdown rewrite", fence.isViolated("yoko_mobile_session=abc; crm_user_id=op_9"))
        assertTrue("TopBar logout deletes it", fence.isViolated("yoko_mobile_session=abc"))
    }
}
