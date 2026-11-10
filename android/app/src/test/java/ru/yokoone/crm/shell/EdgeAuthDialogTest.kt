package ru.yokoone.crm.shell

import android.app.Activity
import android.app.AlertDialog
import android.content.DialogInterface
import android.os.Bundle
import android.util.SparseArray
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.RobolectricTestRunner
import org.robolectric.shadows.ShadowLooper

/**
 * The hardened credential dialog (R5.1 §3.6, B2): T39, T40, T41.
 */
@RunWith(RobolectricTestRunner::class)
class EdgeAuthDialogTest {

    private class Recorder : EdgeAuthDialog.Listener {
        var submitted: Pair<String, String>? = null
        var cancelled = 0
        var switched = 0
        override fun onSubmit(username: String, password: CharArray) {
            submitted = username to String(password)
        }
        override fun onCancel() {
            cancelled += 1
        }
        override fun onSwitchOperator() {
            switched += 1
        }
    }

    private fun activity(): Pair<org.robolectric.android.controller.ActivityController<Activity>, Activity> {
        val controller = Robolectric.buildActivity(Activity::class.java).setup()
        return controller to controller.get()
    }

    private fun secure(flags: Int) = flags and WindowManager.LayoutParams.FLAG_SECURE != 0

    @Test
    fun `T39 a plain AlertDialog with hardened fields and FLAG_SECURE while shown`() {
        val (_, activity) = activity()
        val dialog = EdgeAuthDialog(activity)
        dialog.show(wrongPassword = false, pinnedUsername = null, listener = Recorder())

        val shown = dialog.dialogForTest()!!
        assertTrue("a plain android.app.AlertDialog, never a DialogFragment", shown.javaClass == AlertDialog::class.java)
        assertTrue(shown.isShowing)
        val login = dialog.loginFieldForTest()!!
        val password = dialog.passwordFieldForTest()!!
        for (field in listOf(login, password)) {
            assertFalse(field.isSaveEnabled)
            assertTrue(field.imeOptions and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING != 0)
        }
        assertEquals(View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS, dialog.containerForTest()!!.importantForAutofill)
        assertTrue("dialog window secure", secure(shown.window!!.attributes.flags))
        assertTrue("activity window secure while shown", secure(activity.window.attributes.flags))

        dialog.dismissAndClear()
        assertFalse("activity window released after dismiss", secure(activity.window.attributes.flags))
    }

    @Test
    fun `T40 dismissAndClear empties both fields and closes the dialog`() {
        val (_, activity) = activity()
        val dialog = EdgeAuthDialog(activity)
        dialog.show(false, null, Recorder())
        val login = dialog.loginFieldForTest()!!
        val password = dialog.passwordFieldForTest()!!
        login.setText("staff.a")
        password.setText("typed-secret")

        val shown = dialog.dialogForTest()!!
        dialog.dismissAndClear()

        assertEquals("", login.text.toString())
        assertEquals("", password.text.toString())
        assertFalse(shown.isShowing)
        assertNull(dialog.dialogForTest())
    }

    @Test
    fun `T41 saved state carries neither field text nor the dialog`() {
        val (controller, activity) = activity()
        val dialog = EdgeAuthDialog(activity)
        dialog.show(false, null, Recorder())
        dialog.loginFieldForTest()!!.setText("staff.a")
        dialog.passwordFieldForTest()!!.setText("typed-secret")

        val outState = Bundle()
        controller.saveInstanceState(outState)

        val dump = StringBuilder()
        fun walk(value: Any?) {
            when (value) {
                is Bundle -> value.keySet().forEach { walk(value.get(it)) }
                is SparseArray<*> -> for (i in 0 until value.size()) walk(value.valueAt(i))
                else -> dump.append(value.toString()).append('\n')
            }
        }
        walk(outState)
        assertFalse(dump.contains("typed-secret"))
        assertFalse(dump.contains("staff.a"))
        dialog.dismissAndClear()
    }

    @Test
    fun `submit hands the values over once and clears the fields`() {
        val (_, activity) = activity()
        val recorder = Recorder()
        val dialog = EdgeAuthDialog(activity)
        dialog.show(false, null, recorder)
        // The show listener (which installs the validating «Войти») runs on the looper.
        ShadowLooper.idleMainLooper()
        val login = dialog.loginFieldForTest()!!
        val password = dialog.passwordFieldForTest()!!
        login.setText("staff.a")
        password.setText("typed-secret")

        dialog.dialogForTest()!!.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        ShadowLooper.idleMainLooper()

        assertEquals("staff.a" to "typed-secret", recorder.submitted)
        assertEquals("", password.text.toString())
        assertFalse(secure(activity.window.attributes.flags))
    }

    @Test
    fun `pinned mode shows the username read-only and offers the operator switch`() {
        val (_, activity) = activity()
        val recorder = Recorder()
        val dialog = EdgeAuthDialog(activity)
        dialog.show(wrongPassword = true, pinnedUsername = "staff.a", listener = recorder)
        ShadowLooper.idleMainLooper()

        assertNull("no editable login in pinned mode", dialog.loginFieldForTest())
        val shown = dialog.dialogForTest()!!
        assertNotNull(shown.getButton(DialogInterface.BUTTON_NEUTRAL))
        dialog.passwordFieldForTest()!!.setText("again")
        shown.getButton(DialogInterface.BUTTON_POSITIVE).performClick()
        ShadowLooper.idleMainLooper()
        assertEquals("staff.a" to "again", recorder.submitted)

        dialog.show(true, "staff.a", recorder)
        ShadowLooper.idleMainLooper()
        dialog.dialogForTest()!!.getButton(DialogInterface.BUTTON_NEUTRAL).performClick()
        ShadowLooper.idleMainLooper()
        assertEquals(1, recorder.switched)
    }
}
