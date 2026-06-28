import { readdir, readFile, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";

// Этап 1: базовые read-only «руки». ИИ должен ВИДЕТЬ проект, прежде чем менять.
// Хелперы детерминированы, безопасны (read-only) и не требуют подтверждения.

const SKIP_DIRS = new Set([
  "node_modules", ".git", "out", "build", ".gradle", "bin",
  ".vscode-test", ".idea", "run", "logs", ".mineagent", ".design", ".qodo"
]);

const TEXT_EXT = new Set([
  ".java", ".kt", ".kts", ".gradle", ".json", ".json5", ".toml", ".cfg",
  ".properties", ".mcmeta", ".ts", ".js", ".md", ".txt", ".yml", ".yaml",
  ".xml", ".html", ".css", ".lang", ".mixins", ".accesswidener"
]);

/** Защита от выхода за пределы воркспейса (path traversal). */
export function resolveInsideRoot(root: string, rel: string): string {
  const abs = isAbsolute(rel) ? resolve(rel) : resolve(root, rel);
  const rootResolved = resolve(root);
  const relToRoot = relative(rootResolved, abs);
  if (relToRoot.startsWith("..") || isAbsolute(relToRoot)) {
    throw new Error(`repo: путь '${rel}' выходит за пределы воркспейса`);
  }
  return abs;
}

export interface ReadFileResult {
  path: string;
  content: string;
  bytes: number;
  lines: number;
  truncated: boolean;
}

/** Прочитать текстовый файл воркспейса (лимит + защита от traversal). */
export async function readWorkspaceFile(
  root: string,
  rel: string,
  maxBytes = 200_000
): Promise<ReadFileResult> {
  const cleaned = String(rel ?? "").trim();
  if (!cleaned) throw new Error("repo.read: параметр 'path' обязателен");
  const abs = resolveInsideRoot(root, cleaned);
  const info = await stat(abs);
  if (info.isDirectory()) {
    throw new Error(`repo.read: '${cleaned}' — это директория, не файл`);
  }
  const raw = await readFile(abs, "utf8");
  const truncated = raw.length > maxBytes;
  const content = truncated ? raw.slice(0, maxBytes) : raw;
  return {
    path: cleaned.split(sep).join("/"),
    content,
    bytes: Buffer.byteLength(raw, "utf8"),
    lines: raw.split(/\r?\n/).length,
    truncated
  };
}

export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

export interface SearchResult {
  files: string[];
  hits: SearchHit[];
  scanned: number;
  truncated: boolean;
}

/** Рекурсивный поиск по содержимому исходников (substring или regex). */
export async function searchWorkspace(
  root: string,
  query: string,
  opts: { regex?: boolean; maxHits?: number; maxFiles?: number } = {}
): Promise<SearchResult> {
  const q = String(query ?? "").trim();
  if (!q) throw new Error("repo.search: параметр 'query' обязателен");
  const maxHits = opts.maxHits ?? 200;
  const maxFiles = opts.maxFiles ?? 4000;
  const matcher: { test: (s: string) => boolean } = opts.regex
    ? new RegExp(q, "i")
    : { test: (s: string) => s.toLowerCase().includes(q.toLowerCase()) };

  const hits: SearchHit[] = [];
  const fileSet = new Set<string>();
  let scanned = 0;
  let truncated = false;

  async function walk(dir: string): Promise<void> {
    if (truncated) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (truncated) return;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        await walk(join(dir, e.name));
        continue;
      }
      const dot = e.name.lastIndexOf(".");
      const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : "";
      if (!TEXT_EXT.has(ext)) continue;
      if (scanned >= maxFiles) { truncated = true; return; }
      scanned++;
      const abs = join(dir, e.name);
      let raw: string;
      try {
        raw = await readFile(abs, "utf8");
      } catch {
        continue;
      }
      const relPath = relative(root, abs).split(sep).join("/");
      const fileLines = raw.split(/\r?\n/);
      for (let i = 0; i < fileLines.length; i++) {
        if (matcher.test(fileLines[i])) {
          fileSet.add(relPath);
          hits.push({ path: relPath, line: i + 1, text: fileLines[i].trim().slice(0, 300) });
          if (hits.length >= maxHits) { truncated = true; return; }
        }
      }
    }
  }

  await walk(resolve(root));
  return { files: Array.from(fileSet), hits, scanned, truncated };
}

export interface GitDiffResult {
  diff: string;
  isGitRepo: boolean;
}

/** git diff воркспейса (или конкретного пути). Безопасно при отсутствии git. */
export async function gitDiff(root: string, path?: string): Promise<GitDiffResult> {
  return new Promise<GitDiffResult>((resolvePromise) => {
    const args = ["diff", "--no-color"];
    if (path && path.trim()) args.push("--", path.trim());
    const child = spawn("git", args, { cwd: root });
    let out = "";
    let err = "";
    child.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    child.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    child.on("error", () => resolvePromise({ diff: "", isGitRepo: false }));
    child.on("close", (code: number | null) => {
      if (code !== 0 && /not a git repository/i.test(err)) {
        resolvePromise({ diff: "", isGitRepo: false });
        return;
      }
      const MAX = 100_000;
      const clipped = out.length > MAX ? out.slice(0, MAX) + "\n…(diff обрезан)" : out;
      resolvePromise({ diff: clipped, isGitRepo: true });
    });
  });
}
