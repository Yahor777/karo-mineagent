package dev.mineagent.bridge.common.tools;

import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.function.Supplier;

/**
 * Очередь задач для исполнения на client game thread. Minecraft API не
 * потокобезопасен: инструменты приходят из HTTP-потока JDK-сервера, но
 * выполнять их можно только на главном клиентском потоке.
 *
 * Паттерн (entry-12 source-ledger): HTTP-handler кладёт {@link Task} в
 * thread-safe очередь, client-tick-handler (подписан loader'ом на client-tick)
 * в конце каждого тика дёргает {@link #drainAll()} и исполняет задачи.
 * Результат возвращается в HTTP-поток через {@link CompletableFuture} с
 * таймаутом — инструмент не должен вешать сервер бесконечно.
 *
 * Потокобезопасность: очередь ConcurrentLinkedQueue, CompletableFuture —
 * используются только безопасные операции. Сама задача выполняется на
 * drained-потоке (game thread), её реализация не обязана быть synchronized.
 */
public final class MainThreadQueue {

    /** Задача с результатом: callable + будущее. */
    public static final class Task<T> {
        final Callable<T> callable;
        final CompletableFuture<T> future = new CompletableFuture<>();

        Task(Callable<T> callable) {
            this.callable = callable;
        }
    }

    private final ConcurrentLinkedQueue<Task<?>> pending = new ConcurrentLinkedQueue<>();
    private final long defaultTimeoutMs;

    public MainThreadQueue(long defaultTimeoutMs) {
        this.defaultTimeoutMs = defaultTimeoutMs;
    }

    /**
     * Добавляет callable в очередь и ждёт результат с таймаутом. Бросает
     * TimeoutException если game thread не дёргал очередь за defaultTimeoutMs
     * (например, мир на паузе/не загружен) — HTTP-handler вернёт semantic-ошибку.
     */
    public <T> T submitAndWait(Callable<T> callable) throws InterruptedException, TimeoutException, ExecutionException {
        Task<T> task = new Task<>(callable);
        pending.add(task);
        return task.future.get(defaultTimeoutMs, TimeUnit.MILLISECONDS);
    }

    /** Для тестов/кастомного таймаута. */
    public <T> T submitAndWait(Callable<T> callable, long timeoutMs)
            throws InterruptedException, TimeoutException, ExecutionException {
        Task<T> task = new Task<>(callable);
        pending.add(task);
        return task.future.get(timeoutMs, TimeUnit.MILLISECONDS);
    }

    /**
     * Исполняет все накопленные задачи на вызывающем (game) потоке. Вызывается
     * loader'ом из client-tick-handler. Ошибки внутри callable НЕ пробрасываются
     * наружу (не вешают игру) — кладутся в future как exceptional, HTTP-handler
     * увидит их как semantic-ошибку.
     */
    public void drainAll() {
        Task<?> task;
        while ((task = pending.poll()) != null) {
            runOne(task);
        }
    }

    @SuppressWarnings({"unchecked", "rawtypes"})
    private void runOne(Task task) {
        try {
            Object result = task.callable.call();
            task.future.complete(result);
        } catch (Throwable t) {
            task.future.completeExceptionally(t);
        }
    }

    /** Есть ли ожидающие задачи (для диагностики/loader'а). */
    public int pendingCount() {
        return pending.size();
    }

    /** Отмена всех ожидающих задач при остановке моста. */
    public void cancelAll() {
        Task<?> task;
        while ((task = pending.poll()) != null) {
            task.future.cancel(false);
        }
    }

    /** Удобная обёртка для Supplier (без checked exceptions). */
    public <T> T supplyAndWait(Supplier<T> supplier) throws InterruptedException, TimeoutException, ExecutionException {
        return submitAndWait(supplier::get);
    }
}
