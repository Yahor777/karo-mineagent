package dev.mineagent.bridge.common.tools;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Реестр инструментов MCP-сервера. Loader-agnostic: грузит стандартный набор
 * mineagent-bridge. Сам реестр не знает о Minecraft — только о {@link BridgeTool}
 * реализациях, которые через {@link BridgeTool.ToolContext#game()} идут к MC API.
 *
 * Источник правды для tools/list и tools/call в {@code McpProtocol}.
 */
public final class BridgeTools {

    private final Map<String, BridgeTool> tools = new LinkedHashMap<>();

    public BridgeTools() {
        register(new SummonTool());
        register(new ApplyEffectTool());
        register(new SetCameraTool());
        register(new ScreenshotTool());
        register(new GetStateTool());
        register(new ReloadResourcesTool());
    }

    private void register(BridgeTool tool) {
        tools.put(tool.name(), tool);
    }

    /** Все имена инструментов (для tools/list). */
    public List<String> names() {
        return List.copyOf(tools.keySet());
    }

    public BridgeTool get(String name) {
        return tools.get(name);
    }

    public boolean has(String name) {
        return tools.containsKey(name);
    }

    /**
     * Собирает ответ tools/list: массив {name, description, inputSchema}.
     * Возвращается как List<Map> → Gson-сериализация в JSON-RPC result.
     */
    public List<Map<String, Object>> toToolList() {
        List<Map<String, Object>> list = new java.util.ArrayList<>();
        for (BridgeTool tool : tools.values()) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("name", tool.name());
            entry.put("description", tool.description());
            entry.put("inputSchema", tool.inputSchema());
            list.add(entry);
        }
        return list;
    }
}
