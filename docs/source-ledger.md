# Source Ledger — MineAgent Workbench

Журнал цитированных источников. Используется реализацией (в контексте модели и
в промтах) только через retrieval; `source: user` всегда побеждает над
`source: model`. Каждая запись — отдельный источник с краткой выжимкой того,
что из неё взято.

---

## Этап 2 — Code-MCP: Cloudflare Workers AI function-calling

Формат function-calling Workers AI **отличается от OpenAI местами** — поэтому
реализация парсит оба варианта дефензивно. MineAgent ходит на OpenAI-compat
endpoint (`/ai/v1/chat/completions`), значит основной формат — OpenAI-стандарт,
но native-формат Cloudflare тоже принимается на случай расхождений провайдера.

### entry-1 — Traditional function calling (Cloudflare, официальные docs)

- url: https://developers.cloudflare.com/workers-ai/features/function-calling/traditional/
- title: Traditional function calling · Workers AI · Cloudflare Docs
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Native REST-формат function-calling у Cloudflare:
      - Tool-схема в запросе — ПЛОСКАЯ: `{ name, description, parameters }`,
        без обёртки `{ type:"function", function:{...} }` (как у OpenAI).
      - Ответ: `response.tool_calls = [{ "arguments": {...}, "name": "..." }]` —
        плоский массив на верхнем уровне `response`, НЕ внутри `choices[0].message`.
      - Поле `arguments` — это JSON-ОБЪЕКТ напрямую, а не стримфицированная
        JSON-строка (как у OpenAI).
      - Продолжение диалога: роль `tool` с `content: JSON.stringify(res)`,
        БЕЗ `tool_call_id` (Cloudflare native его не использует).
    Цитата ответа из docs:
      [{"arguments": { "latitude": "51.5074", "longitude": "-0.1278" }, "name": "getWeather"}]
- usedFor: |
    Дефензивный парсинг tool_calls в openaiCompatibleProvider: принимать как
    OpenAI-shape (`choices[0].message.tool_calls[].function.arguments` строка),
    так и Cloudflare-native-shape (`response.tool_calls[].arguments` объект).

### entry-2 — Function calling overview (Cloudflare, официальные docs)

- url: https://developers.cloudflare.com/workers-ai/features/function-calling/
- title: Function calling · Workers AI · Cloudflare Docs
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Cloudflare различает embedded function calling (@cloudflare/ai-utils,
    runWithTools — исполняет код рядом с инференсом) и traditional
    (industry-standard, OpenAI-совместимый). Для REST-клиента MineAgent
    подходит ТОЛЬКО traditional — embedded требует Workers Binding и исполняет
    код на стороне Cloudflare (мы не можем делегировать dispatch/approval туда).
    Поддержка function-calling зависит от модели — не все модели в каталоге
    её умеют (в cloudflareProvider.ts это уже учтено полем `capabilities.tools`).
- usedFor: |
    Обоснование выбора traditional function-calling; проверка capabilities.tools
    перед передачей tools-схем в запрос.

### entry-3 — OpenAI compatible API endpoints (Cloudflare, официальные docs)

- url: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
- title: OpenAI compatible API endpoints · Workers AI · Cloudflare Docs
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Workers AI поддерживает OpenAI-compat endpoints `/v1/chat/completions` и
    `/v1/embeddings`. Base URL:
      https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1
    Именно его использует MineAgent (cloudflareProvider.ts → openaiCompatibleProvider
    с chatEndpoint="/chat/completions"). Значит на этом endpoint применяется
    OpenAI-стандарт tools/function-calling:
      - запрос: tools:[{ type:"function", function:{ name, description, parameters } }]
      - ответ: choices[0].message.tool_calls:[{ id, type:"function",
        function:{ name, arguments:"<JSON-строка>" } }]
      - результат: { role:"tool", tool_call_id, content }
- usedFor: |
    Основной формат tools-схемы и wire-формат диалога в orchestrator tool-loop.

