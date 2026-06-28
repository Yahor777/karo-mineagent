export type SourceKind = "official-docs" | "source" | "wiki" | "article" | "forum" | "video-notes";

export interface SourceLedgerEntry {
  id: string;
  title: string;
  url: string;
  kind: SourceKind;
  capturedAt: string;
  claims: string[];
  reliabilityNote: string;
}

export interface ReferencePack {
  id: string;
  title: string;
  topic: string;
  createdAt: string;
  entries: SourceLedgerEntry[];
  implementationNotes: string[];
  copyrightBoundary: string;
}

export class ReferenceEngine {
  public createEmptyPack(topic: string): ReferencePack {
    const id = slug(topic);
    return {
      id,
      title: topic,
      topic,
      createdAt: new Date().toISOString(),
      entries: [],
      implementationNotes: [],
      copyrightBoundary: "Use sources for factual understanding only. Do not copy protected text, art, logos, textures, audio, or character assets."
    };
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "reference-pack";
}
