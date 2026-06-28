# mineagent-bridge

MCP-сервер (Model Context Protocol, Streamable HTTP), встроенный в dev-сборку
мода Minecraft. Поднимается **только** в окружении разработки (`runClient`),
даёт внешнему MCP-клиенту (расширению MineAgent Workbench) детерминированно
управлять живой игрой: summon мобов, накладывать эффекты, ставить камеру,
делать скриншоты, читать состояние мира, перезагружать ресурсы.

Это реализация Этапа 4 дорожной карты MineAgent. См.:
- `../docs/roadmap.md` — раздел «Этап 4».
- `../docs/source-ledger.md` — записи entry-9 … entry-12 (MCP java-sdk, dev-detection,
  registration-level disable, thread-safety).
- `../AGENTS.md` — Safety Rules и раздел «Minecraft Dev Bridge».

## Принципы (правила AGENTS.md)

1. **Только dev-окружение.** Bridge активен исключительно при `runClient`.
   В production-сборке код **не регистрируется на уровне registration**
   (не `if (!isDev) return;`, а отсутствие registration-вызова вообще), чтобы
   обфускатор/tree-shaking выкинул его. См. `entry-11` source-ledger.
2. **Localhost-only bind** (`127.0.0.1`). Случайный внешний процесс не подключится.
3. **Shared token.** Мод генерирует токен при старте и печатает в лог в
   предсказуемом формате — расширение парсит лог (`logParser.ts`) и шлёт токен
   в каждом запросе. HTTP-handler проверяет токен до enqueue.
4. **Thread-safe enqueue.** Minecraft API не потокобезопасен: все инструменты
   выполняются на client game thread через `ConcurrentLinkedQueue`, результат
   возвращается в HTTP-поток через `CompletableFuture` с таймаутом (`entry-12`).
5. **Никаких внешних зависимостей сверх Minecraft.** MCP java-sdk не
   встраивается (Servlet-SSE transport, нестабильный Streamable-HTTP-server) —
   минимальная своя реализация на JDK `com.sun.net.httpserver.HttpServer`.
   Gson уже в classpath Minecraft.

## Структура

```
mineagent-bridge/
  settings.gradle          # multi-loader include
  README.md
  common/                  # loader-agnostic: MCP-сервер, JSON-RPC, инструменты
    build.gradle
    src/main/java/dev/mineagent/bridge/common/
      Bridge.java                    # фасад lifecycle: start/stop
      BridgeConfig.java              # port, endpoint path, token, таймауты
      mcp/
        McpHttpServer.java           # JDK HttpServer, localhost, token-check
        McpProtocol.java             # JSON-RPC 2.0 wire-формат
        McpSession.java              # initialize/sessionId
      tools/
        BridgeTool.java              # интерфейс инструмента
        BridgeTools.java             # реестр + tools/list
        MainThreadQueue.java         # ConcurrentLinkedQueue + CompletableFuture
        SummonTool.java, ApplyEffectTool.java, SetCameraTool.java,
        ScreenshotTool.java, GetStateTool.java, ReloadResourcesTool.java
      game/
        BridgeGameAccess.java        # SPI: доступ к MC API (loader реализует)
        GameVector.java, GameEntitySnapshot.java
  fabric/                  # Fabric 1.21.x (Loom)
    build.gradle, settings.gradle(ignored), gradle/wrapper/
    src/main/resources/fabric.mod.json
    src/main/java/dev/mineagent/bridge/fabric/
      FabricBridgeClient.java        # ClientModInitializer + isDevelopmentEnvironment guard
      FabricGameAccess.java          # BridgeGameAccess impl поверх 1.21 client API
  neoforge/                # NeoForge 1.21.1 (ModDevGradle)
    build.gradle, gradle/wrapper/, src/main/resources/META-INF/neoforge.mods.toml
    src/main/java/dev/mineagent/bridge/neoforge/
      NeoForgeBridge.java           # @Mod(value=Dist.CLIENT)
      ClientBridgeSetup.java        # @EventBusSubscriber(Dist.CLIENT, MOD) + FMLClientSetupEvent guard
      NeoForgeGameAccess.java
  forge/                   # Forge 1.20.1 (ForgeGradle)
    build.gradle, gradle/wrapper/, src/main/resources/META-INF/mods.toml
    src/main/java/dev/mineagent/bridge/forge/
      ForgeBridge.java              # @Mod(value=Dist.CLIENT)
      ClientBridgeSetup.java        # FMLClientSetupEvent + FmlConstants.isProduction guard
      ForgeGameAccess.java
```

## Сборка и запуск (на каждый loader отдельно)

```bash
cd mineagent-bridge/fabric     # или neoforge/ или forge/
./gradlew runClient            # запускает MC dev-клиент; мод поднимает MCP-endpoint
./gradlew build                # production-jar: bridge-код вырезан registration-level
./gradlew :common:test         # JUnit-тесты (dev-detection, JSON-RPC format)
```

При старте dev-клиента мост логирует:
```
[mineagent-bridge] MCP endpoint ready at http://127.0.0.1:3100/mc-mcp token=<hex>
```
Эту строку парсит `logParser.ts` расширения и передаёт токен в `minecraftBridge.ts`.

## Wire-формат

JSON-RPC 2.0 over Streamable HTTP, как в спеке MCP 2025-11-25 (entry-6/7) —
тот же формат, что и blockbench-mcp-plugin (Этап 3), но серверная сторона:

```
initialize          → { protocolVersion, capabilities, serverInfo }
notifications/init  → (best-effort)
tools/list          → { tools: [{ name, description, inputSchema }] }
tools/call          → { content: [text|image], isError }
```

Инструменты: `summon`, `apply_effect`, `set_camera`, `screenshot`, `get_state`,
`reload_resources`. Все через main-thread enqueue.
