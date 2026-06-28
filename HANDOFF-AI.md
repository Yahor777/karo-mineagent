＜ПЕРЕДАЧА ПРОЕКТА ДРУГОМУ ИИ — ПРОЧТИ ПОЛНОСТЬЮ ПЕРЕД РАБОТОЙ＞

Ты продолжаешь разработку расширения VS Code «MineAgent Workbench» — воркбенч для
создания модов Minecraft (Forge/Fabric/NeoForge) с ИИ-ассистентом. Язык интерфейса и
системных промптов — русский. Отвечай и комментируй код по-русски.

== ЧТО ЭТО ==
TypeScript-расширение VS Code. Возможности: индексация репозитория (ProjectMap),
Gradle-раны, tool-loop («руки» — модель вызывает инструменты), vision (скриншоты/рендеры),
база знаний с RAG, skills, sub-agents, MCP-мосты к Blockbench и к dev-сборке Minecraft.
Сборка: `npm install && npm run compile` (tsc → out/). Тесты: `npm test`
(node --test out/test/*.test.js). Пакет: `npm run package` (@vscode/vsce → .vsix).

== ТЕКУЩЕЕ СОСТОЯНИЕ (уже сделано, компилируется) ==
1. Живая память проекта (Фаза 1): src/memory/projectMemory.ts + types.ts. Файл
   .mineagent/project.md ведётся агентом и подмешивается ПЕРВЫМ в контекст каждого запроса.
   Провайдеро-независимо (просто текст, без embeddings). Разделы: идентичность (auto),
   конвенции, контент, решения, открытые вопросы, журнал задач (auto). Идемпотентный
   syncIdentity, дедуп appendToSection, журнал appendRunLog. Интегрировано в orchestrator
   (run() грузит память, syncIdentity из ProjectMap, дописывает журнал; createChatMessages
   кладёт блок памяти первым) и в webview. Тесты: test/projectMemory.test.ts (6/6 зелёных).
   Дизайн: docs/phase1-memory-design.md.
2. КРИТИЧЕСКИЙ ФИКС kimchi: kimchi/castai за Cloudflare блокирует запросы без браузерного
   User-Agent (403 / "error code: 1010"). В src/providers/openaiCompatibleProvider.ts метод
   headers() теперь шлёт браузерный User-Agent + Accept. БЕЗ ЭТОГО РАСШИРЕНИЕ НЕ РАБОТАЕТ.
   Проверено вживую: listModels=12, chat, vision (minimax-m3, kimi-k2.6/2.7), tools, json — OK.
3. Упаковка: docs/INSTALL-ru.md, скрипт npm run package, .vscodeignore настроен.

== ПРОВАЙДЕРЫ: АУДИТ И ДЫРЫ (важно) ==
- ProviderId: openai, anthropic, fireworks, cloudflare, wavespeed, custom.
  "kimchi" = провайдер custom (OpenAI-совместимый). Base URL https://llm.kimchi.dev/openai/v1
  (/models, /chat/completions). defaultProvider=custom, defaultModel=kimi-k2.7.
- kimchi-модели: minimax-m2.7/m2.5/m3, kimi-k2.5/k2.6/k2.7, qwen3-coder-next-fp8,
  glm-5.2-fp8, nemotron-3-super/ultra-fp4, smollm2-135m/360m. EMBEDDINGS НЕТ.
- ДЫРА: qwen3-coder-next-fp8 есть в /models, но при вызове 400 "no registered providers".
- ДЫРА: glm-5.2-fp8 на vision-запрос молча отдаёт ПУСТОЙ content (он не vision).
- ДЫРА: AnthropicProvider СЛОМАН — не шлёт request.tools и не парсит tool_calls (tool-loop с
  Claude не работает), vision image_url не конвертируется в формат Anthropic. listModels=1
  захардкоженная, validateKey фейковый. Хотя capability рапортует tools:true, vision:true.
- CloudflareProvider OK (делегирует в OpenAICompatible, наследует tools+vision+embeddings+UA).
- ДЫРА: knowledge.search (флагманский веб-RAG) использует DuckDuckGo Instant Answer API
  (api.duckduckgo.com) — он почти всегда пустой для технических запросов → заметки пустые.
- ДЫРА: Git — только git.diff + git apply (repo.patch). Нет commit/branch/push/clone/PR/GitHub API.

== СОГЛАСОВАННЫЕ ПРИНЦИПЫ (соблюдай строго) ==
1. ВЫБОР МОДЕЛИ СВЯЩЕНЕН. Запрещена тихая смена модели. Сетевой сбой (429/5xx/таймаут) →
   авто-повтор НА ТОЙ ЖЕ модели. Смена модели (model-not-found / нет capability / контекст
   не влез) → ОСТАНОВИТЬСЯ и спросить пользователя: «повторить / выбрать другую / отменить».
   Никогда не выбирать модель за пользователя. (Сейчас selectModelCandidates делает тихий
   фоллбэк — это надо убрать.) Плюс замок модели (отключает авто-тиринг), всегда показывать
   какая модель отвечала.
2. Память = 3 слоя: (а) быстрый структурный индекс RepoIndexer (есть); (б) ИИ-индекс по кнопке
   с выбором провайдера+модели (модель индекса ≠ модель работы), конспект на файл/класс +
   карта архитектуры, инкрементально по хэшу, кэш в .mineagent/workspace-index/; (в) RAG-возврат
   с локальными embeddings. ИИ-индекс кормит И память, И RAG.
3. Веб-поиск: реальный через Firecrawl (поиск+скрейп→конспект→ссылки+заметки) + бесплатный режим
   на DuckDuckGo HTML-результатах (не Instant Answer), переключатель экономный/полный.
4. Минусы каждого провайдера нивелировать единым capability-резолвером + preflight-пробой
   (крошечный пробный запрос при выборе модели, кэш реальных возможностей — гасит врущий /models).
5. effort (reasoning_effort low/medium/high) для моделей с reasoning — в ChatRequest, проброс в
   openaiCompatible, гейт только для reasoning-моделей, выбор в UI.
6. UI — глобальная переработка (сейчас «убогий»). Слэш "/" = палитра всех функций.
7. «Не жечь токены»: не пихать весь воркспейс в контекст — только релевантное через RAG.

== ПЛАН ДО v0.1 BETA (полностью в docs/roadmap-v0.1-beta.md) ==
Фаза 1 Надёжные провайдеры: убрать тихий фоллбэк (подтверждение смены модели), замок модели,
  capability-резолвер, preflight-проба, effort, дописать Anthropic tools+vision.
Фаза 2 Память 3 слоя + Web-RAG: ИИ-индекс по кнопке (инкрементальный кэш), локальные embeddings
  (transformers.js/fastembed, bge-m3, оффлайн), memory.note (агент сам пишет находки), реальный
  поиск Firecrawl + бесплатный DuckDuckGo-режим.
Фаза 3 Git/GitHub: status/commit/branch/checkout/push/pull, clone, PR (GitHub API, токен в
  SecretStorage), опасное — через ApprovalGate с превью.
Фаза 4 UI глобально: новый каркас, тёмная тема, состояния, гуманизация ошибок, слэш "/"-палитра,
  селекторы модели+effort + индикатор активной модели + замок, панели Память/Знания/Git/Индекс,
  нормальные модалки подтверждения.
Фаза 5 Встроенные MCP (Blockbench, Minecraft Dev Bridge — довести до «из коробки») + Skills
  (включить, UI, рецепты) + онбординг-мастер + сборка .vsix + тег v0.1 beta.
Порядок: 1 → 2 → 4(каркас рано) → 3 → 5.

== КАРТА КЛЮЧЕВЫХ ФАЙЛОВ ==
- Сборка контекста/промпта: src/orchestrator/orchestrator.ts → createChatMessages() (~стр.1010).
  Конструктор оркестратора принимает projectMemory последним параметром.
- Индексатор: src/repo/repoIndexer.ts → ProjectMap (src/repo/projectMap.ts).
- Провайдеры: src/providers/{ProviderAdapter.ts, openaiCompatibleProvider.ts, anthropicProvider.ts,
  cloudflareProvider.ts, embeddingService.ts, providerRegistry.ts, tokenBudget.ts}.
- Память: src/memory/{projectMemory.ts, types.ts}.
- База знаний: src/knowledge/{knowledgeBase.ts, types.ts}.
- Инструменты: src/tools/{toolSchemas.ts, ToolContracts.ts, toolDispatcher.ts, toolRegistry.ts,
  repoReadTools.ts, gradleTools.ts, logParser.ts, buildDiagnostics.ts}.
- Сессии: src/session/sessionService.ts. Конфиг: src/config/{types.ts, defaultConfig.ts}.
- UI (webview): src/webview/{MineAgentWebviewProvider.ts, html.ts}, media/{mineagent.css, mineagent.js}.
  Оркестратор создаётся в MineAgentWebviewProvider (~стр.837), tool-handlers в registry (~стр.116-218),
  knowledge.search handler (~стр.171, сейчас DuckDuckGo). Точка входа: src/extension.ts.
- MCP: src/mcp/{blockbenchBridge.ts, minecraftBridge.ts, mcpClient.ts, mcpServer.ts}.

== КОНВЕНЦИИ ==
- ВНИМАНИЕ к переводам строк: src/orchestrator/orchestrator.ts использует CRLF (\r\n);
  большинство остальных — LF. При правках сохраняй существующий стиль файла, иначе грязный diff.
- Данные расширения — в .mineagent/ в воркспейсе. Секреты — в VS Code SecretStorage, не в файлах.
- Не выдумывай Minecraft API — если не уверен, отметь как «проверить в источниках».
- В системном промпте уже есть правила формата ответа (без markdown-мусора, по-русски).
- Предсуществующие падения тестов (config visionModel, toolSchemas, bridges, tool-loop cap) —
  НЕ связаны с памятью, были до изменений. Память: 6/6 зелёных.

== С ЧЕГО НАЧАТЬ ==
1. Распакуй архив, `npm install`, `npm run compile`, `npm test`.
2. Начни с Фазы 1 (безопасность провайдеров — самый опасный баг: тихий фоллбэк).
3. Для проверки kimchi нужен браузерный User-Agent (см. выше) и API-ключ; embeddings у kimchi нет.
4. После каждой фазы: компиляция + тесты + пересборка .vsix.
＜КОНЕЦ ПЕРЕДАЧИ＞
