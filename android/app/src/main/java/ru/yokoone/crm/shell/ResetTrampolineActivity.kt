package ru.yokoone.crm.shell

import android.app.Activity
import android.app.ActivityManager
import android.content.Context
import android.content.Intent
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.os.Process
import android.view.Gravity
import android.widget.TextView

/**
 * Relaunch after an edge context reset (R5.1 §5.3 step 7), in process `:reset`.
 *
 * MainActivity starts this, then finishes its task and ends its own process.
 * This waits until the main process is gone (at most 3 s), starts MainActivity
 * in a fresh task and ends itself. If the main process is still alive after
 * 3 s it says so and ends without relaunching — no loop, no stale context.
 *
 * The `:reset` process is inert (N3): ShellApplication returns early here, and
 * this activity reads nothing but the pid extra.
 */
class ResetTrampolineActivity : Activity() {

    private val handler = Handler(Looper.getMainLooper())
    private var waitedMs = 0L

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val mainPid = intent.getIntExtra(EXTRA_MAIN_PID, -1)
        val reason = EdgeContextReset.Reason.sanitize(intent.getStringExtra(EXTRA_REASON))
        poll(mainPid, reason)
    }

    private fun poll(mainPid: Int, reason: String) {
        if (mainPid <= 0 || !isAlive(mainPid)) {
            startActivity(
                Intent(this, MainActivity::class.java)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK)
                    .putExtra(EXTRA_AFTER_RESET, reason),
            )
            finish()
            Process.killProcess(Process.myPid())
            return
        }
        if (waitedMs >= EdgeContextReset.TRAMPOLINE_WAIT_MS) {
            setContentView(TextView(this).apply {
                text = getString(R.string.reset_close_app)
                gravity = Gravity.CENTER
                setPadding(48, 48, 48, 48)
            })
            handler.postDelayed({
                finish()
                Process.killProcess(Process.myPid())
            }, MESSAGE_MS)
            return
        }
        waitedMs += POLL_MS
        handler.postDelayed({ poll(mainPid, reason) }, POLL_MS)
    }

    private fun isAlive(pid: Int): Boolean {
        val manager = getSystemService(Context.ACTIVITY_SERVICE) as ActivityManager
        return manager.runningAppProcesses?.any { it.pid == pid } == true
    }

    companion object {
        const val EXTRA_MAIN_PID = "main_pid"
        const val EXTRA_REASON = "reason"
        const val EXTRA_AFTER_RESET = "after_reset"

        private const val POLL_MS = 100L
        private const val MESSAGE_MS = 4_000L
    }
}
