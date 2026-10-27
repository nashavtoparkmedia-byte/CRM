package ru.yokoone.crm.shell

import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import androidx.annotation.VisibleForTesting
import java.security.KeyStore
import javax.crypto.KeyGenerator
import javax.crypto.Mac
import javax.crypto.SecretKey

/**
 * The two non-exportable HMAC keys the shell keeps, and nothing else.
 *
 * `K_install` keys the retired-token set (§5.7.1); `K_ctx` keys the CRM
 * continuity record (§5.8.2). They are separate aliases on purpose: a record
 * MAC can never be confused with a token hash, and losing one key fails only the
 * path that depends on it.
 *
 * Every failure is reported as an exception and every caller treats an
 * exception as "key unavailable", which is the fail-closed state of C-1: no
 * token stored or sent, continuity never confirmed. Nothing here logs a key, a
 * MAC input or a MAC output.
 */
object ShellKeys {

    const val INSTALL_ALIAS_PREFIX = "yoko.k_install.g"
    const val CONTEXT_ALIAS_PREFIX = "yoko.k_ctx.g"

    /** Where the keys live. The Android Keystore on a device; replaced in JVM tests. */
    interface Backend {
        fun exists(alias: String): Boolean
        fun create(alias: String)
        fun delete(alias: String)

        /** Throws on any failure, including a key the platform has invalidated. */
        fun hmac(alias: String, data: ByteArray): ByteArray
    }

    @Volatile
    @VisibleForTesting
    var backend: Backend = AndroidKeystoreBackend

    fun hmacHex(alias: String, data: ByteArray): String = hex(backend.hmac(alias, data))

    fun hex(bytes: ByteArray): String {
        val out = StringBuilder(bytes.size * 2)
        for (b in bytes) {
            val v = b.toInt() and 0xff
            out.append(HEX[v ushr 4])
            out.append(HEX[v and 0x0f])
        }
        return out.toString()
    }

    private val HEX = "0123456789abcdef".toCharArray()

    private object AndroidKeystoreBackend : Backend {

        private const val PROVIDER = "AndroidKeyStore"

        private fun store(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

        override fun exists(alias: String): Boolean = store().containsAlias(alias)

        override fun create(alias: String) {
            val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_HMAC_SHA256, PROVIDER)
            generator.init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_SIGN).build())
            generator.generateKey()
        }

        override fun delete(alias: String) {
            val keys = store()
            if (keys.containsAlias(alias)) keys.deleteEntry(alias)
        }

        override fun hmac(alias: String, data: ByteArray): ByteArray {
            val key = store().getKey(alias, null) as? SecretKey
                ?: throw IllegalStateException("key unavailable")
            return Mac.getInstance("HmacSHA256").run {
                init(key)
                doFinal(data)
            }
        }
    }
}
