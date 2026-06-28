package dev.mineagent.bridge.common.mcp;

import dev.mineagent.bridge.common.game.BridgeGameAccess;
import dev.mineagent.bridge.common.tools.BridgeTool;
import dev.mineagent.bridge.common.tools.MainThreadQueue;

/**
 * Состояние одной MCP-сессии. Создаётся на initialize, хранит protocolVersion
 * (после переговора) и доступ к MC (game-access + main-thread queue). Loader
 * заполняет game-access/queue при старта bridge'а; protocol/sessionId —
 * в рантайме.
 */
public final class McpSession {

    private final BridgeTool.ToolContext toolContext;
    private String protocolVersion;
    private String sessionId;
    private boolean initialized;

    public McpSession(BridgeGameAccess gameAccess, MainThreadQueue queue) {
        this.toolContext = new BridgeTool.ToolContext(gameAccess, queue);
    }

    public String getProtocolVersion() {
        return protocolVersion;
    }

    public void setProtocolVersion(String protocolVersion) {
        this.protocolVersion = protocolVersion;
    }

    public String getSessionId() {
        return sessionId;
    }

    public void setSessionId(String sessionId) {
        this.sessionId = sessionId;
    }

    public boolean isInitialized() {
        return protocolVersion != null;
    }

    public BridgeTool.ToolContext requireToolContext() {
        return toolContext;
    }
}
