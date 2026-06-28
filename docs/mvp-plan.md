# MVP Implementation Plan

## Vertical Slice 1: Extension Shell

- Scaffold VS Code extension with TypeScript.
- Add Activity Bar item and webview workbench.
- Add commands for opening MineAgent, initializing workspace files, refreshing index, running Gradle build, launching runClient, opening rules, and setting provider keys.
- Store provider keys in SecretStorage.

Status: scaffolded.

## Vertical Slice 2: Repository Intelligence

- Detect loader: Forge, Fabric, NeoForge, unknown.
- Detect Minecraft version, Java version, Gradle tasks, mod id.
- Scan registries, events, packets, client-only classes, resources, mixins/access wideners, datagen, and architecture hints.
- Persist project maps under `.mineagent/runs/**` with evidence.

Status: in-memory indexer scaffolded; persistence is next.

## Vertical Slice 3: Provider Integration

- Wire provider list and SecretStorage status in UI.
- Add real chat calls through `ProviderAdapter`.
- Add streaming UI updates.
- Add token estimate and model capability display.

Status: adapter contracts and base HTTP adapters scaffolded.

## Vertical Slice 4: Reference Research Engine

- Add approval-gated web/docs search.
- Extract factual claims with source kind and reliability notes.
- Save Source Ledger and Reference Pack.
- Attach cited packs to implementation prompts.

Status: data model and UI panel scaffolded.

## Vertical Slice 5: Patch and Build Loop

- Generate patch previews.
- Apply approved patches.
- Run Gradle build.
- Parse compile errors and Minecraft logs.
- Iterate with evidence.

Status: Gradle command evidence and log parser scaffolded.

## Vertical Slice 6: Minecraft Lab and Playtest Stub

- Launch `runClient`.
- Tail logs.
- Parse crash reports.
- Add optional dev bridge protocol.
- Add one playtest flow stub with stored report.

Status: runClient command and playtest timeline scaffolded.

## Done Criteria for MVP

- Extension launches in VS Code extension host.
- Workbench UI renders all required tabs.
- Workspace init creates `AGENTS.md` and `.mineagent/config.json`.
- Provider key status works without leaking secrets.
- Repo indexer produces useful Minecraft project map.
- Gradle build and runClient commands produce evidence.
- Logs/crashes can be summarized.
- Reference and playtest panels clearly show scaffolded contracts.
