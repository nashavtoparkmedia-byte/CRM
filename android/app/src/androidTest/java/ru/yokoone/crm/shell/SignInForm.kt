package ru.yokoone.crm.shell

import android.os.SystemClock
import android.view.View
import android.view.ViewGroup
import android.webkit.WebView
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.runner.lifecycle.ActivityLifecycleMonitorRegistry
import androidx.test.runner.lifecycle.Stage
import org.json.JSONArray
import org.json.JSONObject
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit

/**
 * Fills and submits the CRM's mobile sign-in form through the page's own DOM.
 *
 * The form is uncontrolled and its submit handler builds `FormData` from the
 * form element, so assigning each control's value and pressing the form's own
 * submit button sends exactly what a person's input sends: the same server
 * action, the same `required` validation, the same redirect on success and the
 * same rendered error on a rejection. Only the way the values get into the
 * controls differs.
 *
 * Why not the accessibility tree. On a physical Samsung with a third-party
 * autofill service, the first field the test focused brought up that
 * service's own overlay, which then owned the active window: the operator
 * select disappeared from what UI Automator could see ("0 candidates") and
 * text entered through the IME did not reach the form, so the browser refused
 * to submit with its own "fill in this field". Assigning values from the page
 * focuses nothing, opens no keyboard and gives autofill nothing to offer, and
 * it depends on the form's field names rather than on how one WebView build
 * shapes its accessibility nodes.
 *
 * Instrumentation runs in the app's process, so the WebView is reached
 * directly: no test seam in the app, no change to any build the CRM ships.
 */
internal object SignInForm {

    /** The seeded operator every acceptance sign-in picks, matched against the option text. */
    const val OPERATOR = "Мария"

    private const val POLL_MS = 250L
    private const val SCRIPT_TIMEOUT_MS = 10_000L

    /** Outcomes the caller treats as "not yet": the page or the form is still arriving. */
    private val TRANSIENT = setOf("no-webview", "no-result", "form-missing", "submit-disabled")

    /**
     * Select the operator whose option text contains [operator], fill the
     * credentials, and click submit once. Returns `"submitted"`, or the reason
     * it could not, including the options it found when the operator is absent.
     */
    fun submit(operator: String, user: String, password: String, timeoutMs: Long): String {
        val script = """
            (function (operator, user, password) {
              var select = document.querySelector('form select[name="operatorId"]');
              var login = document.querySelector('form input[name="username"]');
              var secret = document.querySelector('form input[name="password"]');
              if (!select || !login || !secret) return 'form-missing';
              var options = Array.prototype.slice.call(select.options);
              var option = options.filter(function (o) {
                return o.value && o.textContent.indexOf(operator) >= 0;
              })[0];
              if (!option) {
                return 'operator-missing: ' + options.map(function (o) { return o.textContent.trim(); }).join(' | ');
              }
              var button = select.form.querySelector('button[type="submit"]');
              if (!button) return 'submit-missing';
              if (button.disabled) return 'submit-disabled';
              select.value = option.value;
              select.dispatchEvent(new Event('change', { bubbles: true }));
              login.value = user;
              login.dispatchEvent(new Event('input', { bubbles: true }));
              secret.value = password;
              secret.dispatchEvent(new Event('input', { bubbles: true }));
              button.click();
              return 'submitted';
            })(${JSONObject.quote(operator)}, ${JSONObject.quote(user)}, ${JSONObject.quote(password)});
        """.trimIndent()

        val deadline = SystemClock.uptimeMillis() + timeoutMs
        var outcome = "no-result"
        while (SystemClock.uptimeMillis() < deadline) {
            outcome = evaluate(script)
            if (outcome !in TRANSIENT) return outcome
            SystemClock.sleep(POLL_MS)
        }
        return "timed out; last outcome: $outcome"
    }

    /** Run [script] in the resumed activity's WebView and return its result as a plain string. */
    private fun evaluate(script: String): String {
        val instrumentation = InstrumentationRegistry.getInstrumentation()
        val latch = CountDownLatch(1)
        var raw: String? = null
        var found = false
        instrumentation.runOnMainSync {
            val web = ActivityLifecycleMonitorRegistry.getInstance()
                .getActivitiesInStage(Stage.RESUMED)
                .firstNotNullOfOrNull { findWebView(it.window.decorView) }
            if (web != null) {
                found = true
                web.evaluateJavascript(script) { result ->
                    raw = result
                    latch.countDown()
                }
            }
        }
        if (!found) return "no-webview"
        if (!latch.await(SCRIPT_TIMEOUT_MS, TimeUnit.MILLISECONDS)) return "no-result"
        // evaluateJavascript hands back the value JSON-encoded: "\"submitted\"".
        return raw?.let { JSONArray("[$it]").opt(0)?.toString() } ?: "no-result"
    }

    private fun findWebView(view: View): WebView? {
        if (view is WebView) return view
        if (view is ViewGroup) {
            for (index in 0 until view.childCount) {
                findWebView(view.getChildAt(index))?.let { return it }
            }
        }
        return null
    }
}
