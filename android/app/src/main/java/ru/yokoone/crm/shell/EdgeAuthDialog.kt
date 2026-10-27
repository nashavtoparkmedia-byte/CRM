package ru.yokoone.crm.shell

import android.app.Activity
import android.app.AlertDialog
import android.content.DialogInterface
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import androidx.annotation.VisibleForTesting

/**
 * The hardened staff credential dialog (R5.1 §3.6, B2).
 *
 * A plain `android.app.AlertDialog` built in code — never a DialogFragment,
 * never a managed dialog, never an Activity — so nothing about it enters the
 * activity's saved state. Both fields refuse view-state saving, personalised
 * IME learning and autofill; the dialog window and, while it is visible, the
 * activity window are FLAG_SECURE. Typed values leave the fields once, into
 * [EdgeCredentialHolder], and the fields are cleared at once.
 *
 * Pinned-username mode (F-2): once a proceed() happened in this process the
 * login is a read-only label with the pinned username; a different login is
 * possible only through «Выйти и сменить сотрудника» (a reset).
 */
class EdgeAuthDialog(private val activity: Activity) {

    interface Listener {
        fun onSubmit(username: String, password: CharArray)
        fun onCancel()
        fun onSwitchOperator()
    }

    private var dialog: AlertDialog? = null
    private var loginField: EditText? = null
    private var passwordField: EditText? = null
    private var container: LinearLayout? = null

    val isShowing: Boolean get() = dialog?.isShowing == true

    fun show(wrongPassword: Boolean, pinnedUsername: String?, listener: Listener) {
        dismissAndClear()
        val density = activity.resources.displayMetrics.density
        val pad = (20 * density).toInt()

        val box = LinearLayout(activity).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(pad, pad / 2, pad, 0)
            importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
            isSaveEnabled = false
        }
        box.addView(TextView(activity).apply {
            text = activity.getString(R.string.edge_dialog_target, EdgeAuthPolicy.EDGE_REALM, EdgeAuthPolicy.PINNED_HOST)
        })
        if (wrongPassword) {
            box.addView(TextView(activity).apply {
                text = activity.getString(R.string.edge_dialog_wrong_password)
                setTextColor(0xFFDC2626.toInt())
            })
        }

        val login = if (pinnedUsername == null) {
            EditText(activity).apply {
                hint = activity.getString(R.string.edge_dialog_login)
                inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                hardenField(this)
            }.also {
                loginField = it
                box.addView(it)
            }
            loginField
        } else {
            box.addView(TextView(activity).apply {
                // The operator's own login, typed in this process; not restored from storage.
                text = activity.getString(R.string.edge_dialog_pinned, pinnedUsername)
                isFocusable = false
                isSaveEnabled = false
            })
            null
        }

        val password = EditText(activity).apply {
            hint = activity.getString(R.string.edge_dialog_password)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            hardenField(this)
        }
        passwordField = password
        box.addView(password)
        container = box

        val builder = AlertDialog.Builder(activity)
            .setTitle(R.string.edge_dialog_title)
            .setView(box)
            .setPositiveButton(R.string.edge_login, null)
            .setNegativeButton(R.string.edge_cancel) { _, _ ->
                clearFields()
                restoreActivityWindow()
                listener.onCancel()
            }
        if (pinnedUsername != null) {
            builder.setNeutralButton(R.string.edge_switch_operator) { _, _ ->
                clearFields()
                restoreActivityWindow()
                listener.onSwitchOperator()
            }
        }
        val created = builder.create()
        created.setCanceledOnTouchOutside(false)
        created.setOnCancelListener {
            clearFields()
            restoreActivityWindow()
            listener.onCancel()
        }
        created.setOnShowListener {
            created.getButton(DialogInterface.BUTTON_POSITIVE).setOnClickListener {
                val user = pinnedUsername ?: login?.text?.toString()?.trim().orEmpty()
                val typed = password.text
                if (user.isEmpty() || typed.isNullOrEmpty()) return@setOnClickListener
                val chars = CharArray(typed.length)
                typed.getChars(0, typed.length, chars, 0)
                clearFields()
                restoreActivityWindow()
                created.setOnCancelListener(null)
                created.dismiss()
                dialog = null
                listener.onSubmit(user, chars)
            }
        }
        created.window?.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        activity.window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        dialog = created
        created.show()
    }

    /** onPause, reset, or a new dialog: dismiss, clear both fields, drop FLAG_SECURE from the activity. */
    fun dismissAndClear() {
        clearFields()
        dialog?.setOnCancelListener(null)
        dialog?.dismiss()
        dialog = null
        loginField = null
        passwordField = null
        container = null
        restoreActivityWindow()
    }

    private fun hardenField(field: EditText) {
        field.isSaveEnabled = false
        field.imeOptions = field.imeOptions or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        field.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
        field.isSingleLine = true
    }

    private fun clearFields() {
        loginField?.text?.clear()
        passwordField?.text?.clear()
    }

    private fun restoreActivityWindow() {
        activity.window.clearFlags(WindowManager.LayoutParams.FLAG_SECURE)
    }

    @VisibleForTesting
    fun dialogForTest(): AlertDialog? = dialog

    @VisibleForTesting
    fun loginFieldForTest(): EditText? = loginField

    @VisibleForTesting
    fun passwordFieldForTest(): EditText? = passwordField

    @VisibleForTesting
    fun containerForTest(): LinearLayout? = container
}
