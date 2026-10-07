package ir.chat9.messenger

import android.content.Context

/** نشست ذخیره‌شده‌ی کاربر، تا سرویس پس‌زمینه بتواند بدون باز بودن برنامه وصل شود. */
object Session {

    data class Data(val token: String, val serverUrl: String)

    private const val PREFS = "messenger-prefs"
    private const val KEY_TOKEN = "session-token"
    private const val KEY_SERVER = "server-url"

    private fun prefs(context: Context) = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun save(context: Context, token: String, serverUrl: String) {
        prefs(context).edit().putString(KEY_TOKEN, token).putString(KEY_SERVER, serverUrl).apply()
    }

    fun read(context: Context): Data? {
        val p = prefs(context)
        val token = p.getString(KEY_TOKEN, null) ?: return null
        val server = p.getString(KEY_SERVER, null) ?: return null
        return Data(token, server.trimEnd('/'))
    }

    fun clear(context: Context) {
        prefs(context).edit().remove(KEY_TOKEN).apply()
    }
}
