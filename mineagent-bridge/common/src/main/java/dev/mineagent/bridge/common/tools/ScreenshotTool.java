package dev.mineagent.bridge.common.tools;

import java.util.Map;

/**
 * screenshot — захват кадра с экрана, возвращает PNG как MCP image content block
 * (base64). Технически read-only, но расширенле тракует minecraft.screenshot
 * как game-control с approval: «захватывает состояние игры» (правило AGENTS.md).
 */
public final class ScreenshotTool implements BridgeTool {

    @Override
    public String name() {
        return "screenshot";
    }

    @Override
    public String description() {
        return "Capture the current game frame as a PNG image (base64). Useful for "
                + "vision checks after changing the scene.";
    }

    @Override
    public Map<String, Object> inputSchema() {
        return Map.of("type", "object", "properties", Map.of());
    }

    @Override
    public ToolResult invoke(Map<String, Object> arguments, ToolContext ctx) {
        try {
            String base64 = ctx.queue().supplyAndWait(() -> {
                if (!ctx.game().isClientReady()) {
                    return (String) null;
                }
                return ctx.game().screenshot();
            });
            if (base64 == null) {
                return ToolResult.error("screenshot: capture failed (client not ready or render error).");
            }
            return ToolResult.image(base64, "image/png");
        } catch (Exception e) {
            return ToolResult.error("screenshot failed: " + e.getMessage());
        }
    }
}
