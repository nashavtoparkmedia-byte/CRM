package ru.yokoone.crm.shell.push

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket

/**
 * The one request the shell makes, driven against a real loopback server.
 *
 * A mocked HTTP client would prove the code calls something; this proves what
 * actually goes on the wire and what is done with each answer P1 can give. The
 * redirect case is the one with a security edge: following a 302 would put the
 * session cookie on a URL the shell never chose, so the assertion is both that
 * the outcome is a refusal and that nothing further was ever requested.
 *
 * The server is hand-rolled on a ServerSocket rather than com.sun.net.httpserver,
 * which is absent from the Android unit-test compile classpath.
 */
@RunWith(RobolectricTestRunner::class)
class PushRegistrarTest {

    private data class Recorded(
        val method: String,
        val target: String,
        val contentType: String?,
        val cookie: String?,
        val body: String,
    )

    private lateinit var server: StubCrm

    private val token = "fcm-token-0123456789abcdef"
    private val cookiePair = "${PushRegistrar.SESSION_COOKIE_NAME}=s3ss10nvalue"

    private val endpoint: String
        get() = "http://127.0.0.1:${server.port}/api/mobile/push-registration"

    @Before
    fun startServer() {
        server = StubCrm().apply { start() }
    }

    @After
    fun stopServer() {
        server.stop()
    }

    @Test
    fun `an accepted registration is exactly one POST carrying the session cookie`() {
        server.status = 200

        assertEquals(PushRegistrar.Outcome.Registered, PushRegistrar.post(endpoint, token, cookiePair))

        val request = server.requests().single()
        assertEquals("POST", request.method)
        assertEquals("/api/mobile/push-registration", request.target)
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
            server.status = case.first
            server.body = """{"error":"${case.second}"}"""

            assertEquals(
                PushRegistrar.Outcome.Refused(case.second),
                PushRegistrar.post(endpoint, token, cookiePair),
            )
        }
    }

    @Test
    fun `a refusal with no readable body still refuses rather than retrying`() {
        server.status = 401
        server.body = ""

        assertEquals(PushRegistrar.Outcome.Refused("HTTP_401"), PushRegistrar.post(endpoint, token, cookiePair))
    }

    @Test
    fun `a redirect is refused and never followed`() {
        server.status = 302
        server.location = "/elsewhere"

        assertEquals(
            PushRegistrar.Outcome.Refused("UNEXPECTED_REDIRECT"),
            PushRegistrar.post(endpoint, token, cookiePair),
        )
        assertEquals(
            "the session cookie must not be replayed to a redirect target",
            1,
            server.requests().size,
        )
    }

    @Test
    fun `a server error is retryable, not a refusal`() {
        server.status = 503

        val outcome = PushRegistrar.post(endpoint, token, cookiePair)

        assertTrue("got $outcome", outcome is PushRegistrar.Outcome.Retryable)
    }

    @Test
    fun `an unreachable CRM is retryable`() {
        val unreachable = endpoint
        server.stop()

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
        assertTrue(server.requests().isEmpty())
    }

    /**
     * A single-connection HTTP/1.1 responder, closed after every answer.
     *
     * It exists to be honest about the wire: the assertions above read the
     * method, the target, the two headers that matter and the exact body the
     * registrar produced, none of which a stubbed client would prove.
     */
    private class StubCrm {

        private val socket = ServerSocket(0, 0, InetAddress.getLoopbackAddress())
        private val recorded = mutableListOf<Recorded>()
        private val worker = Thread { accept() }

        @Volatile var status: Int = 200
        @Volatile var body: String = ""
        @Volatile var location: String? = null

        val port: Int get() = socket.localPort

        fun start() {
            worker.isDaemon = true
            worker.start()
        }

        fun stop() {
            runCatching { socket.close() }
        }

        fun requests(): List<Recorded> = synchronized(recorded) { recorded.toList() }

        private fun accept() {
            while (!socket.isClosed) {
                val connection = runCatching { socket.accept() }.getOrNull() ?: return
                connection.use { runCatching { handle(it) } }
            }
        }

        private fun handle(connection: Socket) {
            val input = connection.getInputStream()

            val head = StringBuilder()
            while (!head.endsWith("\r\n\r\n")) {
                val next = input.read()
                if (next < 0) return
                head.append(next.toChar())
            }

            val lines = head.toString().trimEnd().split("\r\n")
            val requestLine = lines.first().split(" ")
            val headers = lines.drop(1)
                .filter { it.contains(':') }
                .associate { it.substringBefore(':').trim().lowercase() to it.substringAfter(':').trim() }

            val length = headers["content-length"]?.toIntOrNull() ?: 0
            val payload = ByteArray(length)
            var read = 0
            while (read < length) {
                val count = input.read(payload, read, length - read)
                if (count < 0) break
                read += count
            }

            synchronized(recorded) {
                recorded += Recorded(
                    method = requestLine.getOrElse(0) { "" },
                    target = requestLine.getOrElse(1) { "" },
                    contentType = headers["content-type"],
                    cookie = headers["cookie"],
                    body = String(payload, Charsets.UTF_8),
                )
            }

            val answer = body.toByteArray(Charsets.UTF_8)
            val response = StringBuilder("HTTP/1.1 $status STUB\r\n")
            location?.let { response.append("Location: $it\r\n") }
            response.append("Content-Type: application/json\r\n")
            response.append("Content-Length: ${answer.size}\r\n")
            response.append("Connection: close\r\n\r\n")

            connection.getOutputStream().apply {
                write(response.toString().toByteArray(Charsets.US_ASCII))
                write(answer)
                flush()
            }
        }
    }
}
