package com.lusciousdl.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;
import android.os.SystemClock;

import androidx.core.app.NotificationCompat;
import androidx.core.content.ContextCompat;

/** Foreground service that keeps downloads running when the app is in the background or the screen is off. */
public class DownloadService extends Service {
    private static final String CHANNEL = "downloads";
    private static final int ID = 4711;
    private static volatile boolean running = false;
    private static volatile long lastUpdate = 0;

    static void start(Context c) {
        if (running) return;
        ContextCompat.startForegroundService(c, new Intent(c, DownloadService.class));
    }

    static void stop(Context c) {
        c.stopService(new Intent(c, DownloadService.class));
    }

    static void update(Context c, String title, int done, int total) {
        if (!running) return;
        long now = SystemClock.elapsedRealtime();
        if (done < total && now - lastUpdate < 500) return; // don't flood the notification
        lastUpdate = now;
        NotificationManager nm = c.getSystemService(NotificationManager.class);
        try {
            if (nm != null) nm.notify(ID, build(c, title, done, total));
        } catch (SecurityException ignored) {}
    }

    private static Notification build(Context c, String title, int done, int total) {
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = c.getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CHANNEL) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL, "Downloads", NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        }
        Intent open = new Intent(c, MainActivity.class).setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pi = PendingIntent.getActivity(c, 0, open, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
        NotificationCompat.Builder b = new NotificationCompat.Builder(c, CHANNEL)
            .setSmallIcon(android.R.drawable.stat_sys_download)
            .setContentTitle(title == null ? "Downloading" : title)
            .setContentIntent(pi)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setSilent(true)
            .setVisibility(NotificationCompat.VISIBILITY_SECRET)
            .setCategory(NotificationCompat.CATEGORY_PROGRESS);
        if (total > 0) b.setContentText(done + " / " + total).setProgress(total, done, false);
        else b.setContentText("Preparing…").setProgress(0, 0, true);
        return b.build();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Notification n = build(this, "Miwaku", 0, 0);
        if (Build.VERSION.SDK_INT >= 29) startForeground(ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
        else startForeground(ID, n);
        running = true;
        return START_NOT_STICKY;
    }

    @Override
    public void onTimeout(int startId, int fgsType) {
        // Android 15+ limits background data-sync time; stop cleanly when asked.
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
