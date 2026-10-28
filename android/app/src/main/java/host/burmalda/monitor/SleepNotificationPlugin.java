package host.burmalda.monitor;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Постоянное уведомление о сне с кнопкой «Заснул» / «Проснулся».
 *
 * Кнопка ЗАПУСКАЕТ ПРИЛОЖЕНИЕ с пометкой в интенте, а запись создаёт
 * уже JavaScript — теми же функциями, что и кнопка на экране.
 *
 * Так выбрано осознанно, вместо фоновой отправки прямо на сервер:
 *
 *  - работает без сети: запись ложится в местную базу и уедет на
 *    сервер при первой возможности, тогда как фоновый вариант без
 *    связи просто терял бы отметку;
 *  - у отметки один путь в дневник, а не два, которые надо держать
 *    согласованными;
 *  - токен никуда не сохраняется, плагину он попросту не нужен;
 *  - нативного кода втрое меньше, а это ровно та часть, которую в
 *    этом проекте труднее всего проверить.
 *
 * Цена — приложение видимо открывается, и на заблокированном телефоне
 * система потребует разблокировки.
 *
 * ВРЕМЯ НАЖАТИЯ кладётся в интент. Запуск занимает секунду-другую, и
 * записывать сон моментом готовности WebView значило бы врать на эту
 * секунду при каждой отметке.
 */
@CapacitorPlugin(name = "SleepNotification")
public class SleepNotificationPlugin extends Plugin {

    public static final String PREFS = "sleep_notification";
    public static final String CHANNEL_ID = "sleep_window";
    public static final int NOTIFICATION_ID = 42;

    public static final String EXTRA_ACTION = "sleepAction";
    public static final String EXTRA_AT = "sleepActionAt";

    public static final String ACTION_FALL_ASLEEP = "fall_asleep";
    public static final String ACTION_WAKE_UP = "wake_up";

    @PluginMethod
    public void show(PluginCall call) {
        String body = call.getString("body", "");
        boolean asleep = Boolean.TRUE.equals(call.getBoolean("asleep", false));
        try {
            postNotification(getContext(), body, asleep);
            call.resolve();
        } catch (Exception e) {
            // разрешения может не быть (Android 13+), канал мог быть
            // выключен пользователем — уведомление это удобство, а не
            // условие работы приложения
            call.reject("notification_failed", e);
        }
    }

    @PluginMethod
    public void hide(PluginCall call) {
        NotificationManagerCompat.from(getContext()).cancel(NOTIFICATION_ID);
        call.resolve();
    }

    @PluginMethod
    public void available(PluginCall call) {
        JSObject res = new JSObject();
        res.put("value", true);
        call.resolve(res);
    }

    /**
     * Забрать отложенную пометку и сразу её погасить.
     *
     * Гасим ДО того, как JavaScript успеет что-либо сделать: иначе
     * повторный вызов (перезагрузка WebView, возврат из фона) применил
     * бы одну отметку дважды. Потерять пометку при сбое менее вредно,
     * чем записать лишний сон, который потом придётся искать и удалять.
     */
    @PluginMethod
    public void consumeAction(PluginCall call) {
        SharedPreferences prefs = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String action = prefs.getString("pendingAction", "");
        long at = prefs.getLong("pendingAt", 0L);
        prefs.edit().remove("pendingAction").remove("pendingAt").apply();

        JSObject res = new JSObject();
        res.put("action", action == null ? "" : action);
        res.put("at", at);
        call.resolve(res);
    }

    static void postNotification(Context ctx, String body, boolean asleep) {
        NotificationManager mgr =
                (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                    CHANNEL_ID, "Окно сна", NotificationManager.IMPORTANCE_LOW);
            channel.setDescription("Постоянное уведомление с кнопкой отметки сна");
            // без звука и вибрации: уведомление висит постоянно и
            // обновляет текст, звенеть при каждом обновлении оно не должно
            channel.setSound(null, null);
            channel.enableVibration(false);
            mgr.createNotificationChannel(channel);
        }

        String label = asleep ? "Проснулся" : "Заснул";
        String action = asleep ? ACTION_WAKE_UP : ACTION_FALL_ASLEEP;

        Intent intent = new Intent(ctx, MainActivity.class);
        intent.setAction(Intent.ACTION_MAIN);
        intent.putExtra(EXTRA_ACTION, action);
        intent.putExtra(EXTRA_AT, System.currentTimeMillis());
        // SINGLE_TOP: уже запущенное приложение переиспользуется и
        // получает интент через onNewIntent, а не поднимается второй копией
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);

        // FLAG_IMMUTABLE обязателен с Android 12, иначе система
        // откажется создавать PendingIntent вовсе.
        // FLAG_UPDATE_CURRENT — чтобы обновлялось время нажатия в extras.
        int flags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flags |= PendingIntent.FLAG_IMMUTABLE;
        }
        PendingIntent tap = PendingIntent.getActivity(ctx, asleep ? 1 : 2, intent, flags);

        // нажатие на тело уведомления просто открывает приложение
        Intent open = new Intent(ctx, MainActivity.class);
        open.setAction(Intent.ACTION_MAIN);
        open.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent openPending = PendingIntent.getActivity(ctx, 0, open, flags);

        Notification n = new NotificationCompat.Builder(ctx, CHANNEL_ID)
                .setSmallIcon(android.R.drawable.ic_popup_reminder)
                .setContentTitle("Дневник сна")
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setOngoing(true)          // не смахивается случайным жестом
                .setOnlyAlertOnce(true)    // обновление текста не звенит
                .setShowWhen(false)
                .setPriority(NotificationCompat.PRIORITY_LOW)
                .setContentIntent(openPending)
                .addAction(0, label, tap)
                .build();

        mgr.notify(NOTIFICATION_ID, n);
    }
}
