package ru.yokoone.crm.shell.push

import com.sun.net.httpserver.HttpExchange
import com.sun.net.httpserver.HttpServer
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.net.InetAddress
import java.net.InetSocketAddress

/**
 * The one request the shell makes, driven against a real loopback server.
 *
 * A mocked client would prove the code calls something; this proves what
 * actually goes on the wire and what is done with each answer P1 can give. The
 * redirect case is the one with a security edge: following a 302 would put the
 * session cookie on a URL the shell never chose, so the assertion is both that
 * the outcome is a refusal and that the redirect target was never contacted.
 */
@RunWith(RobolectricTestRunner::class)
class PushRegistrarTest {

    private data class Recorded(
        val method: String,
        val contentType: String?,
        val cookie: String?,
        val body: String,
    )

    private lateinit var server: HttpServer
    private var running = false
    private val recorded = mutableListOf<Recorded>()
    private var redirectsFollowed = 0

    private var status = 200
    private var responseBody = ""
    private var location: String? = null

    private val token = "fcm-token-0123456789abcdef"
    private val cookiePair = "${PushRegistrar.SESSION_COOKIE_NAME}=s3ss10nvalue"

    private val endpoint: String
        get() = "http://127.0.0.1:${server.address.port}/api/mobile/push-registration"

    @Before
    fun startServer() {
        server = HttpServer.create(InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0)
        server.createContext("/api/mobile/push-registration") { exchange -> answer(exchange) }
        server.createContext("/elsewhere") { exchange ->
            redirectsFollowed += 1
            exchange.sendResponseHeaders(200, -1)
            exchange.close()
        }
        server.start()
        running = true
    }

    @After
    fun stopServer() {
        if (running) server.stop(0)
        running = false
    }

    private fun answer(exchange: HttpExchange) {
        val body = exchange.requestBody.readBytes().toString(Charsets.UTF_8)
        recorded += Recorded(
            method = exchange.requestMethod,
            contentType = exchange.requestHeaders.getFirst("Content-Type"),
            cookie = exchange.requestHeaders.getFirst("Cookie"),
            body = body,
        )
        location?.let { exchange.responseHeaders.add("Location", it) }
        val payload = responseBody.toByteArray(Charsets.UTF_8)
        exchange.sendResponseHeaders(status, if (payload.isEmpty()) -1L else payload.size.toLong())
        if (payload.isNotEmpty()) exchange.responseBody.use { it.write(payload) }
        exchange.close()
    }

    @Test
    fun `an accepted registration is exactly one POST carrying the session cookie`() {
        status = 200

        assertEquals(PushRegistrar.Outcome.Registered, PushRegistrar.post(endpoint, token, cookiePair))

        assertEquals(1, recorded.size)
        val request = recorded.single()
        assertEquals("POST", request.method)
        assertEquals("application/json", request.contentType)
        assertEquals(cookiePair, request.cookie)
        assertEquals("""{"token":"$token"}""", request.body)
    }

    @Test
    fun `every refusal P1 can answer with is carried through by name`() {
        for (case in listOf(
            401 to "MOBILE_SESSION_REQUIRED",
            401 to "MOBILE_SESSION_REVOKED",
            401 to "MOBILE_SESSION_REISSUE_REQUIRED",
            422 to "PUSH_DEVICE_ID_NOT_STABLE",
            409 to "PUSH_TOKEN_BOUND_TO_OTHER_DEVICE",
            415 to "JSON_REQUIRED",
            413 to "BODY_TOO_LARGE",
            400 to "INVALID_BODY",
        )) {
            status = case.first
            responseBody = """{"error":"${case.second}"}"""

            assertEquals(
                PushRegistrar.Outcome.Refused(case.second),
                PushRegistrar.post(endpoint, token, cookiePair),
            )
        }
    }

    @Test
    fun `a refusal with no readable body still refuses rather than retrying`() {
        status = 401
        responseBody = ""

        assertEquals(PushRegistrar.Outcome.Refused("HTTP_401"), PushRegistrar.post(endpoint, token, cookiePair))
    }

    @Test
    fun `a redirect is refused and never followed`() {
        status = 302
        location = "/elsewhere"

        assertEquals(
            PushRegistrar.Outcome.Refused("UNEXPECTED_REDIRECT"),
            PushRegistrar.post(endpoint, token, cookiePair),
        )
        assertEquals("the session cookie must not be replayed to a redirect target", 0, redirectsFollowed)
    }

    @Test
    fun `a server error is retryable, not a refusal`() {
        status = 503

        val outcome = PushRegistrar.post(endpoint, token, cookiePair)

        assertTrue("got $outcome", outcome is PushRegistrar.Outcome.Retryable)
    }

    @Test
    fun `an unreachable CRM is retryable`() {
        val unreachable = endpoint
        server.stop(0)
        running = false

        val outcome = PushRegistrar.post(unreachable, token, cookiePair)

        assertTrue("got $outcome", outcome is PushRegistrar.Outcome.Retryable)
    }

    @Test
    fun `only the session cookie is taken from the jar`() {
        assertEquals(
            cookiePair,
            PushRegistrar.sessionCookiePair("yoko_ui_identity=op_1; $cookiePair; other=1"),
        )
        assertNull(PushRegistrar.sessionCookiePair("yoko_ui_identity=op_1"))
        assertNull(PushRegistrar.sessionCookiePair(null))
        assertNull("an empty value is not a session", PushRegistrar.sessionCookiePair("${PushRegistrar.SESSION_COOKIE_NAME}="))
    }

    @Test
    fun `a token that could not be a P1 token is never sent`() {
        assertEquals(PushRegistrar.Outcome.Refused("INVALID_TOKEN_SHAPE"), PushRegistrar.register("short"))
        assertTrue(recorded.isEmpty())
    }
}
