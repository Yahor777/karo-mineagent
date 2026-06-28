package dev.mineagent.bridge.common;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.mineagent.bridge.common.game.BridgeGameAccess;
import dev.mineagent.bridge.common.game.GameEntitySnapshot;
import dev.mineagent.bridge.common.game.GameVector;
import dev.mineagent.bridge.common.mcp.McpProtocol;
import dev.mineagent.bridge.common.mcp.McpSession;
import dev.mineagent.bridge.common.tools.BridgeTools;
import dev.mineagent.bridge.common.tools.MainThreadQueue;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Тесты wire-формата McpProtocol (JSON-RPC 2.0) без Minecraft: используем mock
 * BridgeGameAccess. Главная цель — lifecycle initialize→tools/list→tools/call и
 * корректность result/error shape по спеке MCP 2025-11-25 (entry-6/7).
 */
class McpProtocolTest {

    private BridgeTools tools;
    private McpProtocol protocol;
    private McpSession session;
    private MainThreadQueue queue;
    private MockGameAccess game;

    @BeforeEach
    void setUp() {
        tools = new BridgeTools();
        protocol = new McpProtocol(tools);
        game = new MockGameAccess();
        // Main-thread очередь, но в тестах дёргаем drainAll вручную в текущем потоке.
        queue = new MainThreadQueue(5_000L);
        session = new McpSession(game, queue);
    }

    @Test
    void initialize_returnsProtocolVersionAndServerInfo() {
        McpProtocol.HandleOutcome out = protocol.handle(initialize(1), session);
        assertTrue(out.isResponse);
        JsonObject resp = parse(out.responseJson);
        assertEquals("2.0", resp.get("jsonrpc").getAsString());
        assertEquals(1, resp.get("id").getAsInt());
        assertTrue(resp.has("result"));
        assertFalse(resp.has("error"));
        JsonObject result = resp.getAsJsonObject("result");
        assertEquals(McpProtocol.PROTOCOL_VERSION, result.get("protocolVersion").getAsString());
        assertEquals(McpProtocol.SERVER_NAME, result.getAsJsonObject("serverInfo").get("name").getAsString());
        // После initialize сессия помечается initialized.
        assertTrue(session.isInitialized());
    }

    @Test
    void toolsList_returnsAllSixToolDescriptions() {
        protocol.handle(initialize(1), session);
        McpProtocol.HandleOutcome out = protocol.handle(
                rpc(2, "tools/list", "{}"), session);
        JsonObject resp = parse(out.responseJson);
        var toolArray = resp.getAsJsonObject("result").getAsJsonArray("tools");
        assertEquals(6, toolArray.size(), "expected summon/apply_effect/set_camera/screenshot/get_state/reload_resources");
        // Каждый entry имеет name/description/inputSchema.
        for (JsonElement el : toolArray) {
            JsonObject t = el.getAsJsonObject();
            assertNotNull(t.get("name"));
            assertNotNull(t.get("description"));
            assertNotNull(t.get("inputSchema"));
        }
    }

    @Test
    void toolsCallBeforeInitialize_isRejected() {
        // tools/call без initialize → ошибка (session не initialized).
        String call = rpc(7, "tools/call", "{\"name\":\"summon\",\"arguments\":{\"entity\":\"minecraft:zombie\"}}");
        McpProtocol.HandleOutcome out = protocol.handle(call, session);
        JsonObject resp = parse(out.responseJson);
        assertTrue(resp.has("error"));
        assertTrue(resp.getAsJsonObject("error").get("code").getAsInt() < 0);
    }

    @Test
    void unknownTool_isErrorMinus32602() {
        protocol.handle(initialize(1), session);
        String call = rpc(2, "tools/call", "{\"name\":\"nope\"}");
        McpProtocol.HandleOutcome out = protocol.handle(call, session);
        JsonObject resp = parse(out.responseJson);
        assertEquals(-32602, resp.getAsJsonObject("error").get("code").getAsInt());
    }

