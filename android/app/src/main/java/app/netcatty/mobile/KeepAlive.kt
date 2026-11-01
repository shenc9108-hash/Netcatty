package app.netcatty.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.IBinder
import android.os.PowerManager
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat
import java.util.concurrent.atomic.AtomicInteger

/** Ref-counted foreground service: alive while any AI stream / SSH session is active. */
object KeepAlive {
    private val refs = AtomicInteger(0)
    fun acquire(ctx: Context, text: String) {
        if (refs.getAndIncrement() == 0)
            ContextCompat.startForegroundService(ctx, Intent(ctx, KeepAliveService::class.java).putExtra("text", text))
    }
    fun release(ctx: Context) {
        if (refs.updateAndGet { maxOf(0, it - 1) } == 0) ctx.stopService(Intent(ctx, KeepAliveService::class.java))
    }
}

class KeepAliveService : Service() {
    private var lock: PowerManager.WakeLock? = null
    override fun onBind(i: Intent?): IBinder? = null
    override fun onStartCommand(i: Intent?, f: Int, id: Int): Int {
        val nm = getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel("keepalive", "连接保持", NotificationManager.IMPORTANCE_LOW))
        val n: Notification = NotificationCompat.Builder(this, "keepalive")
            .setContentTitle("Netcatty").setContentText(i?.getStringExtra("text") ?: "运行中")
            .setSmallIcon(android.R.drawable.stat_notify_sync).setOngoing(true).build()
        startForeground(1, n)
        if (lock == null) lock = (getSystemService(POWER_SERVICE) as PowerManager)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "netcatty:keepalive").apply { acquire() }
        return START_STICKY
    }
    override fun onDestroy() { lock?.release(); lock = null; super.onDestroy() }
}
