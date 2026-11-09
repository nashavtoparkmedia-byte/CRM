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
import ru.yokoone.crm.shell.ContinuityGuard.EdgeGate
import ru.yokoone.crm.shell.EdgeContextReset.Reason
import java.net.InetAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.concurrent.TimeUnit

/**
 * Reset logout: which resets send it, and what goes on the wire, against a
 * real loopback server (the same approach as PushRegistrarTest).
 */
@RunWith(RobolectricTestRunner::class)
class ResetLogoutTest {

    private data class Recorded(
        val method: String,
        val target: String,
        val contentType: String?,
        val cookie: String?,
        val authorization: String?,
        val body: String,
    )

    private lateinit var server: StubCrm

    private val cookiePair = "yoko_mobile_session=s3ss10nvalue"
    private val basic = "Basic dXNlcjpwYXNz"

    private val endpoint: String
        get() = "http://127.0.0.1:${server.port}/api/mobile/session/logout"

    @Before
    fun startServer() {
        server = StubCrm().apply { start() }
    }

    @After
    fun stopServer() {
        server.stop()
    }

    // ── which resets log out ─────────────────────────────────────────────

    private val pinned = "https://yokoone.ru/api/mobile/session/logout"

    /** The reason/gate rules, independent of the variant's compile-time origin. */
    private fun plan(reason: String, cookie: String?, authorization: String?, gate: EdgeGate) =
        ResetLogout.plan(reason, cookie, authorization, gate, endpoint = pinned) { true }

    @Test
    fun `an operator switch with a session and an accepted credential sends both`() {
        assertEquals(
            ResetLogout.Plan.Send(pinned, cookiePair, basic),
            plan(Reason.OPERATOR_SWITCH, cookiePair, basic, EdgeGate.PRESENT),
        )
    }

    @Test
    fun `without an edge gate the logout goes without a header`() {
        for (gate in listOf(EdgeGate.ABSENT, EdgeGate.UNKNOWN)) {
            assertEquals(
                ResetLogout.Plan.Send(pinned, cookiePair, null),
                plan(Reason.OPERATOR_SWITCH, cookiePair, null, gate),
            )
        }
    }

    @Test
    fun `with the edge gate known and no usable credential nothing is sent`() {
        // EDGE_MAX_AGE always lands here: an expired credential gives no header.
        for (reason in listOf(Reason.OPERATOR_SWITCH, Reason.EDGE_MAX_AGE)) {
            assertEquals(
                ResetLogout.Plan.Skip("edge-credential-absent"),
                plan(reason, cookiePair, null, EdgeGate.PRESENT),
            )
        }
    }

    @Test
    fun `an edge max age reset still logs out where there is no edge gate`() {
        assertEquals(
            ResetLogout.Plan.Send(pinned, cookiePair, null),
            plan(Reason.EDGE_MAX_AGE, cookiePair, null, EdgeGate.ABSENT),
        )
    }

    @Test
    fun `no session cookie, nothing to log out`() {
        assertEquals(
            ResetLogout.Plan.Skip("no-session"),
            plan(Reason.OPERATOR_SWITCH, null, basic, EdgeGate.PRESENT),
        )
    }

    @Test
    fun `an ended session and a refused credential are never sent`() {
        assertEquals(
            ResetLogout.Plan.Skip("session-ended"),
            plan(Reason.SESSION_ENDED, cookiePair, basic, EdgeGate.PRESENT),
        )
        assertEquals(
            ResetLogout.Plan.Skip("edge-refused"),
            plan(Reason.EDGE_CREDENTIAL_REFUSED, cookiePair, basic, EdgeGate.PRESENT),
        )
    }

    @Test
    fun `Q2 a mismatch decided under an accepted credential logs the old session out`() {
        // The probe or rule G decided it: the credential is accepted and still held.
        assertEquals(
            ResetLogout.Plan.Send(pinned, cookiePair, basic),
            plan(Reason.CONTINUITY_MISMATCH, cookiePair, basic, EdgeGate.PRESENT),
        )
    }

