package dev.mineagent.bridge.common;

import dev.mineagent.bridge.common.tools.MainThreadQueue;
import org.junit.jupiter.api.Test;

import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Тесты MainThreadQueue: enqueue → drainAll на «game thread» → результат в
 * вызывающем потоке; таймаут; исключения внутри callable НЕ вешают игру.
 */
class MainThreadQueueTest {

    @Test
    void submitAndWait_returnsResultAfterDrain() throws Exception {
        MainThreadQueue queue = new MainThreadQueue(2_000L);
        // Поток-«game thread»: только он дёргает drainAll. Callable обязан
        // исполниться на нём, а НЕ на submitter-потоке (это и есть контракт
        // thread-affinity Minecraft API — entry-12 source-ledger).
        AtomicInteger ranOn = new AtomicInteger();
        Thread submitter = new Thread(() -> {
            try {
                String result = queue.submitAndWait(() -> {
                    ranOn.set(Thread.currentThread().hashCode());
                    return "done";
                });
                assertEquals("done", result);
            } catch (Exception e) {
                fail(e);
            }
        });

        // game-thread крутит drainAll, пока submitter не отдаст результат.
        final Thread gameThread = Thread.currentThread();
        submitter.start();
        long deadline = System.currentTimeMillis() + 2_000;
        while (System.currentTimeMillis() < deadline && ranOn.get() == 0) {
            queue.drainAll();
            if (queue.pendingCount() == 0) {
                Thread.sleep(1);
            }
        }
        submitter.join(1_000);

        assertNotEquals(0, ranOn.get(), "callable never executed");
        assertEquals(gameThread.hashCode(), ranOn.get(),
                "callable must run on the thread that drains (game thread), not the submitter");
    }

    @Test
    void exceptionInsideCallable_completesExceptionallyNotHang() throws Exception {
        MainThreadQueue queue = new MainThreadQueue(2_000L);
        Thread submitter = new Thread(() -> {
            try {
                queue.submitAndWait(() -> {
                    throw new IllegalStateException("boom");
                });
                fail("should have thrown");
            } catch (java.util.concurrent.ExecutionException e) {
                assertTrue(e.getCause() instanceof IllegalStateException);
                assertEquals("boom", e.getCause().getMessage());
            } catch (Exception e) {
                fail(e);
            }
        });
        submitter.start();
        awaitPending(queue);
        queue.drainAll();
        submitter.join(1_000);
        assertEquals(0, queue.pendingCount());
    }

    @Test
    void timeoutWhenDrainNeverHappens() throws Exception {
        MainThreadQueue queue = new MainThreadQueue(100L);
        assertThrows(java.util.concurrent.TimeoutException.class, () ->
                queue.submitAndWait(() -> "never"));
    }

    @Test
    void cancelAllClearsPending() {
        MainThreadQueue queue = new MainThreadQueue(2_000L);
        // Положим задачу, но не дёргаем drain — она останется pending.
        Thread t = new Thread(() -> {
            try {
                queue.submitAndWait(() -> "x", 10_000L);
                fail("should be cancelled");
            } catch (Exception e) {
                // expected: CancellationException
            }
        });
        t.setDaemon(true);
        t.start();
        awaitPending(queue);
        queue.cancelAll();
        assertEquals(0, queue.pendingCount());
    }

    @Test
    void bridgeTokenGeneration_isHex64() {
        String token1 = Bridge.generateToken();
        String token2 = Bridge.generateToken();
        assertEquals(64, token1.length());
        assertTrue(token1.matches("[0-9a-f]{64}"));
        assertNotEquals(token1, token2, "tokens must be random");
    }

    private static void awaitPending(MainThreadQueue queue) {
        for (int i = 0; i < 500; i++) {
            if (queue.pendingCount() > 0) {
                return;
            }
            try {
                Thread.sleep(2);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        }
        fail("task never appeared in queue");
    }
}
