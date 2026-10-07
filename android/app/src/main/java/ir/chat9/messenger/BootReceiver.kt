package ir.chat9.messenger

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/** بعد از روشن شدن گوشی، اگر کاربر وارد شده باشد سرویس اعلان دوباره بالا می‌آید. */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == Intent.ACTION_MY_PACKAGE_REPLACED
        ) {
            MessageService.start(context)
        }
    }
}