    @Test
    fun `Q2 a precheck mismatch never puts the old cookie on a request`() {
        // Before any credential: no header, whatever the gate says.
        for (gate in EdgeGate.values()) {
            assertEquals(
                ResetLogout.Plan.Skip("continuity"),
                plan(Reason.CONTINUITY_MISMATCH, cookiePair, null, gate),
            )
        }
    }

    @Test
    fun `C1 nothing is sent to an endpoint that is not the pinned https one`() {
        for (endpoint in listOf(
            "http://yokoone.ru/api/mobile/session/logout",
            "http://10.0.2.2:3002/api/mobile/session/logout",
            "http://127.0.0.1:9/api/mobile/session/logout",
            "https://elsewhere.example/api/mobile/session/logout",
        )) {
            for (reason in listOf(Reason.OPERATOR_SWITCH, Reason.CONTINUITY_MISMATCH)) {
                assertEquals(
                    "$endpoint $reason",
                    ResetLogout.Plan.Skip("endpoint"),
                    ResetLogout.plan(reason, cookiePair, basic, EdgeGate.PRESENT, endpoint = endpoint),
                )
            }
        }
    }

    @Test
    fun `C1 the build's own endpoint carries the session in both variants`() {
        // Release: the pinned https endpoint. Acceptance: its loopback origin (B1).
        assertTrue(ResetLogout.allowsSessionTo(ResetLogout.endpoint()))
        assertEquals(
            ResetLogout.Plan.Send(ResetLogout.endpoint(), cookiePair, null),
            ResetLogout.plan(Reason.OPERATOR_SWITCH, cookiePair, null, EdgeGate.ABSENT),
        )
    }

    private val loopbackOrigin = "http://127.0.0.1:3002"
    private val loopbackEndpoint = "$loopbackOrigin/api/mobile/session/logout"

    @Test
    fun `B3 a release build never sends the session to a loopback origin`() {
        assertFalse(ResetLogout.allowsSessionTo(loopbackEndpoint, isTestBuild = false, origin = loopbackOrigin))
        if (!BuildConfig.IS_TEST_BUILD) {
            assertFalse(ResetLogout.allowsSessionTo(loopbackEndpoint))
        }
    }

    @Test
    fun `B1 a test build sends it only to exactly its own endpoint on 127_0_0_1`() {
        assertTrue(ResetLogout.allowsSessionTo(loopbackEndpoint, isTestBuild = true, origin = loopbackOrigin))
        for ((endpoint, origin) in listOf(
            // not the compile-time endpoint
            "http://127.0.0.1:3003/api/mobile/session/logout" to loopbackOrigin,
            "$loopbackOrigin/api/mobile/push-registration" to loopbackOrigin,
            // the emulator's host address is not loopback
            "http://10.0.2.2:3002/api/mobile/session/logout" to "http://10.0.2.2:3002",
            // any other http host, and names that are not the literal address
            "http://crm.local:3002/api/mobile/session/logout" to "http://crm.local:3002",
            "http://localhost:3002/api/mobile/session/logout" to "http://localhost:3002",
            // https to loopback is not the pinned endpoint either
            "https://127.0.0.1:3002/api/mobile/session/logout" to "https://127.0.0.1:3002",
        )) {
            assertFalse(endpoint, ResetLogout.allowsSessionTo(endpoint, isTestBuild = true, origin = origin))
        }
    }

    @Test
    fun `the endpoint is the compile-time path on the pinned origin`() {
        assertEquals(CrmOrigin.ORIGIN + "/api/mobile/session/logout", ResetLogout.endpoint())
    }

    // ── the wire ─────────────────────────────────────────────────────────

    @Test
    fun `a logout is exactly one JSON POST carrying the session cookie`() {
        server.status = 204

        assertEquals(ResetLogout.Outcome.LOGGED_OUT, ResetLogout.post(endpoint, cookiePair))

        val request = server.requests().single()
        assertEquals("POST", request.method)
        assertEquals("/api/mobile/session/logout", request.target)
        assertEquals("application/json", request.contentType)
        assertEquals(cookiePair, request.cookie)
        assertNull(request.authorization)
        assertEquals("{}", request.body)
    }

    @Test
    fun `a failed barrier write is told apart from a logout`() {
        server.status = 503

        assertEquals(ResetLogout.Outcome.BARRIER_FAILED, ResetLogout.post(endpoint, cookiePair))
    }

