# MineAgent Workbench — Developer Handoff

A VS Code extension that gives an AI "hands" to develop Minecraft mods (read code,
build, diagnose errors, edit, and interact with the game) — focused on NeoForge.

## What's in this archive
Source only. Build output, dependencies, design assets, caches, runtime data and
example mod workspaces are intentionally excluded. Run `npm install` to restore deps.

```
src/            extension source (TypeScript)
test/           tests
schemas/        JSON schemas for config / tool contracts
scripts/        build & packaging scripts
docs/           documentation
media/          extension icons/assets
mineagent-bridge/  in-game bridge component
.vscode/        launch + tasks (F5 = Run Extension)
package.json, tsconfig.json, AGENTS.md, README.md
```

## Prerequisites
- Node.js 18+ and npm
- VS Code 1.90+
- (optional) Java/Gradle toolchain to actually build mods the AI works on

## Get running
```bash
npm install
npm run compile        # tsc -> out/src/extension.js
```
Then open the folder in VS Code and press **F5** ("Run Extension") to launch the
Extension Development Host with MineAgent loaded.

## LLM provider (important)
Config is read from the workspace file `.mineagent/config.json` (NOT VS Code
settings). The project is wired to an OpenAI-compatible provider ("custom"):

```json
{
  "providers": {
    "defaultProvider": "custom",
    "defaultModel": "kimi-k2.7",
    "custom": {
      "baseUrl": "https://llm.kimchi.dev/openai/v1",
      "chatEndpoint": "/chat/completions",
      "modelsEndpoint": "/models"
    }
  }
}
```

API key is supplied **out-of-band** (never commit it):
- env var `MINEAGENT_CUSTOM_API_KEY`, or
- command palette: **"MineAgent: Set Provider API Key"** (stored in VS Code SecretStorage)

Vision (image analysis) is available on the provider via models `minimax-m3` /
`kimi-k2.6`. There is **no embedding model**, so embedding-dependent features
(semantic knowledge-base ranking) are disabled by default.

## Architecture (quick map)
- Tool registry / dispatcher with declared contracts (approval-gated).
- Orchestrator `runToolLoop` drives the model; it includes a **forced
  finalization** turn (`tool_choice:"none"`) so reasoning models always return a
  final answer instead of looping on tool calls.
- Memory: `src/session/sessionService.ts` (per-session chat persistence with secret
  redaction) and `src/knowledge/knowledgeBase.ts` (project knowledge base).

## Known state / TODO
- ~9 of 22 tool contracts have live handlers; the rest are roadmap (Blockbench MCP,
  game control bridge). See AGENTS.md and docs/.
- `.vscodeignore` should exclude `out/screenshots/*` before packaging a .vsix.
