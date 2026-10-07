package ir.chat9.messenger

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.webkit.JavascriptInterface
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat

/**
 * پلی که صفحه‌ی وب از آن اعلان بومی می‌سازد.
 *
 * WebView اصلاً Notification API ندارد، پس بدون این پل، اعلان داخل اپ اندروید
 * هیچ‌وقت کار نمی‌کند. فقط وقتی فعال می‌شود که صفحه‌ی باز، همان سرور خودمان باشد.
 */
class WebAppBridge(
    private val context: Context,
    private val isTrustedPage: () -> Boolean,
    private val onPermissionNeeded: () -> Unit
) {

    @JavascriptInterface
    fun notify(title: String?, body: String?, tag: String?) {
        if (!isTrustedPage()) return
        if (!NotificationManagerCompat.from(context).areNotificationsEnabled()) {
            onPermissionNeeded()
            return
        }

        ensureChannel()

        val intent = Intent(context, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            context,
            0,
            intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title ?: context.getString(R.string.app_name))
            .setContentText(body ?: "")
            .setStyle(NotificationCompat.BigTextStyle().bigText(body ?: ""))
            .setAutoCancel(true)
            .setDefaults(Notification.DEFAULT_ALL)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pending)
            .build()

        // هر گفتگو یک اعلان دارد که با پیام تازه جایگزین می‌شود، نه اینکه روی هم تلنبار شود.
        val id = (tag ?: "general").hashCode()
        runCatching { NotificationManagerCompat.from(context).notify(id, notification) }
    }

    /** صفحه‌ی وب موقع ورود این را صدا می‌زند تا در اندروید ۱۳ به بالا اجازه گرفته شود. */
    @JavascriptInterface
    fun requestNotificationPermission() {
        if (!isTrustedPage()) return
        onPermissionNeeded()
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
        val manager = context.getSystemService(NotificationManager::class.java) ?: return
        if (manager.getNotificationChannel(CHANNEL_ID) != null) return
        manager.createNotificationChannel(
            NotificationChannel(
                CHANNEL_ID,
                context.getString(R.string.notification_channel_messages),
                NotificationManager.IMPORTANCE_HIGH
            ).apply { description = context.getString(R.string.notification_channel_description) }
        )
    }

    companion object {
        const val CHANNEL_ID = "messages"
    }
}
