package ru.yokoone.crm.shell

import org.junit.Assert.assertEquals
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

// Robolectric supplies the real org.json and android.util.Log rather than the
// throwing stubs in the unit-test android.jar.
@RunWith(RobolectricTestRunner::class)
class ShellBridgeTest {

    private var deepLinkApplied = 0
    private var sessionExpired = 0

    private fun bridge() = ShellBridge(
        onDeepLinkApplied = { deepLinkApplied++ },
        onSessionExpired = { sessionExpired++ },
    )

    @Test
    fun `the two supported operations are dispatched`() {
        val b = bridge()
        b.handle("""{"op":"deeplink_applied"}""")
        b.handle("""{"op":"session_expired"}""")
        assertEquals(1, deepLinkApplied)
        assertEquals(1, sessionExpired)
    }

    @Test
    fun `anything outside the allowlist is ignored`() {
        val b = bridge()
        b.handle("""{"op":"navigate","url":"https://evil.example"}""")
        b.handle("""{"op":"read_file","path":"/etc/passwd"}""")
        b.handle("""{"op":"__proto__"}""")
        b.handle("""{"op":""}""")
        b.handle("""{}""")
        b.handle("not json at all")
        b.handle(null)
        assertEquals(0, deepLinkApplied)
        assertEquals(0, sessionExpired)
    }

    @Test
    fun `an oversized message is rejected before it is parsed`() {
        val b = bridge()
        val padding = "x".repeat(4096)
        b.handle("""{"op":"deeplink_applied","pad":"$padding"}""")
        assertEquals(0, deepLinkApplied)
    }
}
