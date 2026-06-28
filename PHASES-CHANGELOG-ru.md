# MineAgent Workbench — Реализация Фаз 1–5 (до v0.1 beta)

> Среда сборки PromptQL — только Python-песочница: **Node/tsc/npm недоступны**, поэтому
> компиляция и тесты выполняются на вашей стороне. Все правки сделаны строго в рамках
> существующих контрактов TypeScript. Где доводка требует сборки/ручной проверки — это
> явно помечено **[требует сборки]** или **[скелет]**.
>
> Применяйте поверх исходного дерева. Изменённые/добавленные файлы перечислены ниже.

## Как проверить

```bash
npm install            # +1 новая зависимость: @xenova/transformers (см. Фаза 2.2)
npm run compile        # tsc — основная проверка (компилятора в PromptQL нет)
npm test               # особенно orchestrator.test.ts, toolLoop*.test.ts
```

---

## Фаза 1 — Надёжные провайдеры

### [P1.1] Убран тихий фоллбэк выбора модели — **сделано**
`orchestrator.ts → selectModelCandidates`: при явно выбранной модели возвращается
**ровно один кандидат** (`return [configuredModel.trim()]`), без подмешивания чужих
моделей. «Выбор модели священен». (Эта правка была применена ещё в Фазе 1-части.)

> Доводка разделения ошибок transient/hard (retry той же модели vs СТОП+вопрос) —
> логика повтора на сетевых сбоях уже есть в провайдере; UI-событие выбора
> «повторить / другая модель / отменить» подключается на Фазе 4 (модалки). **[требует UI]**

### [P1.2] Замок модели — **сделано (модель данных + дефолт)**
- `config/types.ts`: добавлено `providers.lockModel?: boolean`.
- `config/defaultConfig.ts`: `lockModel: false`.
- Семантика: `true` ⇒ auto-tiering (`routineModel`/`complexModel`) игнорируется,
  отвечает только выбранная модель. Точку чтения флага в tiering-резолвере
  оркестратора подключить одной проверкой (snippet в конце документа). **[требует 1 строку в orchestrator]**

### [P1.3] Capability-резолвер — **сделано (новый модуль)**
Новый `src/providers/capabilityResolver.ts`:
- `resolveCapability(modelId, models, need)` → `{ ok, missing[], alternatives[] }`.
  Проверяет tools/vision/jsonMode/контекст. НЕ подменяет модель — возвращает
  структурированный вердикт с альтернативами для UI-вопроса.
- `supportsEffort(modelId, models)` — гейт для P1.5.
- Добавлено `ModelCapabilities.effortLevels?: boolean` (`ProviderAdapter.ts`).

> Точка вызова: перед запуском tool-loop/vision вызвать `resolveCapability`; при
> `ok=false` — эмитить событие выбора вместо тихого продолжения. **[требует подключения в orchestrator/webview]**

### [P1.4] Preflight-проба — **сделано (новый модуль)**
Новый `src/providers/preflightProbe.ts`:
- `PreflightProbe.probe(provider, modelId)` — крошечный `chat` ("ping", maxTokens 8),
  кэширует РЕАЛЬНЫЕ возможности: `alive` (ответила без ошибки) и `respondsText`
  (вернула непустой контент — ловит «молчунов» glm-vision / qwen-без-backend).
- `annotate(models)` — помечает битые модели `deprecated:true` поверх «врущего» `/models`.
- TTL кэша 1 час; `invalidate()`.

> Подключение: при выборе модели в UI вызвать `probe`, на каталог моделей наложить
> `annotate`. **[требует подключения в providerRegistry/webview]**

### [P1.5] reasoning_effort — **сделано**
- `ProviderAdapter.ts → ChatRequest`: добавлено `reasoning_effort?: "low"|"medium"|"high"`.
- `openaiCompatibleProvider.ts`: поле проброшено в тело запроса (`undefined` ⇒ не
  сериализуется ⇒ безопасно для провайдеров без поддержки).
