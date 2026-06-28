export const EXTENSION_ID = "mineagent-workbench";
export const VIEW_ID = "mineagent.workbench";
export const CONFIG_DIR = ".mineagent";
export const CONFIG_FILE = ".mineagent/config.json";
export const RESEARCH_LEDGER_FILE = ".mineagent/research-ledger.json";
export const AGENTS_FILE = "AGENTS.md";

export const SECRET_PREFIX = "mineagent.providerKey";

export const DEFAULT_PHASES = [
  "Understand",
  "Research",
  "Patch",
  "Build",
  "Launch",
  "Playtest",
  "Diagnose",
  "Report"
] as const;
