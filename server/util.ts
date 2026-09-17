/** Studio server utilities: config dir, token, workspace resolution. */
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface StudioConfig {
  /** Bearer token for the MCP endpoint and the browser WS handshake. */
  token: string;
  /** Last-used workspace directory. */
  workspace?: string;
}

export function configDir(): string {
  return path.join(os.homedir(), ".motionref-studio");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function readConfig(): StudioConfig {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<StudioConfig>;
    if (typeof parsed.token === "string" && parsed.token) return { token: parsed.token, workspace: parsed.workspace };
  } catch {
    /* first run */
  }
  const fresh: StudioConfig = { token: randomBytes(24).toString("hex") };
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(fresh, null, 2), { mode: 0o600 });
  return fresh;
}

export function writeConfig(patch: Partial<StudioConfig>): StudioConfig {
  const cfg = readConfig();
  const next = { ...cfg, ...patch };
  fs.mkdirSync(configDir(), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
}

export const DEFAULT_PORT = 8787;

/** Workspace resolution: explicit flag → persisted last-used → fallback. */
export function resolveWorkspace(flag?: string): string {
  if (flag) {
    const abs = path.resolve(flag);
    fs.mkdirSync(abs, { recursive: true });
    writeConfig({ workspace: abs });
    return abs;
  }
  const cfg = readConfig();
  if (cfg.workspace && fs.existsSync(cfg.workspace)) return cfg.workspace;
  const fallback = path.join(configDir(), "projects");
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/** Adopt a workspace reported by a connecting stdio MCP shim (the external
 *  agent's working directory) unless one was already pinned. */
export function adoptWorkspace(cwd: string): boolean {
  if (!cwd || !fs.existsSync(cwd)) return false;
  const cfg = readConfig();
  if (cfg.workspace && fs.existsSync(cfg.workspace) && cfg.workspace !== path.join(configDir(), "projects")) {
    return false; // already pinned by flag or a previous session
  }
  writeConfig({ workspace: path.resolve(cwd) });
  return true;
}

export function serverVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

/** Atomic JSON write (tmp + rename) so readers never see partial files. */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}