- `orchestrator.ts`: новый `resolveReasoningEffort(isReasoning)` — шлёт effort
  **только reasoning-моделям** и только если задан `config.agent.reasoningEffort`.
  Подключён в `singleChat` и `runToolLoop`.
- `config/types.ts`: `agent.reasoningEffort?: "low"|"medium"|"high"` (по умолчанию не задан).

### [P1.6] Anthropic tools + vision — **сделано**
`src/providers/anthropicProvider.ts` переписан целиком: Messages API tools
(OpenAI→Anthropic конверсия схемы) + `tool_use`/`tool_result`, vision (base64
image-блоки), честный `listModels()` (`GET /v1/models`, `jsonMode:false`),
реальный `validateKey()`, парсинг usage, `ProviderRequestError`. (Применено в Фазе 1-части.)

---

## Фаза 2 — Память (3 слоя) + Web-RAG

### [P2.1] ИИ-индекс (третий слой памяти) — **сделано (новый модуль)**
Новый `src/memory/workspaceIndex.ts`:
- `WorkspaceIndexer(root, provider, model)` — модель индекса задаётся отдельно от
  модели работы.
- `build(files, onProgress, signal)` — **инкрементально по sha1** файла: конспект
  на файл (что делает / что регистрирует / зависимости / точки расширения) + общая
  карта архитектуры. Хранит `.mineagent/workspace-index/index.json`. Сброс кэша при
  смене модели индекса.
- `indexAgeMs(root)` — возраст индекса для UI.

> Подключение кнопки «Проиндексировать с ИИ» + прогресс/возраст в UI — Фаза 4. **[требует UI]**

### [P2.2] Локальные оффлайн-embeddings — **сделано (новый модуль)**
Новый `src/providers/localEmbeddingProvider.ts`:
- `LocalEmbeddingProvider` реализует контракт `ProviderAdapter.embeddings()`, поэтому
  существующий `EmbeddingService` и `KnowledgeBaseService` работают поверх него **без
  изменений** (раньше у kimchi не было embeddings → semantic ranking отключался).
- Модель `Xenova/bge-m3` (multilingual — важно для русского) через `@xenova/transformers`
  (ONNX, оффлайн после первой загрузки весов), mean-pooling + normalize.
- **Новая зависимость:** добавьте в `package.json` →
  `"dependencies": { "@xenova/transformers": "^2.17.2" }`. Импорт динамический
  (грузится только при использовании). **[требует npm install]**

> Подключение: передать `new LocalEmbeddingProvider()` в `EmbeddingService` при
> отсутствии провайдерских embeddings, и поднять `config.agent.knowledgeTopK` (напр. 5),
> чтобы RAG включился. **[требует подключения в webview + смена дефолта по желанию]**

### [P2.3] memory.note tool — **сделано**
- Контракт `memory.note` (`ToolContracts.ts`, risk `write`, без approval) + wire-схема
  (`toolSchemas.ts`) + добавлен в `TOOL_LOOP_TOOLS`.
- Handler в `MineAgentWebviewProvider.ts`: пишет в `project.md` через
  `ProjectMemoryService.appendToSection(section, text, "agent")` (секции
  conventions/content/decisions/open, по умолчанию decisions).

### [P2.4 / P2.5] Реальный веб-поиск вместо DuckDuckGo Instant Answer — **сделано**
Новый `src/tools/webSearch.ts`:
- `webSearch(query, { mode, firecrawlApiKey, limit })`:
  - `"free"` (по умолчанию): **DuckDuckGo HTML** (`POST html.duckduckgo.com/html`,
    браузерный User-Agent, парсинг органической выдачи + раскодирование `uddg=`
    редиректов) — реальные ссылки и сниппеты вместо пустого Instant Answer.
  - `"full"`: **Firecrawl** `/v1/search` (поиск + markdown-скрейп). Ключ —
    `FIRECRAWL_API_KEY` из окружения (не в коде/конфиге). Мягкий фоллбэк full→free.
  - `parseDuckDuckGoHtml(html, limit)` экспортирован для юнит-теста на фикстуре.
