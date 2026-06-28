# MineAgent Workbench Architecture

## Product Shape

MineAgent Workbench is a VS Code extension for Minecraft Java mod development. It deliberately focuses on modding tasks instead of becoming a universal AI IDE.

The first user experience is a docked workbench panel similar in workflow to Copilot Chat or Qoder: sessions on the left, tabs on top, a composer at the bottom, and evidence/results in the main surface. The visual system is original and Minecraft-inspired: dark stone/deepslate surfaces, compact pixel borders, inventory-slot chips, and restrained emerald, redstone, lapis, grass, gold, and enchanted-glow accents.

## Runtime Layers

1. VS Code extension host
   - Registers Activity Bar container, webview view, commands, SecretStorage, workspace config, and Gradle/Minecraft process helpers.

2. Webview UI
   - Renders tabs: Chat, Runs, Lab, References, Rules, Skills, Providers.
   - Sends command messages to the extension host.
   - Receives project maps, provider statuses, run reports, log summaries, and command evidence.

3. Core services
   - `ConfigService`: workspace files and provider secrets.
   - `ProviderRegistry`: provider adapter selection.
   - `RepoIndexer`: Minecraft-aware repository map.
   - `GradleTools`: Gradle build and runClient command evidence.
   - `ReferenceEngine`: cited reference pack data model.
   - `MineAgentOrchestrator`: single orchestrator with explicit run phases.

4. Tool contracts
   - Tool boundaries live in `src/tools/ToolContracts.ts`.
   - Commands that write, run Gradle, launch Minecraft, control the game, or use network research require approval.

## File Tree

```text
.
|-- AGENTS.md
|-- README.md
|-- package.json
|-- tsconfig.json
|-- schemas/
|   `-- config.schema.json
|-- docs/
|   |-- architecture.md
|   |-- mvp-plan.md
|   |-- provider-contracts.md
|   |-- tool-contracts.md
|   `-- ui-design-system.md
|-- media/
|   |-- mineagent.css
|   |-- mineagent-icon.svg
|   `-- mineagent.js
|-- scripts/
|   `-- validate-json.mjs
|-- src/
|   |-- extension.ts
|   |-- config/
|   |-- orchestrator/
|   |-- providers/
|   |-- reference/
|   |-- repo/
|   |-- tools/
|   `-- webview/
`-- test/
    |-- logParser.test.ts
    `-- repoIndexer.test.ts
```

## Workspace Data

MineAgent owns these project-local files:

- `AGENTS.md`
- `.mineagent/config.json`
- `.mineagent/skills/**`
- `.mineagent/reference-packs/**`
- `.mineagent/playtests/**`
- `.mineagent/runs/**`

Provider keys are never written to these paths. They are stored in VS Code SecretStorage under workspace-scoped keys.

## Orchestration

MineAgent uses one orchestrator, not theatrical agent personas. The run phases are:

1. Understand repository
2. Build project map
3. Research docs or lore if needed
4. Plan implementation
5. Create patch
6. Build/test
7. Launch Minecraft
8. Playtest
9. Diagnose logs/crashes
10. Fix loop
11. Final report with diff and proof

The MVP code currently implements the repository-understanding phase and scaffolds the rest of the phase timeline so future implementation can add patching, build loops, launch control, playtest automation, and final reports without changing the UI contract.
