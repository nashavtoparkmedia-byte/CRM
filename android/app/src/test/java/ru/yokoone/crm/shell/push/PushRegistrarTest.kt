package ru.yokoone.crm.shell.push

import android.content.Context
import androidx.test.core.app.ApplicationProvider
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
        val authorization: String?,
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
        val context: Context = ApplicationProvider.getApplicationContext()
        assertEquals(PushRegistrar.Outcome.Refused("INVALID_TOKEN_SHAPE"), PushRegistrar.register(context, "short"))
        assertTrue(server.requests().isEmpty())
    }

    // ── edge Basic auth, Variant A (R5.1 §4.1; T5–T7, T50) ───────────────

    private val basic = "Basic dXNlcjpwYXNz"

    @Test
    fun `T5 a present edge header is sent exactly once, on the one POST, with the cookie`() {
        server.status = 200

        assertEquals(
            PushRegistrar.Outcome.Registered,
            PushRegistrar.post(endpoint, token, cookiePair, basic) { true },
        )

        val request = server.requests().single()
        assertEquals(basic, request.authorization)
        assertEquals(cookiePair, request.cookie)
    }

    @Test
    fun `T5 without a header none is sent`() {
        server.status = 200

        PushRegistrar.post(endpoint, token, cookiePair, null) { true }

        assertNull(server.requests().single().authorization)
    }

    @Test
    fun `T6 an nginx 401 without a header defers as EDGE_AUTH_REQUIRED`() {
        server.status = 401
        server.wwwAuthenticate = "Basic realm=\"YOKO CRM\""

        assertEquals(
            PushRegistrar.Outcome.Deferred(PushRegistrar.EDGE_AUTH_REQUIRED),
            PushRegistrar.post(endpoint, token, cookiePair, null) { true },
        )
        assertEquals(1, server.requests().size)
    }

    @Test
    fun `T6 an nginx 401 after a header defers as EDGE_AUTH_REFUSED`() {
        server.status = 401
        server.wwwAuthenticate = "Basic realm=\"YOKO CRM\""

        assertEquals(
            PushRegistrar.Outcome.Deferred(PushRegistrar.EDGE_AUTH_REFUSED),
            PushRegistrar.post(endpoint, token, cookiePair, basic) { true },
        )
        assertEquals(1, server.requests().size)
    }

    @Test
    fun `T6 a CRM 401 without WWW-Authenticate is still the named refusal`() {
        server.status = 401
        server.body = """{"error":"MOBILE_SESSION_REQUIRED"}"""

        assertEquals(
            PushRegistrar.Outcome.Refused("MOBILE_SESSION_REQUIRED"),
            PushRegistrar.post(endpoint, token, cookiePair, basic) { true },
        )
    }

    @Test
    fun `T7 the header is never attached to an endpoint that is not the pinned https origin`() {
        server.status = 200

        // Default rule: https on exactly the pinned host. The loopback stub is neither.
        PushRegistrar.post(endpoint, token, cookiePair, basic)

        assertNull(server.requests().single().authorization)
    }

    @Test
    fun `T10 T52 with the gate known and no usable credential, nothing is sent and nothing is blocked`() {
        val context: Context = ApplicationProvider.getApplicationContext()
        android.webkit.CookieManager.getInstance().setCookie(ru.yokoone.crm.shell.CrmOrigin.ORIGIN, cookiePair)
        PushTokenState.setEdgeGate(context, ru.yokoone.crm.shell.ContinuityGuard.EdgeGate.PRESENT)
        ru.yokoone.crm.shell.EdgeCredentialHolder.resetForTest()
        ru.yokoone.crm.shell.ShellForeground.started = false
        try {
            assertEquals(PushRegistrar.Outcome.Deferred("EDGE_CREDENTIAL_ABSENT"), PushRegistrar.register(context, token))
            assertTrue("no request at all", server.requests().isEmpty())
            assertNull(PushTokenState.snapshot(context).blockedReason)
        } finally {
            PushTokenState.setEdgeGate(context, ru.yokoone.crm.shell.ContinuityGuard.EdgeGate.UNKNOWN)
            android.webkit.CookieManager.getInstance().removeAllCookies(null)
        }
    }

    @Test
    fun `T50 the registrar never goes through a configured JVM proxy`() {
        val proxy = StubCrm().apply { start() }
        val saved = listOf("http.proxyHost", "http.proxyPort", "https.proxyHost", "https.proxyPort", "http.nonProxyHosts")
            .associateWith { System.getProperty(it) }
        try {
            System.setProperty("http.proxyHost", "127.0.0.1")
            System.setProperty("http.proxyPort", proxy.port.toString())
            System.setProperty("https.proxyHost", "127.0.0.1")
            System.setProperty("https.proxyPort", proxy.port.toString())
            // Loopback is exempt by default; make the proxy apply to it too.
            System.setProperty("http.nonProxyHosts", "")
            server.status = 200

            PushRegistrar.post(endpoint, token, cookiePair, basic) { true }

            assertEquals("the proxy must receive zero connections", 0, proxy.requests().size)
            assertEquals("the header reaches the origin only", basic, server.requests().single().authorization)
        } finally {
            for ((key, value) in saved) if (value == null) System.clearProperty(key) else System.setProperty(key, value)
            proxy.stop()
        }
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
        @Volatile var wwwAuthenticate: String? = null

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
                    authorization = headers["authorization"],
                    body = String(payload, Charsets.UTF_8),
                )
            }

            val answer = body.toByteArray(Charsets.UTF_8)
            val response = StringBuilder("HTTP/1.1 $status STUB\r\n")
            location?.let { response.append("Location: $it\r\n") }
            wwwAuthenticate?.let { response.append("WWW-Authenticate: $it\r\n") }
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