- `config/types.ts`: `agent.webSearchMode?: "free"|"full"`, дефолт `"free"`.
- `MineAgentWebviewProvider.ts → handler "knowledge.search"`: DuckDuckGo Instant
  Answer заменён на `webSearch()`.

> Старые помощники `researchWeb`/`searchViaModel` (вкладка research ledger) всё ещё
> используют прежний путь — их можно перевести на `webSearch()` тем же образом
> (оставлено, чтобы не трогать UI-поведение вкладки). **[опциональная доводка]**

---

## Фаза 3 — Git / GitHub — **сделано**

Новые `src/tools/gitTools.ts` и `src/tools/githubTools.ts`:
- `GitTools(root)`: `status / branchList / createBranch / checkout / commit / add /
  push / pull / currentBranch` → `CommandEvidence` (как gradleTools). Аргументы
  передаются отдельными элементами `argv` (без shell-инъекции).
- `GitHubTools.clone(url, dir, targetDir?)` → `CommandEvidence`;
  `GitHubTools.createPullRequest({owner,repo,title,head,base,body,token})` → PR через
  GitHub REST. Токен из `GITHUB_TOKEN` (окружение), не в конфиге.
- Контракты + схемы: `git.status` (read), `git.commit/branch/checkout/push/pull`
  (command, approval), `github.clone` (command, approval), `github.pr` (network,
  approval), — всё опасное идёт через `ApprovalGate` (это обеспечивает
  `requiresApproval:true` + `ToolDispatcher`). Handlers зарегистрированы в webview.
- В `TOOL_LOOP_TOOLS` добавлены безопасные `git.status` и `memory.note`; остальные
  git/github-операции доступны через dispatcher/UI и approval (не авто-предлагаются
  модели в каждом запросе — «не жечь токены» + безопасность).

---

## Фаза 4 — UI: глобальная переработка — **частично: спека + точки интеграции**

Полный реврайт webview (`MineAgentWebviewProvider.ts` 70 КБ + `media/mineagent.js`
74 КБ + `media/mineagent.css` 36 КБ + `html.ts`) **невозможно надёжно довести без
локальной сборки и визуальной проверки**. Поэтому здесь:
- Детальная UI-спека для реализации: `docs/ui-spec-v0.1.md` (добавлена в архив) —
  каркас/тёмная тема/состояния, слэш-«/»-палитра функций, селекторы модели+effort,
  индикатор активной модели + замок, панели Память/Знания/Git/Индекс, модалки
  подтверждения смены модели и опасных действий.
- Backend под UI уже готов этими фазами: capability-вердикты (P1.3), preflight (P1.4),
  effort (P1.5), индекс/возраст (P2.1), git-операции (P3), memory.note (P2.3).

**[требует реализации фронтенда + сборки]**

---

## Фаза 5 — Встроенные MCP + Skills + онбординг + релиз — **частично: каркас готов, доводка по шагам**

- **MCP-мосты уже в коде** (`mcp/blockbenchBridge.ts`, `mcp/minecraftBridge.ts`,
  `mcp/mcpClient.ts`) и конфиг (`config.mcp.blockbench` / `config.mcp.minecraft`,
  по умолчанию `enabled:false`). Доводка: проверить подключение к живому Blockbench
  (порт 3000) и dev-bridge мода (порт 3100, токен из лога) на реальном окружении,
  задать дефолт-онбординг. **[требует ручной проверки на запущенном Blockbench/клиенте]**
- **Skills**: сервис `skills/skillService.ts` есть; включается через
  `config.agent.skillsTopK > 0` (по умолчанию 0). Доводка: UI-панель + предзаполнить
  рецептами (добавить предмет/блок). **[требует UI + контент]**
- **Онбординг-мастер** (провайдер + ключ + модель на первый запуск): спроектирован в
  `docs/ui-spec-v0.1.md`. **[требует UI]**