### entry-4 — REST API get-started (Cloudflare, официальные docs)

- url: https://developers.cloudflare.com/workers-ai/get-started/rest-api/
- title: Get started - REST API · Workers AI docs
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Native execute-endpoint: POST /accounts/{id}/ai/run/{model}. Тело ответа
    обёрнуто в `{ result: { response: "..." }, success, errors, messages }`.
    На этом endpoint Cloudflare возвращает tool_calls в native-плоском формате
    (entry-1). MineAgent этот endpoint НЕ использует для чата — только
    OpenAI-compat `/v1/chat/completions`.
- usedFor: |
    Контекст, почему native-shape всё равно нужен в дефензивном парсере
    (Cloudflare может вернуть native-обёртку даже на compat-endpoint у части
    моделей).

---

## Этап 3 — Blockbench MCP-клиент

### Решение по лицензии (entry-5)

- url: https://github.com/jasonjgardner/blockbench-mcp-plugin
- title: jasonjgardner/blockbench-mcp-plugin (GitHub repo + LICENSE)
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Репозиторий распространяется под **GPL-3.0** (копилефт). По правилам
    AGENTS.md (НЕ копировать защищённый код; GPL/copyleft → свой клиент с нуля)
    MineAgent НЕ форкает и НЕ копирует исходный код плагина.
    Решение: пишем собственный MCP-клиент с нуля — только клиентская сторона
    протокола MCP (JSON-RPC over Streamable HTTP), без заимствования кода
    плагина. Имена инструментов сервера читаем через tools/list в рантайме
    (это данные, не код) — перечислять и описывать их можно.
    Связанный репозиторий blockbench-mcp-project — Apache-2.0, но это примеры
    промтов, не код клиента; на него не опираемся.

### MCP — Streamable HTTP transport (entry-6)

- url: https://modelcontextprotocol.io/specification/2025-11-25/basic/transports
- title: Transports · Model Context Protocol (spec 2025-11-25)
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    MCP v2025-11-25 определяет два транспорта: stdio и **Streamable HTTP**.
    blockbench-mcp-plugin использует Streamable HTTP (подтверждено README:
    `type: "streamableHttp"`, дефолтный URL `http://localhost:3000/bb-mcp`).
    Wire-формат Streamable HTTP:
      - Единый MCP-endpoint поддерживает POST и GET.
      - Каждый JSON-RPC message — отдельный POST. Заголовок Accept ДОЛЖЕН
        перечислять `application/json` и `text/event-stream`.
      - На request сервер отвечает либо `Content-Type: application/json`
        (одно сообщение), либо `text/event-stream` (SSE-стрим с ответом).
      - Клиент обязан поддерживать оба варианта ответа.
      - Сервер МОЖЕТ выдать `MCP-Session-Id` в ответе на Initialize; тогда
        клиент ОБЯЗАН слать этот заголовок во всех последующих запросах.
      - На каждый последующий запрос клиент ДОЛЖЕН слать заголовок
        `MCP-Protocol-Version: <negotiated>`.
      - DELETE на endpoint → terminate session (опционально, сервер может 405).
      - Локальный сервер СЛЕДУЕТ биндить только на localhost.
    MineAgent-клиент реализует: POST с Accept: application/json, text/event-stream;
    разбор как plain-JSON, так и SSE (одиночный `data: {...}`); хранение
    MCP-Session-Id и MCP-Protocol-Version; таймаут 60с.

### MCP — Lifecycle + tools/* (entry-7)

