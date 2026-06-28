package dev.mineagent.bridge.common.tools;

import java.util.LinkedHashMap;
import java.util.Map;

import static dev.mineagent.bridge.common.tools.SummonTool.asDouble;
import static dev.mineagent.bridge.common.tools.SummonTool.parsePos;

/**
 * set_camera — переместить камеру (локального игрока) в позицию с yaw/pitch.
 */
public final class SetCameraTool implements BridgeTool {

    @Override
    public String name() {
        return "set_camera";
    }

    @Override
    public String description() {
        return "Move the local player camera (teleport) to a position with yaw/pitch "
                + "(degrees). Used to frame screenshots deterministically.";
    }

    @Override
    public Map<String, Object> inputSchema() {
        Map<String, Object> pos = new LinkedHashMap<>();
        pos.put("type", "object");
        Map<String, Object> posProps = new LinkedHashMap<>();
        posProps.put("x", Map.of("type", "number"));
        posProps.put("y", Map.of("type", "number"));
        posProps.put("z", Map.of("type", "number"));
        pos.put("properties", posProps);

        Map<String, Object> schema = new LinkedHashMap<>();
        schema.put("type", "object");
        Map<String, Object> props = new LinkedHashMap<>();
        props.put("pos", pos);
        props.put("yaw", Map.of("type", "number", "description", "Horizontal rotation in degrees (-180..180)."));
        props.put("pitch", Map.of("type", "number", "description", "Vertical rotation in degrees (-90..90)."));
        schema.put("properties", props);
        schema.put("required", java.util.List.of("pos"));
        return schema;
    }

    @Override
    public ToolResult invoke(Map<String, Object> arguments, ToolContext ctx) {
        var pos = parsePos(arguments.get("pos"));
        if (pos == null) {
            return ToolResult.error("set_camera: 'pos' {x,y,z} is required.");
        }
        float yaw = toFloat(asDouble(arguments.get("yaw")), 0f);
        float pitch = toFloat(asDouble(arguments.get("pitch")), 0f);
        try {
            String result = ctx.queue().supplyAndWait(() -> {
                if (!ctx.game().isClientReady()) {
                    return "Client not ready (no world loaded).";
                }
                return ctx.game().setCamera(pos, yaw, pitch);
            });
            return ToolResult.text(result);
        } catch (Exception e) {
            return ToolResult.error("set_camera failed: " + e.getMessage());
        }
    }

    private static float toFloat(Double value, float fallback) {
        return value == null ? fallback : value.floatValue();
    }
}
