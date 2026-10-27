package ru.yokoone.crm.shell

import android.app.Activity
import android.content.Intent
import android.os.Bundle

/**
 * Target of the static launcher shortcut «Выйти и сменить сотрудника» (R5.1 §5.4).
 *
 * Not exported: static shortcuts are started on behalf of the publishing app
 * (P8), so no other app can reach it. It carries no trusted extra to
 * MainActivity — MainActivity is exported as the launcher entry and its extras
 * cannot be trusted — but raises a process-local flag and brings MainActivity
 * to the front, which then runs reset OPERATOR_SWITCH (subject to the shortcut
 * limit of 3 per 10 minutes).
 */
class OperatorResetActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        OperatorSwitchRequest.raise()
        startActivity(
            Intent(this, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP),
        )
        finish()
    }
}

/** Process-local hand-off from [OperatorResetActivity] to MainActivity. */
object OperatorSwitchRequest {

    @Volatile
    private var pending = false

    fun raise() {
        pending = true
    }

    /** Consume the request; true at most once per raise. */
    fun take(): Boolean {
        val was = pending
        pending = false
        return was
    }
}