- url: https://modelcontextprotocol.io/specification/2025-11-25/server/tools
- title: Tools · Model Context Protocol (spec 2025-11-25)
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    JSON-RPC 2.0 round-trip MineAgent↔Blockbench:
      1. `initialize` { protocolVersion, capabilities, clientInfo } →
         { protocolVersion, capabilities, serverInfo }. Здесь фиксируем
         protocolVersion и (опционально) MCP-Session-Id из заголовков.
      2. `notifications/initialized` (notification, без id — best-effort).
      3. `tools/list` → { tools: [{ name, description, inputSchema }] }.
         Кэшируем; конвертируем в ToolContract с префиксом blockbench.*.
      4. `tools/call` { name, arguments } → { content: [...], isError }.
         content — массив блоков: { type:"text", text } | { type:"image",
         data:<base64>, mimeType }. isError=true → semantic-ошибка (не exception).
    Для dispatch'а в MineAgent: result.content сериализуется в строку для
    role:"tool" (text блоки склеиваются; image-блоки → отдельное поле для
    vision-передачи на Этап 5). isError=true → кладём как { error: text }.

### blockbench-mcp-plugin — transport/endpoint (entry-8)

- url: https://raw.githubusercontent.com/jasonjgardner/blockbench-mcp-plugin/main/README.md
- title: blockbench-mcp-plugin README (raw)
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Дефолтный endpoint: `http://localhost:3000/bb-mcp` (порт и путь
    настраиваются в Blockbench: Settings → General → MCP Server Port /
    MCP Server Endpoint). Transport — Streamable HTTP. MineAgent НЕ запускает
    Blockbench — подключается к уже запущенному серверу. URL хранится в
    config.mcp.blockbench.url (новое поле, backward-compat через mergeConfig).
    Plugin v1.6.0: ~106 tools, 6 prompts, 12 resources (источник: API Reference).

## Этап 4 — Minecraft Dev Bridge (MCP-сервер внутри dev-сборки мода)

### MCP java-sdk: наличие, лицензия, server-side API (entry-9)

