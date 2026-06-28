export type MinecraftLoader = "forge" | "fabric" | "neoforge" | "unknown";

export interface RegistrySymbol {
  type: "item" | "block" | "entity" | "effect" | "sound" | "unknown";
  name: string;
  file: string;
}

export interface ResourceSummary {
  lang: string[];
  models: string[];
  textures: string[];
  recipes: string[];
  lootTables: string[];
  tags: string[];
  sounds: string[];
}

export interface ProjectMap {
  indexedAt: string;
  root: string;
  loader: MinecraftLoader;
  minecraftVersion?: string;
  javaVersion?: string;
  gradleTasks: string[];
  mainModId?: string;
  registries: RegistrySymbol[];
  eventHandlers: string[];
  networkPackets: string[];
  clientOnlyClasses: string[];
  resources: ResourceSummary;
  mixins: string[];
  accessWideners: string[];
  datagen: string[];
  architectureHints: string[];
}
