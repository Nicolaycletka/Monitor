package host.burmalda.monitor;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

/**
 * Точка входа приложения и приём действий из уведомления.
 *
 * Кнопка «Заснул» / «Проснулся» в уведомлении запускает эту активность
 * с пометкой в интенте. Сама запись здесь НЕ создаётся: активность
 * только откладывает пометку, а разбирает её уже JavaScript, обычным
 * путём — через те же функции, что и кнопка на экране. Так у отметки
 * один-единственный путь в дневник, а не два, которые надо держать
 * согласованными.
 *
 * ПОЧЕМУ ЧЕРЕЗ SharedPreferences, А НЕ СОБЫТИЕМ В МОСТ. Событие
 * потребовало бы, чтобы мост Capacitor уже был готов в момент прихода
 * интента, а при холодном запуске это не так: активность создаётся
 * раньше, чем WebView успевает загрузить приложение. Пометка,
 * положенная на диск, дождётся кого угодно и в любом порядке — гонок
 * здесь нет по построению.
 *
 * ВРЕМЯ НАЖАТИЯ сохраняется вместе с пометкой. Запуск приложения
 * занимает секунду-другую, и записывать сон моментом, когда догрузился
 * WebView, значило бы врать на эту секунду каждый раз.
 */
public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Плагин, объявленный в самом приложении, Capacitor сам не находит.
        // Регистрация обязана идти ДО super.onCreate(), иначе мост
        // успеет собраться без него.
        registerPlugin(SleepNotificationPlugin.class);
        super.onCreate(savedInstanceState);
        stashAction(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        stashAction(intent);
    }

    /** Откладывает пометку из интента, если она там есть. */
    private void stashAction(Intent intent) {
        if (intent == null) return;
        String action = intent.getStringExtra(SleepNotificationPlugin.EXTRA_ACTION);
        if (action == null || action.isEmpty()) return;

        long at = intent.getLongExtra(SleepNotificationPlugin.EXTRA_AT, 0L);
        if (at <= 0) at = System.currentTimeMillis();

        SharedPreferences.Editor ed = getSharedPreferences(
                SleepNotificationPlugin.PREFS, Context.MODE_PRIVATE).edit();
        ed.putString("pendingAction", action);
        ed.putLong("pendingAt", at);
        ed.apply();

        // пометку нельзя оставлять в интенте: при повороте экрана или
        // возврате из фона активность получила бы её повторно
        intent.removeExtra(SleepNotificationPlugin.EXTRA_ACTION);
    }
}
