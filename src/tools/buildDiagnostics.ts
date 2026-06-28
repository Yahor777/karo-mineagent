import { readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import type { CommandEvidence } from "./gradleTools";
import { parseMinecraftLog, type ParsedLogSummary } from "./logParser";
import { resolveInsideRoot } from "./repoReadTools";

// Этап 2: диагностика сборки и крашей. ИИ получает СТРУКТУРИРОВАННЫЕ ошибки,
// а не сырые логи на десятки КБ — это резко ускоряет цикл «правка → сборка → фикс».

export interface CompileError {
  file: string;
  line: number;
  column?: number;
  severity: "error" | "warning";
  message: string;
}

export interface BuildDiagnosis {
  success: boolean;
  exitCode: number | null;
  task: string;
  errorCount: number;
  warningCount: number;
  compileErrors: CompileError[];
  buildFailures: string[];
  summary: string;
}

function toRelative(file: string, cwd: string): string {
  let f = file.replace(/\\/g, "/").trim();
  const root = cwd.replace(/\\/g, "/");
  if (root && f.toLowerCase().startsWith(root.toLowerCase())) {
    f = f.slice(root.length).replace(/^\/+/, "");
  }
  return f;
}

/** Разобрать вывод Gradle/javac в структурированный диагноз сборки. */
export function parseGradleOutput(evidence: CommandEvidence, task: string): BuildDiagnosis {
  const text = `${evidence.stdout ?? ""}\n${evidence.stderr ?? ""}`;
  const lines = text.split(/\r?\n/);
  const compileErrors: CompileError[] = [];
  const buildFailures: string[] = [];
  const seen = new Set<string>();
  let errorCount = 0;
  let warningCount = 0;
  let inWhatWentWrong = false;

  const withCol = /^\s*(?:e: |w: )?(.+\.(?:java|kt|kts)):(\d+):(\d+):\s*(error|warning):\s*(.*)$/i;
  const noCol = /^\s*(.+\.(?:java|kt|kts)):(\d+):\s*(error|warning):\s*(.*)$/i;

  const pushErr = (file: string, ln: number, col: number | undefined, sev: string, msg: string): void => {
    const severity = sev.toLowerCase() === "warning" ? "warning" : "error";
    const rel = toRelative(file, evidence.cwd);
    const key = `${rel}:${ln}:${col ?? ""}:${msg.trim()}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (severity === "warning") {
      warningCount++;
      if (compileErrors.filter((e) => e.severity === "warning").length >= 50) return;
    } else {
      errorCount++;
    }
    compileErrors.push({ file: rel, line: ln, column: col, severity, message: msg.trim() });
  };

  for (const raw of lines) {
    const line = raw.trim();
    let m = withCol.exec(raw);
    if (m) { pushErr(m[1], Number(m[2]), Number(m[3]), m[4], m[5]); continue; }
    m = noCol.exec(raw);
    if (m) { pushErr(m[1], Number(m[2]), undefined, m[3], m[4]); continue; }
    if (/^FAILURE: Build failed/i.test(line)) { buildFailures.push(line); continue; }
    if (/^> Task .*FAILED/i.test(line)) { buildFailures.push(line); continue; }
    if (/^\* What went wrong:/i.test(line)) { inWhatWentWrong = true; continue; }
    if (inWhatWentWrong) {
      if (line === "" || /^\* /.test(line)) { inWhatWentWrong = false; }
      else if (buildFailures.length < 30) { buildFailures.push(line); }
    }
  }

  const success = evidence.exitCode === 0 && errorCount === 0;
  let summary: string;
  if (success) {
    summary = `Gradle ${task}: УСПЕХ (exit 0)` + (warningCount ? `, предупреждений: ${warningCount}` : "");
  } else {
    const first = compileErrors.find((e) => e.severity === "error");
    const head = first ? ` Первая ошибка: ${first.file}:${first.line} — ${first.message}` : (buildFailures[0] ? ` ${buildFailures[0]}` : "");
    summary = `Gradle ${task}: ПРОВАЛ (exit ${evidence.exitCode}). Ошибок компиляции: ${errorCount}.${head}`;
  }
  return { success, exitCode: evidence.exitCode, task, errorCount, warningCount, compileErrors, buildFailures, summary };
}

export interface LogTailResult extends ParsedLogSummary {
  found: boolean;
  logPath?: string;
  tailLines: number;
}

async function findLatestLog(root: string): Promise<string | undefined> {
  const logsDir = join(root, "run", "logs");
  if (!existsSync(logsDir)) return undefined;
  const latest = join(logsDir, "latest.log");
  if (existsSync(latest)) return latest;
  try {
    const files = (await readdir(logsDir)).filter((f) => f.endsWith(".log")).sort();
    return files.length ? join(logsDir, files[files.length - 1]) : undefined;
  } catch {
    return undefined;
  }
}

/** Прочитать хвост последнего лога клиента и распарсить его (fatal/exception/warn). */
export async function tailMinecraftLogs(root: string, maxLines = 200): Promise<LogTailResult> {
  const logPath = await findLatestLog(root);
  if (!logPath) {
    return { fatalLines: [], warnings: [], exceptions: [], found: false, tailLines: 0 };
  }
  const raw = await readFile(logPath, "utf8");
  const all = raw.split(/\r?\n/);
  const tail = all.slice(Math.max(0, all.length - maxLines)).join("\n");
  const parsed = parseMinecraftLog(tail);
  return { ...parsed, found: true, logPath: toRelative(logPath, root), tailLines: Math.min(maxLines, all.length) };
}

export interface CrashParseResult extends ParsedLogSummary {
  found: boolean;
  crashPath?: string;
}

/** Прочитать crash-report (указанный путь или последний в run/crash-reports) и распарсить. */
export async function parseCrashReport(root: string, path?: string): Promise<CrashParseResult> {
  let target = path && path.trim() ? path.trim() : undefined;
  if (!target) {
    const dir = join(root, "run", "crash-reports");
    if (existsSync(dir)) {
      try {
        const files = (await readdir(dir)).filter((f) => f.endsWith(".txt")).sort();
        if (files.length) target = join(dir, files[files.length - 1]);
      } catch { /* ignore */ }
    }
  }
  if (!target) {
    return { fatalLines: [], warnings: [], exceptions: [], found: false };
  }
  const abs = isAbsolute(target) ? resolveInsideRoot(root, target) : resolveInsideRoot(root, target);
  const raw = await readFile(abs, "utf8");
  const parsed = parseMinecraftLog(raw);
  return { ...parsed, found: true, crashPath: toRelative(target, root) };
}
