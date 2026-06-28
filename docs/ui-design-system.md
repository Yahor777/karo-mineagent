# UI Design System

## Direction

MineAgent should feel like a serious development tool with a Minecraft-inspired material language. It should not look like a landing page, toy, fan site, or bright game menu.

## Visual Tokens

- Background: near-black stone with subtle 16px grid texture.
- Surfaces: deepslate and stone panels.
- Borders: 1px or 2px pixel-like borders with hard corners.
- Corners: 2px to 3px.
- Accents:
  - Grass: `#5ea646`
  - Emerald: `#31c48d`
  - Redstone: `#f05d5e`
  - Lapis: `#5798ff`
  - Gold: `#d7a84c`
  - Enchanted glow: `#b58cff`
- Text: compact VS Code font stack and editor monospace for evidence, commands, and ids.

## Layout

- Topbar: brand mark, product name, quick refresh.
- Tabs: Chat, Runs, Lab, References, Rules, Skills, Providers.
- Chat:
  - Sessions list like Copilot/Qoder.
  - Main feed for assistant/user messages and project-map summaries.
  - Composer fixed at bottom.
- Runs:
  - Phase timeline: Understand, Research, Patch, Build, Launch, Playtest, Diagnose, Report.
  - Evidence list with command, exit code, and timestamp.
- Lab:
  - Build, runClient, parse logs, dev bridge.
  - Terminal-like evidence output.
- Rules:
  - Editable `AGENTS.md`.
- Providers:
  - Provider key status and command entrypoint to SecretStorage.

## Interaction Rules

- Keep controls dense and predictable.
- Use short labels on repeated tool buttons.
- Avoid decorative cards nested in cards.
- Keep status/evidence readable in narrow sidebars.
- Do not use official Minecraft logos, textures, or protected assets.
- Any generated or hand-authored assets must be original.
