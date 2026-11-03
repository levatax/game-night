// QA telemetry schema (one row per match run). Owner: qa. No game code is imported here.
//
// Field notes:
// - player_id is the FOCAL player of the run: the idle human when a run has humans, otherwise the first bot.
// - death_x / death_y are the map-plane coordinates (world x / world z) of the focal player's first down,
//   ready for a 2D heatmap. death_height is the world y at that moment.
// - time_to_first_fish, first_input_s and first_meaningful_choice_s are seconds after the playing phase began.
//   The in-process batch runner leaves the two client-only fields empty; qa/client-probe.mjs fills them.
// - bot_delivery_share = deliveries credited to bots / all deliveries (0..1).
// - raft_ready_s = seconds from the start of playing until the team's raft first reached stage 3
//   (the acceptance-gate "raft in the water" moment; target 440–460 s, early = < 440 s).
// - departure_s = seconds from the start of playing until the raft actually left (launchRequest;
//   target 470–495 s). This build has no separate tide delay, so departure_s == the launch second.
// - boss_spawn = 1 when a monsterSpawn event with kind "boss" was observed in the run, else 0. Bosses are
//   scheduled for night 3 (normal/vacation) and additionally night 2 (nightmare), so 0 is correct for a run
//   that ended before that wave (early launch, wipe or storm): only match_seconds >= 450 runs are in scope
//   for the "boss spawned" check.

export interface RunRow {
  run_id: string;
  seed: number;
  match_seconds: number;
  player_id: string;
  run_index: number;
  players: number;
  bot_count: number;
  outcome: "win" | "loss" | "wipe" | "timeout";
  end_reason: "launched" | "storm" | "boss" | "starve" | "death" | "timeout";
  death_cause: string;
  death_x: number | null;
  death_y: number | null;
  fire_out_count: number;
  wood_to_fire: number;
  time_to_first_fish: number | null;
  first_input_s: number | null;
  first_meaningful_choice_s: number | null;
  bot_delivery_share: number;
  downed_count: number;
  revive_count: number;
  raft_ready_s: number | null;
  departure_s: number | null;

  /* extras (kept after the required columns; safe for existing dashboards) */
  biome: string;
  difficulty: string;
  humans: number;
  player_kind: "human" | "bot";
  seconds_left: number | null;
  team_score: number | null;
  stage: number;
  fire_fuel_end: number;
  delivered_total: number;
  team_downed: number;
  team_revived: number;
  focal_downed: number;
  focal_washed: number;
  focal_boarded: number;
  focal_points: number;
  death_height: number | null;
  first_choice_source: string;
  boss_spawn: 0 | 1;
}

export const REQUIRED_COLUMNS: ReadonlyArray<keyof RunRow> = [
  "run_id",
  "seed",
  "match_seconds",
  "player_id",
  "run_index",
  "players",
  "bot_count",
  "outcome",
  "end_reason",
  "death_cause",
  "death_x",
  "death_y",
  "fire_out_count",
  "wood_to_fire",
  "time_to_first_fish",
  "first_input_s",
  "first_meaningful_choice_s",
  "bot_delivery_share",
  "downed_count",
  "revive_count",
  "raft_ready_s",
  "departure_s",
];

export const EXTRA_COLUMNS: ReadonlyArray<keyof RunRow> = [
  "biome",
  "difficulty",
  "humans",
  "player_kind",
  "seconds_left",
  "team_score",
  "stage",
  "fire_fuel_end",
  "delivered_total",
  "team_downed",
  "team_revived",
  "focal_downed",
  "focal_washed",
  "focal_boarded",
  "focal_points",
  "death_height",
  "first_choice_source",
  "boss_spawn",
];

export const COLUMNS: ReadonlyArray<keyof RunRow> = [...REQUIRED_COLUMNS, ...EXTRA_COLUMNS];

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCsv(rows: ReadonlyArray<RunRow>): string {
  const head = COLUMNS.join(",");
  const body = rows.map((r) => COLUMNS.map((c) => cell(r[c])).join(","));
  return [head, ...body].join("\n") + "\n";
}

export function toJson(rows: ReadonlyArray<RunRow>, meta: Record<string, unknown>): string {
  return JSON.stringify({ meta, rows }, null, 2) + "\n";
}

export const OUTCOME_LABEL: Record<RunRow["outcome"], string> = {
  win: "win",
  loss: "loss",
  wipe: "wipe",
  timeout: "timeout",
};
