package ru.yokoone.crm.shell

import android.content.Context
import android.util.Log
import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Diagnostics for test builds.
 *
 * The first attempt at this relied on logcat alone and produced nothing on a
 * Samsung S23 Ultra: the acceptance build was not debuggable, and One UI
 * routinely drops application logs in that state. So every line now goes to two
 * places that fail independently — logcat, and a file inside the app's own
 * storage that `adb` can pull even when logcat shows nothing at all.
 *
 * Everything carries the same tag and the same correlation id, so one filter
 * finds all of it and the server's request log can be matched to the exact run.
 *
 * What is deliberately never recorded: passwords, cookies, tokens, request or
 * response bodies, and message content. URLs are recorded as path plus the
 * NAMES of query parameters, never their values, because a chat identifier is
 * the kind of thing that belongs in a bug report and a message is not.
 */
object ShellDiagnostics {

    /** One tag for everything, so a single logcat filter catches all of it. */
    const val TAG = "YokoShellDiag"

    /** Native proof of life, emitted before any WebView exists. */
    const val NATIVE_MARKER = "YOKO_NATIVE_OK"

    /** Proof that page JavaScript reaches logcat through WebChromeClient. */
    const val JS_MARKER = "YOKO_JS_OK"

    private const val LOG_FILE = "diagnostics.log"
    private const val MAX_FILE_BYTES = 256 * 1024
    private const val MAX_LINE_CHARS = 600

    private val timestamp = SimpleDateFormat("HH:mm:ss.SSS", Locale.US)

    /**
     * Random per app start. It identifies one run across the phone log and the
     * server's request log without saying anything about the device or operator.
     */
    val runId: String = buildString {
        val bytes = java.security.SecureRandom().generateSeed(4)
        for (b in bytes) append(String.format(Locale.US, "%02x", b))
    }

    private var logFile: File? = null

    fun start(context: Context) {
        if (!BuildConfig.CAPTURE_CONSOLE) return
        logFile = File(context.filesDir, LOG_FILE).also { file ->
            // A fresh file per start keeps a report small and unambiguous about
            // which run it describes.
            runCatching { if (file.exists()) file.delete() }
        }
        write(
            "$NATIVE_MARKER build=${BuildConfig.VERSION_NAME} commit=${BuildConfig.GIT_COMMIT} " +
                "origin=${BuildConfig.CRM_ORIGIN} run=$runId",
        )
    }

    /** Record a diagnostic line to logcat and to the pullable file. */
    fun write(line: String) {
        if (!BuildConfig.CAPTURE_CONSOLE) return
        val trimmed = line.take(MAX_LINE_CHARS)
        val stamped = "${timestamp.format(Date())} [$runId] $trimmed"
        Log.e(TAG, trimmed)
        val file = logFile ?: return
        runCatching {
            if (file.length() > MAX_FILE_BYTES) file.delete()
            file.appendText("$stamped\n")
        }
    }

    /**
     * Reduce a URL to something safe to record: origin, path, and the names of
     * any query parameters. Values are dropped because they can carry content.
     */
    fun safeUrl(url: String?): String {
        val raw = url ?: return "(none)"
        val questionMark = raw.indexOf('?')
        if (questionMark < 0) return raw
        val keys = raw.substring(questionMark + 1)
            .split('&')
            .mapNotNull { it.substringBefore('=').ifEmpty { null } }
            .joinToString(",")
        return "${raw.substring(0, questionMark)}?[$keys]"
    }

    /**
     * Script injected before page scripts run.
     *
     * `console.error` alone misses two things that matter here: an uncaught
     * exception whose handler runs before any listener is attached, and a
     * rejected promise, which never reaches the console in some engines. Both
     * are routed through console.error with a prefix so they arrive on the same
     * path as everything else.
     */
    fun errorHookScript(): String = """
        (function () {
          if (window.__yokoDiag) return;
          window.__yokoDiag = true;
          var say = function (kind, message, source, line) {
            try {
              console.error('YOKO_PAGE_ERROR ' + kind + ' | ' + String(message).slice(0, 400) +
                ' | ' + String(source || '').split('/').pop() + ':' + (line || 0));
            } catch (ignored) {}
          };
          window.addEventListener('error', function (event) {
            say('uncaught', event.message || (event.error && event.error.message), event.filename, event.lineno);
          }, true);
          window.addEventListener('unhandledrejection', function (event) {
            var reason = event.reason;
            say('rejection', (reason && (reason.message || reason.digest)) || reason, '', 0);
          });
          console.error('$JS_MARKER run=$runId');
        })();
    """.trimIndent()
}
