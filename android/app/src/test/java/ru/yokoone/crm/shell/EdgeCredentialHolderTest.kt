package ru.yokoone.crm.shell

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.util.Base64

/**
 * The staff credential's lifetime rules (R5.1 §3.1, F-1, INV-4, INV-17), on a
 * fake monotonic clock.
 */
@RunWith(RobolectricTestRunner::class)
class EdgeCredentialHolderTest {

    private var now = 1_000_000L
    private val holder = EdgeCredentialHolder

    @Before
    fun setUp() {
        holder.resetForTest()
        holder.clock = { now }
        ShellForeground.started = true
    }

    @After
    fun tearDown() {
        holder.resetForTest()
        ShellForeground.started = false
    }

    private fun fill(user: String = "staff.a", password: String = "pa55word") = holder.set(user, password.toCharArray())

    @Test
    fun `T4 the header is Basic base64 of user colon password, only for an accepted credential`() {
        fill()
        assertNull("unaccepted: the native lane gets nothing", holder.authorizationHeaderOrNull())
        holder.markAccepted()
        val expected = "Basic " + Base64.getEncoder().encodeToString("staff.a:pa55word".toByteArray())
        assertEquals(expected, holder.authorizationHeaderOrNull())
    }

    @Test
    fun `T4 clear empties the holder and zeroes the buffer, and toString says nothing`() {
        val typed = "pa55word".toCharArray()
        holder.set("staff.a", typed)
        assertTrue("the caller's copy is wiped at once", typed.all { it == '\u0000' })
        val buffer = holder.passwordBufferForTest()!!
        holder.clear()
        assertTrue("the holder's own buffer is zeroed", buffer.all { it == '\u0000' })
        assertFalse(holder.isPresent)
        assertNull(holder.authorizationHeaderOrNull())
        assertEquals("EdgeCredentialHolder", holder.toString())
    }

    @Test
    fun `the native header needs the activity STARTED (Variant A)`() {
        fill()
        holder.markAccepted()
        ShellForeground.started = false
        assertNull(holder.authorizationHeaderOrNull())
        ShellForeground.started = true
        assertTrue(holder.authorizationHeaderOrNull()!!.startsWith("Basic "))
    }

    @Test
    fun `T88 an unaccepted credential expires 5 minutes after fill`() {
        fill()
        now += EdgeAuthPolicy.UNACCEPTED_MAX_MS - 1
        assertFalse(holder.isExpired())
        now += 1
        assertTrue(holder.isExpired())
        assertFalse(holder.proceedWith { _, _ -> throw AssertionError("must not proceed") })
    }

    @Test
    fun `T89 an accepted credential expires 12 h after fill, not after acceptance`() {
        fill()
        now += 4 * 60 * 1000L
        holder.markAccepted()
        val fillTime = 1_000_000L
        now = fillTime + EdgeAuthPolicy.EDGE_MAX_AGE_MS - 1
        assertFalse(holder.isExpired())
        now = fillTime + EdgeAuthPolicy.EDGE_MAX_AGE_MS
        assertTrue("expiry is at fill + 12 h", holder.isExpired())
        assertNull(holder.authorizationHeaderOrNull())
        assertEquals(fillTime + EdgeAuthPolicy.EDGE_MAX_AGE_MS, holder.expiryAtElapsed())
    }

    @Test
    fun `T90 a challenge at the same tick as expiry is not answered`() {
        fill()
        now += EdgeAuthPolicy.UNACCEPTED_MAX_MS
        var proceeded = false
        assertFalse(holder.proceedWith { _, _ -> proceeded = true })
        assertFalse(proceeded)
    }

    @Test
    fun `T91 a clock that went backwards or a missing fill time is expired`() {
        fill()
        now -= 1
        assertTrue(holder.isExpired())
        holder.clear()
        assertTrue("absent is expired", holder.isExpired())
    }

    @Test
    fun `onStop clears an unaccepted credential and keeps an accepted one`() {
        fill()
        assertTrue(holder.onStop())
        assertFalse(holder.isPresent)

        fill()
        holder.markAccepted()
        assertFalse(holder.onStop())
        assertTrue(holder.isPresent)
    }

    @Test
    fun `nothing renews the fill time except a new fill`() {
        fill()
        holder.markAccepted()
        now += EdgeAuthPolicy.EDGE_MAX_AGE_MS - 10
        holder.markAccepted()
        now += 10
        assertTrue(holder.isExpired())
    }

    @Test
    fun `the first proceeded username is pinned for the process and survives clear`() {
        holder.pinIfFirst("staff.a")
        holder.pinIfFirst("staff.b")
        assertEquals("staff.a", holder.pinnedUsername)
        holder.clear()
        assertEquals("staff.a", holder.pinnedUsername)
    }
}