    @Test
    fun `a redirect is never followed`() {
        server.status = 302
        server.location = "/elsewhere"

        assertEquals(ResetLogout.Outcome.UNEXPECTED_REDIRECT, ResetLogout.post(endpoint, cookiePair))
        assertEquals("the session cookie must not be replayed to a redirect target", 1, server.requests().size)
    }

    @Test
    fun `an nginx 401 is an edge refusal, any other answer a failure`() {
        server.status = 401
        server.wwwAuthenticate = "Basic realm=\"YOKO CRM\""
        assertEquals(ResetLogout.Outcome.EDGE_REFUSED, ResetLogout.post(endpoint, cookiePair, basic) { true })

        server.wwwAuthenticate = null
        for (status in listOf(200, 401, 404, 500)) {
            server.status = status
            assertEquals("status $status", ResetLogout.Outcome.FAILED, ResetLogout.post(endpoint, cookiePair))
        }
    }

    // ── the identity_access response matrix (PR #216) ─────────────────────

    @Test
    fun `matrix 204 for a live session clears both cookies and is a logout`() {
        server.status = 204
        server.headers = listOf(
            "Cache-Control: no-store",
            "Set-Cookie: yoko_mobile_session=; Path=/; Max-Age=0; HttpOnly; SameSite=lax",
            "Set-Cookie: crm_user_id=; Path=/; Max-Age=0; SameSite=lax",
        )

        assertEquals(ResetLogout.Outcome.LOGGED_OUT, ResetLogout.post(endpoint, cookiePair))
        assertEquals(1, server.requests().size)
    }

    @Test
    fun `matrix 204 with nothing to end tells the reset nothing more`() {
        server.status = 204
        server.headers = listOf("Cache-Control: no-store")

        assertEquals(ResetLogout.Outcome.LOGGED_OUT, ResetLogout.post(endpoint, cookiePair))
    }

    @Test
    fun `matrix 503 is a barrier failure, answered once and never retried`() {
        server.status = 503
        server.headers = listOf("Cache-Control: no-store", "Retry-After: 5", "Content-Type: application/json")
        server.body = """{"error":"MOBILE_SESSION_LOGOUT_UNAVAILABLE"}"""

        assertEquals(ResetLogout.Outcome.BARRIER_FAILED, ResetLogout.post(endpoint, cookiePair))
        assertEquals("Retry-After must not turn the one request into two", 1, server.requests().size)
    }

    @Test
    fun `matrix 415 and 405 are failures the shell never causes`() {
        server.headers = listOf("Cache-Control: no-store", "Content-Type: application/json")
        server.status = 415
        server.body = """{"error":"JSON_REQUIRED"}"""
        assertEquals(ResetLogout.Outcome.FAILED, ResetLogout.post(endpoint, cookiePair))

        server.status = 405
        server.body = ""
        assertEquals(ResetLogout.Outcome.FAILED, ResetLogout.post(endpoint, cookiePair))

        // The two cannot come from this request: it is a POST, and JSON.
        server.requests().forEach {
            assertEquals("POST", it.method)
            assertEquals("application/json", it.contentType)
        }
    }

    @Test
    fun `matrix 308 trailing slash normalisation is a redirect, never followed`() {
        server.status = 308
        server.location = "/api/mobile/session/logout"

        assertEquals(ResetLogout.Outcome.UNEXPECTED_REDIRECT, ResetLogout.post("$endpoint/", cookiePair))
        assertEquals(1, server.requests().size)
        assertEquals("/api/mobile/session/logout/", server.requests().single().target)
    }

    @Test
    fun `the edge header goes only where it may`() {
        server.status = 204

        ResetLogout.post(endpoint, cookiePair, basic) { true }
        assertEquals(basic, server.requests().last().authorization)

        // Default rule: https on exactly the pinned host. The loopback stub is neither.
        ResetLogout.post(endpoint, cookiePair, basic)
        assertNull(server.requests().last().authorization)
    }

    @Test
    fun `an unreachable CRM is a failure, not an exception`() {
        val unreachable = endpoint
        server.stop()

        assertEquals(ResetLogout.Outcome.FAILED, ResetLogout.post(unreachable, cookiePair))
    }