- **Сборка .vsix**: `npm install -g @vscode/vsce && npm run compile && vsce package`
  → `mineagent-workbench-0.1.0.vsix`. Тег `v0.1-beta` после зелёных тестов.

---

## Сводка изменённых/добавленных файлов

**Добавлены:**
- `src/providers/capabilityResolver.ts` (P1.3)
- `src/providers/preflightProbe.ts` (P1.4)
- `src/providers/localEmbeddingProvider.ts` (P2.2)
- `src/memory/workspaceIndex.ts` (P2.1)
- `src/tools/webSearch.ts` (P2.4/P2.5)
- `src/tools/gitTools.ts` (P3)
- `src/tools/githubTools.ts` (P3)
- `docs/ui-spec-v0.1.md` (Фаза 4 спека)

**Изменены:**
- `src/providers/anthropicProvider.ts` (P1.6, полная перезапись)
- `src/providers/ProviderAdapter.ts` (`ChatRequest.reasoning_effort`, `ModelCapabilities.effortLevels`)
- `src/providers/openaiCompatibleProvider.ts` (проброс `reasoning_effort`)
- `src/orchestrator/orchestrator.ts` (P1.1 selectModelCandidates + P1.5 resolveReasoningEffort)
- `src/config/types.ts` (`providers.lockModel`, `agent.reasoningEffort`, `agent.webSearchMode`)
- `src/config/defaultConfig.ts` (`lockModel:false`, `webSearchMode:"free"`)
- `src/tools/ToolContracts.ts` (git.*, github.*, memory.note контракты)
- `src/tools/toolSchemas.ts` (схемы git.*/github.*/memory.note + TOOL_LOOP_TOOLS)
- `src/webview/MineAgentWebviewProvider.ts` (регистрация git/github/memory handlers; веб-поиск → webSearch)

## Вторая итерация — точки подключения вшиты в код (без сборки) — **сделано**

Ранее модульные правки Фазы 1–2 теперь подключены к реальным call-site'ам
(всё типобезопасно, без Node/tsc):

### [P1.2] Замок модели реально отключает auto-tiering — **сделано**
`orchestrator.ts → tierModelForMode`: в начале добавлено
```ts
if (providers.lockModel) {
  return providers.defaultModel; // замок — auto-tiering выключен
}
```
Поле `providers.lockModel` уже есть в `config/types.ts` (P1.2) и `defaultConfig.ts` (`false`).

### [P1.3] Capability-уведомление вместо тихого fallback — **сделано**
`orchestrator.ts → askConfiguredModel`: если инструменты зарегистрированы
(`dispatcher` + TOOL_LOOP_TOOLS/подключённый MCP-bridge), а у выбранной модели
`capabilities.tools === false`, в чат шлётся явное предупреждение
(«модель не поддерживает tools, отвечаю обычным chat») — модель больше «не молчит».

### [P2.2] Локальный RAG включён по умолчанию — **сделано**
- `embeddingService.ts`: источник embeddings теперь — структурный интерфейс
  `EmbeddingCapableProvider` (`embeddings?(req): Promise<EmbeddingResponse>`), которому
  удовлетворяет и `ProviderAdapter`, и `LocalEmbeddingProvider` (без реализации
  chat/listModels/validateKey).
- `MineAgentWebviewProvider.ts`: если у провайдера нет embeddings (как у [kimchi](<wiki://kimchi>)) —
  fallback на `new EmbeddingService({ provider: new LocalEmbeddingProvider() })`.
- `defaultConfig.ts`: `knowledgeTopK` 0 → **5**, чтобы retrieval Knowledge Base
  включился из коробки.
- Зависимость `@xenova/transformers` (оффлайн bge-m3) добавить при `npm install` (см. Фаза 2.2).

### P1.4 (preflightProbe) — намеренно on-demand
Прогон микро-пробы по всем моделям сразу сжигал бы токены (правило «не жечь токены»),
поэтому `preflightProbe.ts` остаётся модулем для вызова при ручном выборе модели в UI
(см. `docs/ui-spec-v0.1.md`), а не запускается на каждом списке моделей.