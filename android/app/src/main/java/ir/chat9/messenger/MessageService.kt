package ir.chat9.messenger

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit
import kotlin.math.min

/**
 * سرویس پیش‌زمینه که حتی با بسته بودن برنامه، اتصال زنده به سرور را نگه می‌دارد
 * و پیام‌های تازه را به‌صورت اعلان نشان می‌دهد.
 *
 * عمداً از FCM استفاده نمی‌شود: این برنامه نباید به سرویس‌های گوگل وابسته باشد و
 * باید در شبکه‌ی داخلی هم کار کند. بهایش این است که اندروید یک اعلان دائمی
 * کم‌اهمیت می‌خواهد و باید بهینه‌سازی باتری برای برنامه خاموش شود.
 */
class MessageService : Service() {

    private var socket: WebSocket? = null
    private var retryDelayMs = 2_000L
    private var myUserId: Int? = null
    private val titles = mutableMapOf<Int, String>()

    private val client = OkHttpClient.Builder()
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(25, TimeUnit.SECONDS) // اتصال را از خواب نگه می‌دارد
        .retryOnConnectionFailure(true)
        .build()

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        startForegroundSafely()
        if (socket == null) connect()
        return START_STICKY // اگر سیستم سرویس را کشت، دوباره بالا بیاید
    }

    override fun onDestroy() {
        socket?.close(1000, "service stopped")
        socket = null
        super.onDestroy()
    }

    /* --------------------------------------------------------- اتصال زنده */

    private fun connect() {
        val session = Session.read(this) ?: run { stopSelf(); return }
        val wsUrl = session.serverUrl.replaceFirst("http", "ws") + "/ws?token=" + session.token

        socket = client.newWebSocket(
            Request.Builder().url(wsUrl).build(),
            object : WebSocketListener() {
                override fun onOpen(webSocket: WebSocket, response: Response) {
                    retryDelayMs = 2_000L
                }

                override fun onMessage(webSocket: WebSocket, text: String) {
                    handleEvent(text, session)
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    // ۴۰۰۱/۴۰۰۳ یعنی نشست باطل شده؛ تلاش دوباره بی‌فایده است.
                    if (response?.code == 401 || response?.code == 403) {
                        Session.clear(this@MessageService)
                        stopSelf()
                        return
                    }
                    scheduleReconnect()
                }

                override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                    if (code == 4001 || code == 4003) {
                        Session.clear(this@MessageService)
                        stopSelf()
                    } else {
                        scheduleReconnect()
                    }
                }
            }
        )
    }

    private fun scheduleReconnect() {
        socket = null
        val delay = retryDelayMs
        retryDelayMs = min(retryDelayMs * 2, 60_000L)
        android.os.Handler(mainLooper).postDelayed({ if (socket == null) connect() }, delay)
    }

    private fun handleEvent(text: String, session: Session.Data) {
        val event = runCatching { JSONObject(text) }.getOrNull() ?: return
        when (event.optString("type")) {
            "ready" -> myUserId = event.optInt("userId").takeIf { it > 0 }

            "message:new" -> {
                // وقتی برنامه جلوی چشم کاربر است، خودِ صفحه اعلان را نشان می‌دهد.
                if (MainActivity.isInForeground) return

                val message = event.optJSONObject("message") ?: return
                if (message.optString("kind") == "system") return
                val senderId = message.optInt("senderId", -1)
                if (myUserId != null && senderId == myUserId) return

                val conversationId = message.optInt("conversationId", 0)
                val body = if (message.optString("kind") == "image") {
                    "🖼 عکس فرستاد"
                } else {
                    message.optString("body").take(140)
                }
                notifyMessage(conversationId, body, session)
            }
        }
    }

    /* ------------------------------------------------------------ اعلان‌ها */

    private fun notifyMessage(conversationId: Int, body: String, session: Session.Data) {
        val title = titles[conversationId] ?: fetchTitle(conversationId, session)
        if (!NotificationManagerCompat.from(this).areNotificationsEnabled()) return

        val intent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val pending = PendingIntent.getActivity(
            this, conversationId, intent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val notification = NotificationCompat.Builder(this, WebAppBridge.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(NotificationCompat.BigTextStyle().bigText(body))
            .setAutoCancel(true)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setContentIntent(pending)
            .build()

        runCatching {
            NotificationManagerCompat.from(this).notify(conversationId, notification)
        }
    }

    /** نام گفتگو در رویداد نیست، پس یک بار از سرور گرفته و نگه داشته می‌شود. */
    private fun fetchTitle(conversationId: Int, session: Session.Data): String {
        val fallback = getString(R.string.app_name)
        val request = Request.Builder()
            .url("${session.serverUrl}/api/conversations/$conversationId")
            .header("Authorization", "Bearer ${session.token}")
            .build()
        return runCatching {
            client.newCall(request).execute().use { response ->
                val payload = JSONObject(response.body?.string() ?: return@use fallback)
                val title = payload.optJSONObject("conversation")?.optString("title").orEmpty()
                if (title.isBlank()) fallback else title.also { titles[conversationId] = it }
            }
        }.getOrDefault(fallback)
    }

    /* ------------------------------------------- اعلان دائمی خودِ سرویس */

    private fun startForegroundSafely() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            if (manager?.getNotificationChannel(ONGOING_CHANNEL) == null) {
                manager?.createNotificationChannel(
                    NotificationChannel(
                        ONGOING_CHANNEL,
                        getString(R.string.notification_channel_service),
                        NotificationManager.IMPORTANCE_MIN
                    ).apply { setShowBadge(false) }
                )
            }
        }

        val ongoing = NotificationCompat.Builder(this, ONGOING_CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(getString(R.string.service_running))
            .setPriority(NotificationCompat.PRIORITY_MIN)
            .setOngoing(true)
            .setContentIntent(
                PendingIntent.getActivity(
                    this, 0, Intent(this, MainActivity::class.java),
                    PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
                )
            )
            .build()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            startForeground(ONGOING_ID, ongoing, ServiceInfo.FOREGROUND_SERVICE_TYPE_REMOTE_MESSAGING)
        } else {
            startForeground(ONGOING_ID, ongoing)
        }
    }

    companion object {
        private const val ONGOING_CHANNEL = "service"
        private const val ONGOING_ID = 1

        fun start(context: Context) {
            if (Session.read(context) == null) return
            val intent = Intent(context, MessageService::class.java)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent)
            } else {
                context.startService(intent)
            }
        }

        fun stop(context: Context) {
            context.stopService(Intent(context, MessageService::class.java))
        }
    }
}