    @Test
    fun `a CRM that never answers is given up on within the timeout`() {
        server.silent = true
        val started = System.nanoTime()

        val outcome = ResetLogout.post(endpoint, cookiePair, connectTimeoutMs = 500, readTimeoutMs = 500)

        val elapsedMs = TimeUnit.NANOSECONDS.toMillis(System.nanoTime() - started)
        assertEquals(ResetLogout.Outcome.FAILED, outcome)
        assertTrue("took $elapsedMs ms", elapsedMs < 2_500)
    }

    @Test
    fun `the logout never goes through a configured JVM proxy`() {
        val proxy = StubCrm().apply { start() }
        val saved = listOf("http.proxyHost", "http.proxyPort", "https.proxyHost", "https.proxyPort", "http.nonProxyHosts")
            .associateWith { System.getProperty(it) }
        try {
            System.setProperty("http.proxyHost", "127.0.0.1")
            System.setProperty("http.proxyPort", proxy.port.toString())
            System.setProperty("https.proxyHost", "127.0.0.1")
            System.setProperty("https.proxyPort", proxy.port.toString())
            System.setProperty("http.nonProxyHosts", "")
            server.status = 204

            ResetLogout.post(endpoint, cookiePair, basic) { true }

            assertEquals("the proxy must receive zero connections", 0, proxy.requests().size)
            assertEquals(1, server.requests().size)
        } finally {
            for ((key, value) in saved) if (value == null) System.clearProperty(key) else System.setProperty(key, value)
            proxy.stop()
        }
    }

    // ── start(): the reset's handle ──────────────────────────────────────

    @Test
    fun `a skipped plan opens the latch at once and sends nothing`() {
        val done = ResetLogout.start(ResetLogout.Plan.Skip("no-session"))

        assertEquals(0L, done.count)
        assertTrue(server.requests().isEmpty())
    }

    @Test
    fun `a sent plan is exactly one request, to the planned endpoint, and opens the latch on the answer`() {
        server.status = 204

        val done = ResetLogout.start(ResetLogout.Plan.Send(endpoint, cookiePair, null))

        assertTrue(done.await(ResetLogout.WAIT_MS, TimeUnit.MILLISECONDS))
        val request = server.requests().single()
        assertEquals("/api/mobile/session/logout", request.target)
        assertEquals(cookiePair, request.cookie)
    }

    @Test
    fun `B2 the edge header never goes to loopback, only the session cookie does`() {
        server.status = 204

        val done = ResetLogout.start(ResetLogout.Plan.Send(endpoint, cookiePair, basic))

        assertTrue(done.await(ResetLogout.WAIT_MS, TimeUnit.MILLISECONDS))
        val request = server.requests().single()
        assertNull(request.authorization)
        assertEquals(cookiePair, request.cookie)
    }

    /** A single-connection HTTP/1.1 responder, closed after every answer. */
    private class StubCrm {

        private val socket = ServerSocket(0, 0, InetAddress.getLoopbackAddress())
        private val recorded = mutableListOf<Recorded>()
        private val worker = Thread { accept() }

        @Volatile var status: Int = 204
        @Volatile var location: String? = null
        @Volatile var wwwAuthenticate: String? = null

        /** Further response header lines, verbatim, and a response body. */
        @Volatile var headers: List<String> = emptyList()
        @Volatile var body: String = ""

        /** Read the request, then never answer. */
        @Volatile var silent: Boolean = false

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

            if (silent) {
                Thread.sleep(5_000)
                return
            }

            val response = StringBuilder("HTTP/1.1 $status STUB\r\n")
            location?.let { response.append("Location: $it\r\n") }
            wwwAuthenticate?.let { response.append("WWW-Authenticate: $it\r\n") }
            headers.forEach { response.append(it).append("\r\n") }
            val content = body.toByteArray(Charsets.UTF_8)
            response.append("Content-Length: ${content.size}\r\n")
            response.append("Connection: close\r\n\r\n")

            connection.getOutputStream().apply {
                write(response.toString().toByteArray(Charsets.US_ASCII))
                write(content)
                flush()
            }
        }
    }
}