    @Test
    void summon_drainsThroughMainThreadQueueAndReturnsGameResult() throws Exception {
        protocol.handle(initialize(1), session);
        game.clientReady.set(true);
        String call = rpc(2, "tools/call",
                "{\"name\":\"summon\",\"arguments\":{\"entity\":\"minecraft:zombie\",\"pos\":{\"x\":1,\"y\":2,\"z\":3}}}");

        // Симуляция client-tick-handler: drainer крутится в фоне и периодически
        // вызывает drainAll (как это делает loader в реальном клиенте). Запускаем
        // ДО handle(), держим до конца теста флагом, иначе он успеет выйти до
        // того, как summon положит задачу в очередь.
        java.util.concurrent.atomic.AtomicBoolean draining = new java.util.concurrent.atomic.AtomicBoolean(true);
        Thread drainer = new Thread(() -> {
            while (draining.get()) {
                queue.drainAll();
                sleepQuiet(2);
            }
        });
        drainer.setDaemon(true);
        drainer.start();

        McpProtocol.HandleOutcome out = protocol.handle(call, session);
        draining.set(false);
        drainer.join(1_000);

        JsonObject resp = parse(out.responseJson);
        assertFalse(resp.has("error"), "summon should succeed, got: " + out.responseJson);
        String text = resp.getAsJsonObject("result").getAsJsonArray("content").get(0).getAsJsonObject().get("text").getAsString();
        assertEquals("summoned minecraft:zombie at (1.0, 2.0, 3.0)", text);
        assertEquals("minecraft:zombie", game.lastSummonEntity);
        assertEquals(1.0, game.lastSummonPos.getX());
    }

    @Test
    void notificationInitialized_hasNoResponse() {
        // notification (без id) → isResponse=false.
        McpProtocol.HandleOutcome out = protocol.handle(
                "{\"jsonrpc\":\"2.0\",\"method\":\"notifications/initialized\"}", session);
        assertFalse(out.isResponse);
        assertNull(out.responseJson);
    }

    @Test
    void parseError_returnsMinus32700() {
        McpProtocol.HandleOutcome out = protocol.handle("{not valid json", session);
        assertTrue(out.isResponse);
        JsonObject resp = parse(out.responseJson);
        assertEquals(-32700, resp.getAsJsonObject("error").get("code").getAsInt());
    }

    @Test
    void methodNotFound_returnsMinus32601() {
        McpProtocol.HandleOutcome out = protocol.handle(rpc(1, "bogus/method", "{}"), session);
        JsonObject resp = parse(out.responseJson);
        assertEquals(-32601, resp.getAsJsonObject("error").get("code").getAsInt());
    }

    // --- helpers ---

    private static String initialize(int id) {
        return rpc(id, "initialize",
                "{\"protocolVersion\":\"" + McpProtocol.PROTOCOL_VERSION
                        + "\",\"capabilities\":{},\"clientInfo\":{\"name\":\"test\",\"version\":\"1\"}}");
    }

    private static String rpc(int id, String method, String paramsJson) {
        return "{\"jsonrpc\":\"2.0\",\"id\":" + id + ",\"method\":\"" + method
                + "\",\"params\":" + paramsJson + "}";
    }

    private static JsonObject parse(String json) {
        return JsonParser.parseString(json).getAsJsonObject();
    }

    private static void sleepQuiet(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /** Mock game access: записывает вызовы, возвращает предсказуемые строки. */
    private static final class MockGameAccess implements BridgeGameAccess {
        final AtomicBoolean clientReady = new AtomicBoolean(false);
        String lastSummonEntity;
        GameVector lastSummonPos;

        @Override
        public boolean isClientReady() {
            return clientReady.get();
        }

        @Override
        public String summon(String entityTypeId, GameVector pos) {
            this.lastSummonEntity = entityTypeId;
            this.lastSummonPos = pos;
            return "summoned " + entityTypeId + " at " + (pos == null ? "(player)" : pos);
        }

        @Override
        public String applyEffect(String target, String effect, int duration, int amplifier) {
            return "effect " + effect + " applied to " + target;
        }

        @Override
        public String setCamera(GameVector pos, float yaw, float pitch) {
            return "camera set " + pos;
        }

        @Override
        public String screenshot() {
            return "iVBORw0KGgo=";
        }

        @Override
        public List<GameEntitySnapshot> getState(String selector) {
            return List.of(new GameEntitySnapshot("1", "minecraft:zombie", "Zombie",
                    new GameVector(0, 0, 0), 20.0, List.of()));
        }

        @Override
        public String reloadResources() {
            return "reloaded";
        }
    }
}
