import fs from "node:fs";
import path from "node:path";
import type { GameHealth, GameManifest, GameServerModule } from "./types.js";

export interface LoadedGame {
  manifest: GameManifest;
  dir: string;
}

const REQUIRED: (keyof GameManifest)[] = ["id", "title", "tagline", "description", "players", "status"];

/** Read every `games/<id>/game.json`, sorted so live games come first. */
export function loadGames(gamesRoot: string): LoadedGame[] {
  if (!fs.existsSync(gamesRoot)) return [];

  const games: LoadedGame[] = [];
  for (const entry of fs.readdirSync(gamesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(gamesRoot, entry.name);
    const manifestPath = path.join(dir, "game.json");
    if (!fs.existsSync(manifestPath)) continue;

    let manifest: GameManifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    } catch (err) {
      console.warn(`[hub] skipping ${entry.name}: game.json is not valid JSON (${(err as Error).message})`);
      continue;
    }
    const missing = REQUIRED.filter((key) => manifest[key] === undefined);
    if (missing.length) {
      console.warn(`[hub] skipping ${entry.name}: game.json is missing ${missing.join(", ")}`);
      continue;
    }
    if (manifest.id !== entry.name) {
      console.warn(`[hub] ${entry.name}: game.json id "${manifest.id}" should match its folder name`);
    }
    games.push({ manifest, dir });
  }

  const rank = { live: 0, beta: 1, soon: 2 } as const;
  return games.sort(
    (a, b) => rank[a.manifest.status] - rank[b.manifest.status] || a.manifest.title.localeCompare(b.manifest.title),
  );
}

/** Fields the portal is allowed to see. `serverDown`: the game's server module failed to register. */
export function publicManifest(game: LoadedGame, clientBuilt: boolean, serverDown = false) {
  const { manifest } = game;
  return {
    id: manifest.id,
    title: manifest.title,
    tagline: manifest.tagline,
    description: manifest.description,
    players: manifest.players,
    duration: manifest.duration,
    input: manifest.input,
    desktopOnly: manifest.desktopOnly === true,
    tags: manifest.tags ?? [],
    accent: manifest.accent,
    status: manifest.status,
    badge: manifest.badge,
    howToPlay: manifest.howToPlay ?? [],
    controls: manifest.controls ?? [],
    cover: manifest.cover ? `/api/games/${manifest.id}/cover` : null,
    url: `/games/${manifest.id}/`,
    serverDown,
    playable: manifest.status !== "soon" && clientBuilt && !serverDown,
  };
}

/**
 * A short, path-free label for an error shown on the public `/healthz`: its Node error code (ERR_MODULE_NOT_FOUND,
 * ENOENT…) or else its class name (TypeError, SyntaxError…), never its message or stack, which can carry absolute
 * server paths (/app/dist/games/<id>/server/index.js). Undefined for a plain `Error` or a thrown non-error. The
 * full error goes to the server log instead.
 */
export function errorReason(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const { code, name } = err as { code?: unknown; name?: unknown };
  if (typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code)) return code;
  if (typeof name === "string" && name !== "Error" && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name)) return name;
  return undefined;
}

const labelled = (text: string, err: unknown) => {
  const reason = errorReason(err);
  return reason ? `${text} (${reason})` : text;
};

/**
 * The part of a game's own `health()` report that `/healthz` publishes: `ok` (true only for `ok: true`), finite
 * numbers and booleans as they are, an array as its length, and nothing else. Strings and objects can carry what a
 * public endpoint must not show (Raft Rush's `stalled` lists room codes, which are join codes; an error text can
 * name server paths), so a game's report can only add counts and flags there.
 */
export function publicHealth(report: { ok?: unknown; [detail: string]: unknown }): GameHealth {
  const details: [string, number | boolean][] = [];
  for (const [key, value] of Object.entries(report)) {
    if (key === "ok") continue;
    if (typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) details.push([key, value]);
    else if (Array.isArray(value)) details.push([key, value.length]);
  }
  // fromEntries defines own properties, so a "__proto__" key stays a plain field; `ok` itself was skipped above.
  return { ok: report.ok === true, ...Object.fromEntries(details) };
}

