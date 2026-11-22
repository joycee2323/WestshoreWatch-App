package com.westshoredrone.watch.auto

import android.content.Context
import android.util.Base64
import android.util.Log
import com.westshoredrone.watch.UploadConfig
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Finds the signed-in user's JWT for the car screens, without needing the JS
 * runtime (Android Auto can cold-start the CarAppService on its own).
 *
 * 1. READ-ONLY decrypt of the `auth_token` item that the phone app stores via
 *    expo-secure-store (authStore.ts). Mirrors expo-secure-store 15.0.8's
 *    SecureStoreModule.readJSONEncodedItem + AESEncryptor.decryptItem for the
 *    default keychain ("key_v1"), unauthenticated items only. Never writes or
 *    deletes. If the format changes in a future expo-secure-store, this returns
 *    null and we fall back to (2).
 * 2. `UploadConfig.authToken`, which JS pushes into native memory on start/login.
 *
 * Logout deletes the SecureStore item and clears UploadConfig, so a signed-out
 * phone reads as signed out here too.
 */
object AuthTokenProvider {
    private const val TAG = "WswAutoAuth"
    private const val TOKEN_KEY = "auth_token"

    fun currentToken(context: Context): String? {
        val fromStore = try {
            SecureStoreReader.read(context, TOKEN_KEY)
        } catch (t: Throwable) {
            Log.w(TAG, "secure-store read failed: ${t.javaClass.simpleName}")
            null
        }
        return fromStore?.takeIf { it.isNotBlank() }
            ?: UploadConfig.authToken?.takeIf { it.isNotBlank() }
    }
}

/** Pure parts of the expo-secure-store item format (unit-tested). */
object SecureStoreFormat {
    const val PREFS_NAME = "SecureStore"
    const val DEFAULT_KEYCHAIN = "key_v1"
    private const val AES_CIPHER = "AES/GCM/NoPadding"
    private const val UNAUTHENTICATED_SUFFIX = "keystoreUnauthenticated"
    private const val MIN_TAG_LENGTH_BITS = 96

    data class EncryptedItem(val keystoreAlias: String, val ciphertextB64: String, val ivB64: String, val tagLengthBits: Int)

    /** Pref keys to try, current format first: "key_v1-auth_token", then legacy "auth_token". */
    fun prefKeys(key: String, keychain: String = DEFAULT_KEYCHAIN): List<String> = listOf("$keychain-$key", key)

    /**
     * Parses a stored item. Returns null for anything we must not / cannot read
     * here: non-AES schemes (the hybrid RSA scheme of very old installs) and
     * items that need biometric authentication (impossible in a car).
     */
    fun parse(json: String, keychain: String = DEFAULT_KEYCHAIN): EncryptedItem? {
        val o = runCatching { JSONObject(json) }.getOrNull() ?: return null
        if (o.optString("scheme") != "aes") return null
        if (o.optBoolean("requireAuthentication", false)) return null
        val ct = o.optString("ct").takeIf { it.isNotEmpty() } ?: return null
        val iv = o.optString("iv").takeIf { it.isNotEmpty() } ?: return null
        val tlen = o.optInt("tlen", 0)
        if (tlen < MIN_TAG_LENGTH_BITS) return null
        val base = "$AES_CIPHER:$keychain"
        val alias = if (o.optBoolean("usesKeystoreSuffix", false)) "$base:$UNAUTHENTICATED_SUFFIX" else base
        return EncryptedItem(alias, ct, iv, tlen)
    }
}

internal object SecureStoreReader {
    fun read(context: Context, key: String): String? {
        val prefs = context.getSharedPreferences(SecureStoreFormat.PREFS_NAME, Context.MODE_PRIVATE)
        val raw = SecureStoreFormat.prefKeys(key).firstNotNullOfOrNull { prefs.getString(it, null) } ?: return null
        val item = SecureStoreFormat.parse(raw) ?: return null
        val ks = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        if (!ks.containsAlias(item.keystoreAlias)) return null
        val secret = (ks.getEntry(item.keystoreAlias, null) as? KeyStore.SecretKeyEntry)?.secretKey ?: return null
        return decrypt(secret, item)
    }

    private fun decrypt(key: SecretKey, item: SecureStoreFormat.EncryptedItem): String {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(item.tagLengthBits, Base64.decode(item.ivB64, Base64.DEFAULT)))
        return String(cipher.doFinal(Base64.decode(item.ciphertextB64, Base64.DEFAULT)), Charsets.UTF_8)
    }
}
