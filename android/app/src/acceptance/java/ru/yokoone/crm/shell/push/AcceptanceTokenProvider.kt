package ru.yokoone.crm.shell.push

import android.content.Context

/**
 * The provider the token actor reads in acceptance, in place of Firebase.
 *
 * It holds the one token the workflow seeded, in this variant's own file, and
 * behaves like the provider where it matters to the actor: getToken() returns
 * the current token (or none), and deleteToken() removes it. Acceptance only.
 */
class AcceptanceTokenProvider private constructor(private val context: Context) : TokenActor.Provider {

    override fun getToken(listener: (String?) -> Unit) {
        listener(prefs(context).getString(KEY_TOKEN, null))
    }

    override fun deleteToken(listener: (Boolean) -> Unit) {
        listener(prefs(context).edit().remove(KEY_TOKEN).commit())
    }

    companion object {
        private const val PREFS = "yoko_acceptance_push_provider"
        private const val KEY_TOKEN = "token"

        private fun prefs(context: Context) =
            context.applicationContext.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

        /** Null until a token was seeded, so an unseeded run has no provider at all. */
        fun forContext(context: Context): TokenActor.Provider? {
            val app = context.applicationContext
            if (!prefs(app).contains(KEY_TOKEN)) return null
            return AcceptanceTokenProvider(app)
        }

        fun seed(context: Context, token: String): Boolean =
            prefs(context).edit().putString(KEY_TOKEN, token).commit()
    }
}
