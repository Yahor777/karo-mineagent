package dev.mineagent.bridge.common.tools;

import java.util.Map;

/**
 * reload_resources — триггер перезагрузки клиентских ресурсов (после
 * patch'а текстур/моделей, чтобы увидеть изменения без рестарта клиента).
 */
public final class ReloadResourcesTool implements BridgeTool {

    @Override
    public String name() {
        return "reload_resources";
    }

    @Override
    public String description() {
        return "Trigger a reload of client resources (textures, models, datapacks). "
                + "Use after patching assets to see changes without restarting the client.";
    }

    @Override
    public Map<String, Object> inputSchema() {
        return Map.of("type", "object", "properties", Map.of());
    }

    @Override
    public ToolResult invoke(Map<String, Object> arguments, ToolContext ctx) {
        try {
            String result = ctx.queue().supplyAndWait(() -> {
                if (!ctx.game().isClientReady()) {
                    return "Client not ready (no world loaded).";
                }
                return ctx.game().reloadResources();
            });
            return ToolResult.text(result);
        } catch (Exception e) {
            return ToolResult.error("reload_resources failed: " + e.getMessage());
        }
    }
}
