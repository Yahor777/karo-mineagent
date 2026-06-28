# MineAgent Workbench

MineAgent Workbench is a VS Code extension scaffold for AI-assisted Minecraft Java mod development. It is intentionally narrow: Forge, Fabric, NeoForge, Gradle, repository indexing, cited reference packs, Minecraft launch loops, logs, crash reports, and playtest evidence.

This is not based on Karo and does not reuse Karo code.

## MVP Scope

- VS Code Activity Bar item and webview workbench.
- Minecraft-inspired compact chat UI with tabs for Chat, Runs, Lab, References, Rules, Skills, and Providers.
- Provider adapter contracts for OpenAI, Anthropic Claude, Fireworks AI, and custom OpenAI-compatible APIs.
- Workspace config in `.mineagent/config.json` and API keys in VS Code SecretStorage.
- Editable `AGENTS.md` rules file.
- Repository indexer for loader, Minecraft version, Java version, Gradle tasks, mod id, registries, resources, mixins, datagen, and architecture hints.
- Gradle build and runClient launch helpers.
- Log and crash parser.
- Reference pack and Source Ledger data model.
- Tool contracts for repo, git, Gradle, Minecraft, docs, web research, references, and playtests.

## Development

```powershell
npm install
npm run compile
npm test
```

Launch the extension from VS Code with the "Run MineAgent Extension" debug target. The debug target opens the current folder in the Extension Development Host so MineAgent has a workspace to initialize.

For quick visual UI checks without starting VS Code Extension Host, open `scripts/webview-preview.html` in a browser. It loads the real `media/mineagent.css` and `media/mineagent.js` with mocked VS Code messages, so layout and tab interactions can be inspected safely without provider keys, network access, Gradle, or Minecraft launches.

## Workspace Files

MineAgent creates and uses:

- `AGENTS.md`
- `.mineagent/config.json`
- `.mineagent/skills/**`
- `.mineagent/reference-packs/**`
- `.mineagent/playtests/**`
- `.mineagent/runs/**`

Secrets are not written to workspace files. Provider keys are stored in VS Code SecretStorage.