/** Body of `/healthz`. */
export interface HubHealth {
  /** False when any game reported not ok or failed to register (the endpoint then answers 503). */
  ok: boolean;
  /** How many games were found under games/. */
  games: number;
  /**
   * Each registered game's own report (its `publicHealth` part), for the games whose server module exports
   * `health()`, plus an `ok: false` entry for every game whose server module failed to load or register.
   */
  checks: Record<string, GameHealth>;
}

/** Where `hubHealth` sends a throwing `health()`'s full error (the endpoint itself only gets `errorReason`). */
export type HealthErrorLog = (gameId: string, err: unknown) => void;

/** How long `throttledHealthLog` stays quiet about a game whose `health()` keeps throwing the same error. */
export const HEALTH_LOG_REPEAT_MS = 10 * 60_000;
/** The least time between two of its lines for one game, even when every throw reads differently. */
export const HEALTH_LOG_MIN_GAP_MS = 10_000;

export interface HealthLogOptions {
  /** Default console.error. */
  sink?: (message: string, err: unknown) => void;
  repeatMs?: number;
  minGapMs?: number;
  /** Monotonic ms (default performance.now()). */
  now?: () => number;
}

/**
 * What makes two throws "the same error" for the throttle: class, code and message (capped), never identity. A
 * value that can't be turned into text (a throwing getter or toString) gets one shared signature.
 */
function errorSignature(err: unknown): string {
  try {
    if (err && typeof err === "object") {
      const { name, code, message } = err as { name?: unknown; code?: unknown; message?: unknown };
      return `${String(name)}|${String(code)}|${String(message)}`.slice(0, 500);
    }
    return `${typeof err}|${String(err)}`.slice(0, 500);
  } catch {
    return "unprintable";
  }
}

/**
 * A HealthErrorLog for a public, unthrottled endpoint: whoever polls `/healthz` decides how often `health()` runs,
 * so a `health()` that throws on every call must not write a stack per request. Per game it writes the first throw,
 * then a different error once `minGapMs` passed since its last line, and the same error again only after
 * `repeatMs`; that line says how many throws were left out since the previous one. It keeps one entry per game id
 * and doesn't notice a recovery, so the same error coming back within `repeatMs` waits for the repeat.
 */
export function throttledHealthLog(options: HealthLogOptions = {}): HealthErrorLog {
  const {
    sink = (message, err) => console.error(message, err),
    repeatMs = HEALTH_LOG_REPEAT_MS,
    minGapMs = HEALTH_LOG_MIN_GAP_MS,
    now = () => performance.now(),
  } = options;
  const last = new Map<string, { signature: string; at: number; skipped: number }>();
  return (gameId, err) => {
    const at = now();
    const signature = errorSignature(err);
    const prev = last.get(gameId);
    if (prev && at - prev.at < (prev.signature === signature ? repeatMs : minGapMs)) {
      prev.skipped++;
      return;
    }
    const skipped = prev?.skipped ? ` (${prev.skipped} more since the last line, not logged)` : "";
    sink(`[hub] ${gameId} health() threw${skipped}:`, err);
    last.set(gameId, { signature, at, skipped: 0 });
  };
}

const logHealthError = throttledHealthLog();

/**
 * Ask every registered game server how it's doing. A `health()` that throws counts as not ok, and so does a game
 * whose server never registered (`failed`: game id → the error its import or `register()` threw; the hub logged
 * it in full at registration). A report is published through `publicHealth` (counts and flags only). The public
 * `error` text is only "failed to register" / "health() threw" plus the `errorReason`; a throwing `health()`'s
 * full error goes to `logError` (default: console.error through `throttledHealthLog`).
 */
export function hubHealth(
  gameCount: number,
  modules: ReadonlyMap<string, GameServerModule>,
  failed: ReadonlyMap<string, unknown> = new Map(),
  logError: HealthErrorLog = logHealthError,
): HubHealth {
  const checks: Record<string, GameHealth> = {};
  let ok = failed.size === 0;
  for (const [id, err] of failed) checks[id] = { ok: false, error: labelled("failed to register", err) };
  for (const [id, mod] of modules) {
    if (typeof mod.health !== "function") continue;
    let report: GameHealth;
    try {
      const raw = mod.health();
      report = raw && typeof raw === "object" ? publicHealth(raw) : { ok: false, error: "health() returned no report" };
    } catch (err) {
      logError(id, err);
      report = { ok: false, error: labelled("health() threw", err) };
    }
    checks[id] = report;
    if (!report.ok) ok = false;
  }
  return { ok, games: gameCount, checks };
}
