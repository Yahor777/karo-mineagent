# MineAgent Workbench — установка и использование (kimchi)

## Установка готового расширения (.vsix)
1. В VS Code: вкладка Extensions (Ctrl+Shift+X) → меню «…» вверху панели →
   **Install from VSIX…** → выбери `mineagent-workbench-0.1.0.vsix`.
   (Или из терминала: `code --install-extension mineagent-workbench-0.1.0.vsix`.)
2. Открой папку своего мода: File → Open Folder.
3. Открой панель MineAgent (иконка в Activity Bar слева).

## Ввод ключа kimchi
1. Палитра команд (Ctrl+Shift+P) → **MineAgent: Set Provider API Key** → выбери **custom**.
2. Base URL оставь по умолчанию: `https://llm.kimchi.dev/openai/v1`
   (models endpoint `/models`, chat endpoint `/chat/completions`).
3. Вставь свой kimchi API key. Ключ хранится в VS Code SecretStorage, не в файлах проекта.

Провайдер по умолчанию уже = custom (kimchi), модель по умолчанию `kimi-k2.7`
(routine `minimax-m2.7`, complex `kimi-k2.7`). Всё это можно сменить в
`.mineagent/config.json` или настройках расширения.

Проверка связи: палитра → **MineAgent: Test Configured Provider**.

## Важно: почему раньше kimchi мог не отвечать
kimchi/castai стоит за Cloudflare и блокирует запросы без браузерного `User-Agent`
(ответ `403`, `error code: 1010`). В этой сборке провайдер
(`src/providers/openaiCompatibleProvider.ts`) теперь шлёт браузерный `User-Agent`
и `Accept` — без этого фикса расширение не получало ответов. Проверено на живом
эндпоинте: listModels (12 моделей), chat и validateKey работают.

Доступные модели kimchi: minimax-m2.7, minimax-m2.5, minimax-m3, kimi-k2.5,
kimi-k2.6, kimi-k2.7, qwen3-coder-next-fp8, glm-5.2-fp8, nemotron-3-super-fp4,
nemotron-3-ultra-fp4, smollm2-135m, smollm2-360m. Embeddings у kimchi НЕТ —
поэтому семантический RAG выключен, а память проекта работает на тексте (см. ниже).

## Память проекта (Фаза 1 — «не забывать ничего»)
При первом запросе агента в воркспейсе появляется `.mineagent/project.md` —
долговременная память, которую агент ведёт сам и подмешивает в начало контекста
каждого запроса. Провайдеро-независима (просто текст, без embeddings).
- Идентичность мода (loader/MC/Java/modId), конвенции (DeferredRegister, GeckoLib…),
  добавленный контент, решения, открытые вопросы, журнал задач.
- Разделы «Конвенции/Контент/Решения/Открытые вопросы» можно править вручную —
  агент сохраняет правки. Файл открывается как обычный markdown.
Подробности дизайна и план развития памяти — в `docs/phase1-memory-design.md`.

## Сборка из исходников
```
npm install
npm run compile      # tsc → out/
npm test             # node --test (память: 6/6 зелёных)
npm run package      # собрать .vsix (нужен @vscode/vsce, уже в devDependencies)
```
Для отладки: открой папку расширения в VS Code и нажми F5 (Extension Development Host).
