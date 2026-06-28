package dev.mineagent.bridge.common.tools;

import dev.mineagent.bridge.common.game.BridgeGameAccess;

import java.util.Map;

/**
 * Один инструмент MCP-сервера (server-side). Реализации живут в common/ и через
 * {@link BridgeGameAccess} обращаются к MC API (enqueue'аясь на game thread).
 *
 * Контракт: name уникален, description — человекочитаемое описание для модели,
 * inputSchema — JSON Schema (как object) для tools/list. invoke выполняется на
 * HTTP-потоке, но сам доступ к MC идёт через {@code enqueue + CompletableFuture}
 * (внутри invoke) — НЕ напрямую.
 */
public interface BridgeTool {

    /** Имя инструмента (без префикса). Например "summon". */
    String name();

    /** Описание для tools/list (видит модель). */
    String description();

    /**
     * JSON Schema параметров (объект). Сериализуется в inputSchema tools/list.
     * Возвращается как Map (Gson-совместимый): {type:object, properties:{...}}.
     */
    Map<String, Object> inputSchema();

    /**
     * Вызывается на HTTP-потоке. Должен enqueue'нуть работу на game thread через
     * ctx.queue() и вернуть {@link ToolResult}.
     */
    ToolResult invoke(Map<String, Object> arguments, ToolContext ctx);

    /** Контекст исполнения: доступ к игре + очередь main-thread. */
    final class ToolContext {
        private final BridgeGameAccess gameAccess;
        private final MainThreadQueue queue;

        public ToolContext(BridgeGameAccess gameAccess, MainThreadQueue queue) {
            this.gameAccess = gameAccess;
            this.queue = queue;
        }

        public BridgeGameAccess game() {
            return gameAccess;
        }

        public MainThreadQueue queue() {
            return queue;
        }
    }

    /** Результат invoke: массив content-блоков + isError-флаг (MCP tools/call). */
    final class ToolResult {
        /** content-блоки: Map с type-discriminator ({type:text|image}, data/mimeType). */
        public final java.util.List<Map<String, Object>> content;
        public final boolean isError;

        public ToolResult(java.util.List<Map<String, Object>> content, boolean isError) {
            this.content = content;
            this.isError = isError;
        }

        public static ToolResult text(String text) {
            return new ToolResult(java.util.List.of(Map.of("type", "text", "text", text)), false);
        }

        public static ToolResult error(String text) {
            return new ToolResult(java.util.List.of(Map.of("type", "text", "text", text)), true);
        }

        public static ToolResult image(String base64, String mimeType) {
            return new ToolResult(java.util.List.of(Map.of("type", "image", "data", base64, "mimeType", mimeType)), false);
        }
    }
}