- url: https://github.com/modelcontextprotocol/java-sdk
- url: https://central.sonatype.com/artifact/io.modelcontextprotocol.sdk/mcp
- title: modelcontextprotocol/java-sdk · Maven Central io.modelcontextprotocol.sdk:mcp
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Официальный Java SDK для MCP существует и поддерживается Anthropic
    совместно со Spring AI. Координаты Maven: `io.modelcontextprotocol.sdk:mcp`
    (umbrella) и `:mcp-core` (core-классы). Лицензия — **Apache License 2.0**
    (перmissive, дружелюбная к встраиванию; подтверждено LICENSE-файлом и
    POM в Maven Central: organization=Anthropic).
    Транспортные провайдеры SDK: STDIO и **Servlet-based SSE** (Servlet spec,
    `WebFluxSseServerTransportProvider` / servlet-SSE provider). Реализован
    также HttpClient-based SSE client. Streamable-HTTP-server-провайдер в SDK
    на момент 0.11.x был в стадии доработки (issue #386: `/mcp` streamable
    endpoint ещё не готов; `/sse` только GET).
    РЕШЕНИЕ: MineAgent НЕ встраивает MCP java-sdk в мод. Причины:
      (1) Servlet-SSE-транспорт тянет Servlet-container (Tomcat/Jetty) —
          тяжёлая зависимость для мода, который должен оставаться минимальным.
      (2) Streamable-HTTP-server-провайдер SDK ещё не стабилен.
      (3) Wire-формат JSON-RPC 2.0 + Streamable HTTP прост и полностью описан
          спекой MCP 2025-11-25 (entry-6/7) — минимальная собственная
          реализация на JDK `com.sun.net.httpserver.HttpServer` без новых deps.
    Спецификация протокола (JSON-RPC message-shapes, lifecycle, tools/*) —
    авторитет и переиспользуется дословно из entry-6/7. API minecraft.*
    берётся не из SDK, а из tools/list самого сервера в рантайме.

### Dev-environment detection — per-loader (entry-10)

- url: https://github.com/FabricMC/fabric-loader/blob/master/src/main/java/net/fabricmc/loader/api/FabricLoader.java
- url: https://docs.neoforged.net/docs/concepts/sides/
- url: https://docs.minecraftforge.net/en/1.18.x/concepts/sides/
- title: FabricLoader.java · NeoForged «Sides» · Forge «Sides»
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Детекция dev-окружения различается по loader'у:
      - **Fabric**: `FabricLoader.getInstance().isDevelopmentEnvironment()`
        (net.fabricmc.loader.api). Возвращает true в `./gradlew runClient`,
        false в релизе. Авторитетный источник — сам исходник FabricLoader.
      - **Forge / NeoForge**: `FMLEnvironment.dist` — статическое поле типа
        `net.minecraftforge.api.distensing.Dist` (`Dist.CLIENT` |
        `Dist.DEDICATED_SERVER`), физическая сторона. Это аналог
        `Level#isClientSide()`, но на уровне загрузчика.
    Все loaders различают «физическую сторону» (client vs dedicated server) и
    «логическую сторону» (isClientSide на Level). MineAgent-bridge работает
    ТОЛЬКО на клиенте: проверяем `FMLEnvironment.dist == Dist.CLIENT`
    (Forge/NeoForge) или просто встраиваем класс в client-entrypoint (Fabric).
    `isDevelopmentEnvironment()` / production-флаг используются как ДОПОЛНИТЕЛЬНЫЙ
    guard внутри клиентского setup, чтобы мост не стартовал в prod-сборке.

### Registration-level production disable (entry-11)

- url: https://docs.neoforged.net/docs/concepts/events/
- url: https://neoforged.net/news/20.2eventbus-changes/
- title: Events · NeoForged docs + Event system changes in 20.2
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    КРИТИЧНО для AGENTS.md: bridge должен быть МЁРТВЫМ кодом в production — не
    runtime-if, а registration-level, чтобы обфускатор/tree-shaking выкинул его.
    Паттерны per-loader:
      - **NeoForge/Forge**: `@Mod`-классы и `@EventBusSubscriber` принимают
        `value = Dist.CLIENT`. Аннотация НЕ регистрирует класс на dedicated
        server вообще → класс не загружается JVM → tree-shaking выкидывает.
        Для prod-guard на клиенте: event-listener (например FMLClientSetupEvent)
        проверяет `FMLEnvironment.dist == Dist.CLIENT` И production-флаг; если
        prod — НЕ создаёт HTTP-server, НЕ подписывает tick-handler. Сами
        registration-вызовы (listener-registration) выполняются только когда
        оба условия true → в prod-сборке код сервера не инстанцируется.
        Начиная с NeoForge 20.2 шины строго разделены: Forge-bus не принимает
        IModBusEvent — client-lifecycle-события (FMLClientSetupEvent и т.п.)
        идут ТОЛЬКО на mod event bus с `bus = Bus.MOD`.
      - **Fabric**: client-entrypoint (`client` в fabric.mod.json → класс
        implements `ClientModInitializer`) загружается ТОЛЬНО на клиенте.
        Внутри onInitializeClient — `FabricLoader.getInstance()
        .isDevelopmentEnvironment()` guard: в prod тело метода пустое.
        Остальной класс bridge (HTTP-server, инструменты) в отдельных классах,
        которые в prod просто не инстанцируются.
    Принцип: dev-detection + dist-restriction комбинируются, чтобы registration
    вообще не происходила в prod. Runtime-if остаётся только как второй слой
    защиты внутри registration.

### Minecraft thread-safety + main-thread scheduling (entry-12)

- url: https://docs.neoforged.net/docs/concepts/sides/
- url: https://docs.neoforged.net/docs/concepts/events/
- title: Sides + Events (NeoForged docs) — client/render thread модель
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Minecraft API НЕ thread-safe: подавляющее большинство клиентских операций
    (summon, effects, tp камеры, screenshot, get_state) обязаны выполняться на
    client game thread (render/client-tick thread). HTTP-handler бежит на
    потоке JDK HttpServer — вызывать MC API напрямую нельзя.
    Паттерн enqueue: HTTP-handler НЕ вызывает MC API, а кладёт callable в
    thread-safe очередь (`ConcurrentLinkedQueue<Runnable>`). Client-tick-handler
    (подписан на `net.neoforged.neoforge.event.tick.ClientTickEvent` /
    Forge `TickEvent.ClientTickEvent` / Fabric client-tick инжекта) в конце
    каждого client-tick дёргает все накопленные Runnable и выполняет их на
    главном клиентском потоке. Результат возвращается в HTTP-поток через
    CompletableFuture с таймаутом (instrument не должен вешать сервер).
    Для read-only операций (get_state, screenshot) тот же путь — данные тоже
    консистентны только при чтении с client thread.
    Bind: localhost-only (127.0.0.1), порт из config. Origin/token-check в
    HTTP-handler до enqueue. Инструменты ВСЕДА приходят через enqueue — даже
    «cheap reads», чтобы избежать race на карте/мире.

## Этап 5 — Vision + Critic loop

### Multimodal content-shape на OpenAI-compat endpoint (entry-13)

- url: https://developers.cloudflare.com/api/resources/ai/methods/run/index.md
- title: REST API reference — Execute AI model · Cloudflare Docs
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Cloudflare REST API reference описывает объект `ImageTextToText` для
    vision-моделей. Wire-формат messages в нём:
      messages: array of { content, role }
      content: string | array of { type, image_url?, text? }
        - type: "text" | "image_url"
        - image_url: { url: string }  — "Image URI with data
          (e.g. data:image/jpeg;base64,/9j/...)"
        - text: string (when type === "text")
    Это совпадает с каноническим OpenAI Chat Completions vision-форматом.
    MineAgent ходит на OpenAI-compat endpoint `/ai/v1/chat/completions`
    (entry-3), значит multimodal content передаётся именно так: content
    становится массивом блоков { type:"text", text } | { type:"image_url",
    image_url:{ url:"data:image/png;base64,..." } }.
    Native REST endpoint (`/ai/run/{model}`) принимает отдельное поле
    `image: string` (base64) вне messages — но MineAgent этот endpoint для
    чата НЕ использует. Запоминаем отличие на случай fallback.
    TextGeneration-объект (для text-only моделей) тоже принимает content
    как массив, но только с { type, text } — БЕЗ image_url. Vision-блоки
    можно слать ТОЛЬКО vision-capable моделям (иначе провайдер упадёт).
- usedFor: |
    Расширение ChatMessage.content до union string | ContentBlock[] в
    ProviderAdapter.ts; отправка image-блоков в openaiCompatibleProvider;
    проверка ModelCapabilities.vision перед посылкой image-блоков.

### OpenAI Chat Completions vision — канонический формат (entry-14)

- url: https://platform.openai.com/docs/guides/vision
- title: Images and vision · OpenAI API Docs
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Канонический OpenAI Chat Completions vision-формат (Cloudflare
    OpenAI-compat endpoint его принимает — entry-13):
      {
        "role": "user",
        "content": [
          { "type": "text", "text": "What is in this image?" },
          {
            "type": "image_url",
            "image_url": {
              "url": "data:image/jpeg;base64,{base64Image}"
            }
          }
        ]
      }
    - Изображения передаются как Base64-encoded data URL
      (`data:image/{format};base64,...`) или как полностью квалифицированный
      URL.
    - Несколько изображений в одном запросе — несколько блоков image_url в
      content-массиве.
    - Опциональный параметр `detail: "low" | "high" | "auto"` в image_url
      управляет разрешением обработки (low = экономия токенов).
    - Изображения считаются токенами и тарифицируются.
    MineAgent использует data URL (base64 PNG из NormalizedToolResult.images),
    detail:"low" для экономии токенов на оценочных вызовах.
- usedFor: |
    Форма ContentBlock в ProviderAdapter.ts; построение vision ChatRequest
    в visionEvaluator.ts; data-URL-префикс для base64-изображений из
    blockbench.render / minecraft.screenshot.

### Каталог vision-моделей Cloudflare и сравнение (entry-15)

- url: https://developers.cloudflare.com/workers-ai/models/index.md
- title: Workers AI Models · Cloudflare Docs
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Vision-capable модели Cloudflare Workers AI (июнь 2026) с ключевыми
    параметрами для выбора vision-оценщика MC-скринов:
    | Модель | Vision | Tools | Context | Cost | Качество |
    |---|---|---|---|---|---|
    | @cf/moonshotai/kimi-k2.7-code | Yes | Yes | 262k | high | frontier 1T |
    | @cf/meta/llama-4-scout-17b-16e-instruct | Yes | Yes | 131k | medium | natively multimodal MoE |
    | @cf/mistralai/mistral-small-3.1-24b-instruct | Yes | Yes | 128k | medium | "state-of-the-art vision" |
    | @cf/google/gemma-4-26b-a4b-it | Yes | Yes | 256k | low | strong coding |
    | @cf/meta/llama-3.2-11b-vision-instruct | Yes | No | 128k | low | basic, no tools |
    РЕШЕНИЕ для vision-оценщика по умолчанию:
      @cf/meta/llama-4-scout-17b-16e-instruct — оптимальный баланс:
      natively multimodal (лучше понимает изображения, чем "прикрученная"
      vision), supports tools (может звать blockbench.render/minecraft.screenshot
      если нужно), $0.27/M input (в ~3 раза дешевле kimi), 131k context.
      Пользователь может переключить на kimi-k2.7-code (premium) или
      llama-3.2-11b-vision-instruct (budget) через config.agent.visionModel.
    Для critic (текстовая оценка code/design-артефактов) vision НЕ нужен —
      critic = ЛЮБАЯ модель, отличная от main. По умолчанию берётся
      complexModel (если отличается от defaultModel) или явно
      config.agent.criticModel.
- usedFor: |
    Выбор дефолтной vision-модели в defaultConfig.ts (agent.visionModel);
    рекомендация critic-модели; UI-подсказки при выборе vision/critic.

## Этап 6 — Knowledge Base + Skills + Embeddings

### Cloudflare Workers AI /v1/embeddings endpoint (entry-16)

- url: https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/
- title: OpenAI compatible API endpoints · Workers AI Docs
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Cloudflare OpenAI-compat endpoint поддерживает `/v1/embeddings`
    наряду с `/v1/chat/completions`. Base URL тот же:
      https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/v1
    Запрос: { model, input: string | string[] } →
      { data: [{ embedding: number[] }], usage: { prompt_tokens } }
    Embedding-модели Cloudflare (из каталога):
      @cf/baai/bge-large-en-v1.5 — 1024 dim, BAAI, text embeddings
      @cf/baai/bge-m3 — multilingual, multi-functionality
      @cf/Qwen/qwen3-embedding-0.6b — Qwen, text embedding/ranking
    РЕШЕНИЕ: MineAgent добавляет метод embeddings() в OpenAICompatibleProvider
    и использует bge-m3 (multilingual — важно для русского проекта) для
    Knowledge Base + Skills retrieval. Embedding хранится в .mineagent/knowledge-base.json
    рядом с записью (in-memory Map при работе, persist в JSON).
- usedFor: |
    EmbeddingService для Knowledge Base retrieval и Skill matching;
    косинусное сходство для top-K выбора релевантных записей/скиллов.

### Forge documentation — структура и темы для скиллов (entry-17)

- url: https://docs.minecraftforge.net/en/1.20.x/
- title: MinecraftForge Documentation (1.20.x)
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Официальная документация Forge 1.20.x (LGPL, ссылка разрешена, текст
    НЕ копируется). Структура тем для скиллов:
      - Registries: DeferredRegister, RegistryObject
      - Sides: Dist.CLIENT / Dist.DEDICATED_SERVER, @EventBusSubscriber(value=Dist.CLIENT)
      - Events: ForgeOxfordEventBus, ModEventBus, bus=Bus.MOD/BUS.FORGE
      - Mod Lifecycle: FMLCommonSetupEvent, FMLClientSetupEvent, FMLDedicatedServerSetupEvent
      - Resources: client assets (models/textures), server data (recipes/loot/tags)
      - Data Generation: DataGen, providers (model/language/sound/recipe/loot/tag)
      - Networking: SimpleImpl, SimpleChannel, payload sync
      - Block Entities: BER, BlockEntityRenderer
      - Rendering: model extensions, render types, baked model
      - Capabilities: ICapabilityProvider, LazyOptional
    РЕШЕНИЕ: скилл forge-event-handler.md пишется СВОЙ по мотивам доков —
    паттерны регистрации event handlers, dist-restriction, bus selection.
    Без копирования текста — оригинальный контент MineAgent.
- usedFor: |
    Скилл forge-event-handler.md; проверка паттернов в AGENTS.md;
    Source Ledger entries по Forge API.

### Fabric documentation — структура и темы для скиллов (entry-18)

- url: https://docs.fabricmc.net/develop/
- title: Fabric Documentation — Developer Guides
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Документация Fabric (Creative Commons, ссылка разрешена, текст НЕ
    копируется). Структура тем для скиллов:
      - fabric.mod.json: entrypoints (main/client/server), mixins, depends
      - ClientModInitializer: onInitializeClient, isDevelopmentEnvironment guard
      - Items/Blocks: Registry.register, FabricItemSettings, FabricBlockSettings
      - Entities: attributes, mob effects, damage types
      - Data Generation: FabricDataGen, providers
      - Mixins: @Mixin, @Inject, @ModifyArg, @ModifyVariable, bytecode basics
      - Class Tweakers: access widening, interface injection, enum extension
      - Networking: ClientPlayNetworking, ServerPlayNetworking, payload
      - Rendering: GUI, HUD, world rendering, particles
      - Loom: Gradle plugin, production run tasks, classpath groups
    РЕШЕНИЕ: скилл fabric-client-entrypoint.md пишется СВОЙ —
    ClientModInitializer + isDevelopmentEnvironment guard для dev-bridge.
    Скилл mixin-application.md — общие паттерны @Mixin для Forge/Fabric.
- usedFor: |
    Скиллы fabric-client-entrypoint.md, mixin-application.md;
    проверка Fabric API паттернов в AGENTS.md.

### MCP-каталоги — нет Minecraft-specific серверов (entry-19)

- url: https://mcp.so/
- url: https://glama.ai/mcp/servers
- title: MCP.so + Glama MCP Registry (47k+ servers)
- source: model
- status: accepted
- addedAt: 2026-06-23
- learned: |
    Из 47k+ MCP-серверов в двух крупнейших каталогах НЕТ ни одного
    Minecraft-specific сервера. Есть общие (filesystem, github, fetch,
    postgres, puppeteer) — но они перекрываются существующими инструментами
    MineAgent (repo.read/patch, web.research).
    РЕШЕНИЕ: Этап 6 НЕ добавляет новых MCP-серверов. Сосредотачиваемся на:
      (1) Knowledge Base (RAG через embeddings) — замена Source Ledger v1
      (2) Skills-механизм (markdown + авто-matching) — создание через ИИ
      (3) Готовые скиллы на основе Forge/Fabric доков
    Потенциальные MCP-идеи на будущее (не в этом этапе):
      - Mappings MCP (Mojmap/Yarn/MCP mappings search)
      - CurseForge/Modrinth MCP (поиск модов-зависимостей)
      - Forge/Fabric Docs MCP (индексированные доки с поиском)
- usedFor: |
    Обоснование отказа от новых MCP-серверов в Этапе 6; фокус на
    Knowledge Base + Skills вместо MCP.
