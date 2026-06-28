# MCP and Tool Contracts

Tool contract definitions live in `src/tools/ToolContracts.ts`.

## Tool List

| Tool | Purpose | Risk | Approval |
| --- | --- | --- | --- |
| `repo.index` | Build Minecraft-aware project map | read | no |
| `repo.search` | Search workspace files | read | no |
| `repo.read` | Read workspace files | read | no |
| `repo.patch` | Apply reviewed patch | write | yes |
| `git.diff` | Return current diff | read | no |
| `gradle.tasks` | List Gradle tasks | command | yes |
| `gradle.run` | Run a Gradle task | command | yes |
| `minecraft.runClient` | Launch dev client | game-control | yes |
| `minecraft.stopClient` | Stop dev client | game-control | yes |
| `minecraft.tailLogs` | Tail and summarize logs | read | no |
| `minecraft.parseCrash` | Parse crash report | read | no |
| `minecraft.screenshot` | Capture screenshot | game-control | yes |
| `minecraft.focusWindow` | Focus client window | game-control | yes |
| `minecraft.input` | Send keyboard/mouse input | game-control | yes |
| `minecraft.command` | Execute dev-only command | game-control | yes |
| `minecraft.devBridge` | Use optional dev bridge | game-control | yes |
| `docs.search` | Search docs/source | network | yes |
| `web.research` | Cited web research | network | yes |
| `reference.savePack` | Save Reference Pack | write | yes |
| `playtest.run` | Run playtest flow | game-control | yes |

## Minecraft Dev Bridge

The dev bridge is optional and must be disabled unless a development run explicitly enables it. It may expose safe commands for:

- create or reset test world
- execute command
- give item
- summon entity
- teleport player
- set gamemode
- inspect registries
- check entity exists
- check effect applied
- capture coordinates/state

The bridge must not be bundled as a production gameplay feature.

## Evidence

Every command-like or game-control tool stores:

- command or action
- working directory
- started/completed timestamps
- exit code or status
- stdout/stderr summary
- relevant file list
- log summary
- screenshot path when available
