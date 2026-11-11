package ru.yokoone.crm.shell

import android.view.LayoutInflater
import android.view.View
import android.webkit.WebView
import androidx.test.core.app.ApplicationProvider
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner

/**
 * System autofill stays out of the CRM (Security ruling (a), personal mobile
 * sign-in, docs/mobile/ANDROID_PERSONAL_SIGNIN.md).
 *
 * The employee types their own Staff Session password into the CRM page inside
 * the WebView. A password manager that offered to keep it would keep it on the
 * device, often synced to an account the next person on a shared phone also
 * uses. The shell's one WebView comes from this layout, in every build type, so
 * the layout is where the rule is pinned. Removing the attribute fails here.
 */
@RunWith(RobolectricTestRunner::class)
class ShellAutofillPolicyTest {

    private fun inflatedWebView(): WebView {
        val root = LayoutInflater.from(ApplicationProvider.getApplicationContext())
            .inflate(R.layout.activity_main, null)
        val web = root.findViewById<View>(R.id.web_view)
        assertTrue("the shell layout has no WebView at web_view", web is WebView)
        return web as WebView
    }

    @Test
    fun `the shell WebView and everything inside it is excluded from autofill`() {
        assertEquals(
            View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS,
            inflatedWebView().importantForAutofill,
        )
    }
}
