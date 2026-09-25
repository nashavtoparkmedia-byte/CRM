package ru.yokoone.crm.shell.push

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.CoroutineWorker
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.util.concurrent.TimeUnit

/**
 * Runs one registration attempt under the platform's own scheduler.
 *
 * WorkManager rather than a retry loop of this app's own, because the cases
 * that matter happen when the app is not running: a token that arrives while
 * the device is offline and a process that dies before connectivity returns
 * would need a durable, network-aware queue, and inventing one here would mean
 * reimplementing this class badly.
 *
 * Unique work, REPLACE: a newer token or a newer session supersedes whatever
 * was queued. What REPLACE cannot do is stop a request already on the wire,
 * which is why the decision logic in PushRegistrationWork treats currency as
 * the real invariant rather than trusting the queue.
 *
 * One-time only. There is no periodic worker and no timer: registration is
 * driven by events — a token arriving, a session becoming authenticated — and
 * polling would spend battery to learn nothing.
 */
class PushRegistrationWorker(
    appContext: Context,
    params: WorkerParameters,
) : CoroutineWorker(appContext, params) {

    override suspend fun doWork(): Result {
        val generation = inputData.getLong(KEY_GENERATION, PushTokenState.NO_GENERATION)
        val token = inputData.getString(KEY_TOKEN).orEmpty()

        val outcome = withContext(Dispatchers.IO) {
            PushRegistrationWork.run(applicationContext, generation, token, runAttemptCount) {
                PushRegistrar.register(it)
            }
        }

        return when (outcome) {
            PushRegistrationWork.Outcome.SUCCESS -> Result.success()
            PushRegistrationWork.Outcome.FAILURE -> Result.failure()
            PushRegistrationWork.Outcome.RETRY -> Result.retry()
        }
    }

    companion object {

        const val UNIQUE_WORK_NAME = "yoko-push-registration"
        const val KEY_GENERATION = "generation"
        const val KEY_TOKEN = "token"

        private const val BACKOFF_SECONDS = 30L

        fun enqueue(context: Context, generation: Long, token: String) {
            val request = OneTimeWorkRequestBuilder<PushRegistrationWorker>()
                .setConstraints(
                    Constraints.Builder()
                        .setRequiredNetworkType(NetworkType.CONNECTED)
                        .build(),
                )
                .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, BACKOFF_SECONDS, TimeUnit.SECONDS)
                .setInputData(workDataOf(KEY_GENERATION to generation, KEY_TOKEN to token))
                .build()

            WorkManager.getInstance(context.applicationContext)
                .enqueueUniqueWork(UNIQUE_WORK_NAME, ExistingWorkPolicy.REPLACE, request)
        }
    }
}
