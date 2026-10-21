// Every string that names a key ({kInteract}, {kEat}… ui/controls.ts keyParams) reaches the screen filled, since
// t() leaves an unknown {placeholder} visible: (1) every t() / tr() call in the client that names such a string
// (literal, template family like `coach.${id}`, either branch of a ?:, a const holding one) passes keyParams() /
// withKeys() or a const in scope bound to one; (2) the strings that travel in a model field (feed lines, banners,
// hotbar hints, wheel hints, legend notes, settings toggles) are rendered by a call that does, nothing is left
// uncovered, and every other call whose key is a run-time value is a listed plain renderer whose strings name no
// key; (3) the HUD widgets that print them really do, in the left-handed preset, on a minimal DOM shim (node env),
// and re-print when the preset changes; Home re-prints when the keyboard layout map arrives. Owner: client-ui.
// Run: npx vitest run games/raft-rush/client/src/ui

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { settings } from "../app/settings";
import { t } from "../i18n";
import * as banner from "../i18n/strings/banner";
import * as characters from "../i18n/strings/characters";
import * as coach from "../i18n/strings/coach";
import * as feed from "../i18n/strings/feed";
import * as hud from "../i18n/strings/hud";
import * as items from "../i18n/strings/items";
import * as menu from "../i18n/strings/menu";
import * as overlays from "../i18n/strings/overlays";
import * as panels from "../i18n/strings/panels";
import * as prompt from "../i18n/strings/prompt";
import * as reject from "../i18n/strings/reject";
import * as server from "../i18n/strings/server";
import { loadKeyboardLayout, resetKeyCaps } from "../input/bindings";
import { Emitter } from "../util/Emitter";
import { Banner } from "./hud/Banner";
import { DownedScreen } from "./hud/DownedScreen";
import { Feed } from "./hud/Feed";
import { LaunchCountdown } from "./hud/LaunchCountdown";
import { Legend } from "./hud/Legend";
import { RaftProgress } from "./hud/RaftProgress";
import { Scoreboard } from "./hud/Scoreboard";
import type { UiEventMap } from "./models";
import { HomeScreen } from "./screens/Home";

/* ------------------------------------------------------------------ DOM shim */

// Installed before the imports run (ui/dom.ts makes its <template> at load): just enough of HTMLElement / SVG for
// the widgets above. Restored after this file.
const shim = vi.hoisted(() => {
  class FakeNode {
    className = "";
    hidden = false;
    id = "";
    readonly offsetWidth = 0;
    readonly dataset: Record<string, string> = {};
    parent: FakeNode | null = null;
    kids: Array<FakeNode | string> = [];
    private readonly attrs = new Map<string, string>();
    private readonly classes = new Set<string>();
    private readonly props = new Map<string, string>();
    readonly classList = {
      add: (...names: string[]) => names.forEach((n) => this.classes.add(n)),
      remove: (...names: string[]) => names.forEach((n) => this.classes.delete(n)),
      contains: (name: string) => this.classes.has(name),
      toggle: (name: string, on?: boolean) => {
        const next = on ?? !this.classes.has(name);
        if (next) this.classes.add(name);
        else this.classes.delete(name);
        return next;
      },
    };
    readonly style = {
      setProperty: (name: string, value: string) => void this.props.set(name, value),
      getPropertyValue: (name: string) => this.props.get(name) ?? "",
    };

    get textContent(): string {
      return this.kids.map((k) => (typeof k === "string" ? k : k.textContent)).join("");
    }
    set textContent(text: string) {
      this.kids = text ? [text] : [];
    }
    /** Rendered text: what a reader sees (hidden subtrees left out). */
    get shownText(): string {
      if (this.hidden) return "";
      return this.kids.map((k) => (typeof k === "string" ? k : k.shownText)).join("");
    }

    append(...nodes: Array<FakeNode | string>): void {
      for (const n of nodes) {
        if (typeof n !== "string") n.parent = this;
        this.kids.push(n);
      }
    }
    appendChild(node: FakeNode): FakeNode {
      this.append(node);
      return node;
    }
    replaceChildren(...nodes: Array<FakeNode | string>): void {
      this.kids = [];
      this.append(...nodes);
    }
    remove(): void {
      if (this.parent) this.parent.kids = this.parent.kids.filter((k) => k !== this);
      this.parent = null;
    }
    setAttribute(name: string, value: string): void {
      this.attrs.set(name, String(value));
    }
    getAttribute(name: string): string | null {
      return this.attrs.get(name) ?? null;
    }
    hasAttribute(name: string): boolean {
      return this.attrs.has(name);
    }
    toggleAttribute(name: string, on: boolean): void {
      if (on) this.attrs.set(name, "");
      else this.attrs.delete(name);
    }
    getBoundingClientRect(): { width: number; height: number } {
      return { width: 0, height: 0 };
    }
    addEventListener(): void {}
  }
  class FakeSvg extends FakeNode {}
  class FakeTemplate extends FakeNode {
    readonly content: { firstElementChild: FakeNode | null } = { firstElementChild: null };
    set innerHTML(_markup: string) {
      this.content.firstElementChild = new FakeSvg();
    }
  }
  const g = globalThis as Record<string, unknown>;
  const saved = { HTMLElement: g.HTMLElement, SVGSVGElement: g.SVGSVGElement, document: g.document, window: g.window };
  g.HTMLElement = FakeNode;
  g.SVGSVGElement = FakeSvg;
  g.document = {
    createElement: (tag: string) => (tag === "template" ? new FakeTemplate() : new FakeNode()),
    createElementNS: () => new FakeSvg(),
    createTextNode: (text: string) => text,
  };
  g.window = {
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (id: number) => clearTimeout(id),
  };
  return { FakeNode, saved };
});

type FakeEl = InstanceType<typeof shim.FakeNode>;
const fake = (node: unknown): FakeEl => node as FakeEl;

afterAll(() => {
  Object.assign(globalThis as Record<string, unknown>, shim.saved);
});

/* ------------------------------------------------------------- the strings */

const SECTIONS = { banner, characters, coach, feed, hud, items, menu, overlays, panels, prompt, reject, server } as const;
const KEY_PLACEHOLDER = /\{k[A-Z]\w*\}/;

/** "section.key" of every string with a {k…} placeholder (English is the source; tr carries the same ones). */
const KEYED: ReadonlySet<string> = new Set(
  Object.entries(SECTIONS).flatMap(([name, s]) =>
    Object.entries(s.en as Record<string, string>)
      .filter(([, text]) => KEY_PLACEHOLDER.test(text))
      .map(([key]) => `${name}.${key}`),
  ),
);

/* ------------------------------------------------------- the call-site scan */

const SRC = fileURLToPath(new URL("..", import.meta.url));

/** Client sources that render text: not tests, test kits or the string tables themselves. */
function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (relative(SRC, path).split(sep).join("/") !== "i18n/strings") sourceFiles(path, out);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") && !entry.name.endsWith(".d.ts") && entry.name !== "testkit.ts") {
      out.push(path);
    }
  }
  return out;
}

interface TCall {
  /** "ui/hud/Feed.ts:41" */
  where: string;
  file: string;
  /** Source text of the key argument. */
  keyArg: string;
  /** Keys it names outright, and template families ("coach." from `coach.${id}`). */
  exact: string[];
  prefixes: string[];
  /** Some branch of the key is only known at run time (a model field, a parameter, a bare `${section}.${key}`). */
  dynamic: boolean;
  passesKeys: boolean;
}

/** name → (scope node → initializer) of every `const name = …` in a file. */
type Consts = Map<string, Map<ts.Node, ts.Expression>>;

/** The block (or function body, or file) a declaration is visible in. */
function scopeOf(n: ts.Node): ts.Node {
  let p = n.parent;
  while (p && !ts.isBlock(p) && !ts.isSourceFile(p) && !ts.isModuleBlock(p) && !ts.isCaseBlock(p)) p = p.parent;
  return p ?? n.getSourceFile();
}

function collectConsts(sf: ts.SourceFile): Consts {
  const out: Consts = new Map();
  const visit = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && ts.isVariableDeclarationList(n.parent) && n.parent.flags & ts.NodeFlags.Const) {
      let byScope = out.get(n.name.text);
      if (!byScope) out.set(n.name.text, (byScope = new Map()));
      byScope.set(scopeOf(n), n.initializer);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The initializer of the const `id` refers to: the innermost enclosing scope that declares it, unless a parameter of that name shadows it first. */
function constOf(id: ts.Identifier, consts: Consts): ts.Expression | undefined {
  const byScope = consts.get(id.text);
  if (!byScope) return undefined;
  for (let p: ts.Node | undefined = id.parent; p; p = p.parent) {
    const init = byScope.get(p);
    if (init) return init;
    if (ts.isFunctionLike(p) && p.parameters.some((param) => ts.isIdentifier(param.name) && param.name.text === id.text)) return undefined;
  }
  return undefined;
}

/** An identifier in a name position (`{ keys: … }`, `a.keys`) rather than a reference to a variable. */
function isPropertyName(n: ts.Identifier): boolean {
  const p = n.parent;
  return (ts.isPropertyAssignment(p) || ts.isPropertyAccessExpression(p) || ts.isPropertyDeclaration(p) || ts.isMethodDeclaration(p)) && p.name === n;
}

/** Literal keys / template families an i18n key argument can evaluate to (null section: t(), else tr()'s); consts are followed. */
function keyCandidates(e: ts.Expression, section: string | null, consts: Consts, out: { exact: string[]; prefixes: string[]; dynamic: boolean }, depth = 0): void {
  const full = (text: string): string | null => (text.includes(".") ? text : section ? `${section}.${text}` : null);
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) {
    const k = full(e.text);
    if (k) out.exact.push(k);
  } else if (ts.isTemplateExpression(e)) {
    const head = e.head.text;
    // A bare `${section}.${key}` (dom.ts tr itself) names no family.
    const prefix = head.includes(".") ? head : section && head ? `${section}.${head}` : null;
    if (prefix) out.prefixes.push(prefix);
    else out.dynamic = true;
  } else if (ts.isConditionalExpression(e)) {
    keyCandidates(e.whenTrue, section, consts, out, depth);
    keyCandidates(e.whenFalse, section, consts, out, depth);
  } else if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) {
    keyCandidates(e.left, section, consts, out, depth);
    keyCandidates(e.right, section, consts, out, depth);
  } else if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression(e)) {
    keyCandidates(e.expression, section, consts, out, depth);
  } else if (ts.isIdentifier(e) && depth < 4) {
    const init = constOf(e, consts);
    if (init) keyCandidates(init, section, consts, out, depth + 1);
    else out.dynamic = true;
  } else {
    out.dynamic = true;
  }
}

/** The params argument fills the keys: it calls keyParams() / withKeys(), or uses a const (in scope) that does. */
function fillsKeys(e: ts.Node | undefined, consts: Consts, depth = 0): boolean {
  if (!e) return false;
  let found = false;
  const visit = (n: ts.Node): void => {
    if (found) return;
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === "keyParams" || n.expression.text === "withKeys")) found = true;
    else if (ts.isIdentifier(n)) {
      if (isPropertyName(n) || depth >= 4) return;
      const init = constOf(n, consts);
      if (init && fillsKeys(init, consts, depth + 1)) found = true;
    } else ts.forEachChild(n, visit);
  };
  visit(e);
  return found;
}

/** Every t() / tr() call of one source file. */
function scanSource(file: string, text: string): TCall[] {
  const calls: TCall[] = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const consts = collectConsts(sf);
  const visit = (n: ts.Node): void => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (n.expression.text === "t" || n.expression.text === "tr") && n.arguments.length > 0) {
      const isTr = n.expression.text === "tr";
      const sectionArg = isTr ? n.arguments[1] : undefined;
      const section = sectionArg && ts.isStringLiteral(sectionArg) ? sectionArg.text : null;
      const found = { exact: [] as string[], prefixes: [] as string[], dynamic: false };
      keyCandidates(n.arguments[0]!, isTr ? section : null, consts, found);
      calls.push({
        where: `${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1}`,
        file,
        keyArg: n.arguments[0]!.getText(sf),
        ...found,
        passesKeys: fillsKeys(n.arguments[isTr ? 2 : 1], consts),
      });
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return calls;
}

function scanCalls(): TCall[] {
  return sourceFiles(SRC).flatMap((path) => scanSource(relative(SRC, path).split(sep).join("/"), readFileSync(path, "utf8")));
}

/** Keyed strings a call can print. */
function keyedOf(call: TCall): string[] {
  const out = call.exact.filter((k) => KEYED.has(k));
  for (const p of call.prefixes) for (const k of KEYED) if (k.startsWith(p)) out.push(k);
  return out;
}

/**
 * Strings shown through a model field instead of a t() call that names them: the renderer's call, by the source
 * text of its key argument, must fill the keys.
 */
const RENDERERS: ReadonlyArray<{ keys: RegExp; file: string; keyArg: string }> = [
  { keys: /^feed\./, file: "ui/hud/Feed.ts", keyArg: "entry.key" },
  { keys: /^banner\./, file: "ui/hud/Banner.ts", keyArg: "m.key" },
  { keys: /^banner\./, file: "ui/hud/Banner.ts", keyArg: "m.sub" },
  { keys: /^hud\.hint_/, file: "ui/hud/Hotbar.ts", keyArg: "hint" },
  { keys: /^panels\.(?:ping|emote)Hint$/, file: "ui/panels/RadialMenu.ts", keyArg: "this.hintKey" },
  { keys: /^overlays\.leg\w+Note$/, file: "ui/hud/Legend.ts", keyArg: "n.key" },
  { keys: /^overlays\.mute$/, file: "ui/panels/SettingsMenu.ts", keyArg: "label" },
];

/**
 * The t() / tr() calls whose key is only known at run time and that pass no keys, with the strings each one prints
 * (none may name a key; null = forwards its caller's params). A new such call fails the scan until it is listed
 * here or fills the keys, so a keyed string can't reach the screen through an unchecked renderer.
 */
const PLAIN_RENDERERS: ReadonlyArray<{ file: string; keyArg: string; prints: RegExp | null }> = [
  { file: "ui/dom.ts", keyArg: "key.includes(\".\") ? key : `${section}.${key}`", prints: null }, // tr() itself: each tr() call is checked
  { file: "ui/controls.ts", keyArg: "k", prints: /^overlays\.key_/ }, // the translated key names of the controls list
  { file: "ui/controls.ts", keyArg: "row.action", prints: /^overlays\.ctl_/ },
  { file: "ui/hud/Compass.ts", keyArg: "c.key", prints: /^hud\.compass/ },
  { file: "ui/hud/InteractPrompt.ts", keyArg: "p.key", prints: /^prompt\./ }, // its key cap is a <kbd> of its own
  { file: "ui/hud/InteractPrompt.ts", keyArg: "p.reason", prints: /^reject\./ },
  { file: "ui/hud/Subtitle.ts", keyArg: "entry.key", prints: /^hud\.cap_/ },
  { file: "ui/panels/SettingsMenu.ts", keyArg: "spec.label", prints: /^overlays\.(?:master|music|sfx|sensitivity|fov|hudScale)$/ },
  { file: "ui/panels/SettingsMenu.ts", keyArg: "hint", prints: /^overlays\.(?:mouseLock|reducedFlashing)Hint$/ },
  { file: "ui/screens/Home.ts", keyArg: "what", prints: /^menu\.hint/ }, // the key hint row's actions (its keys are <kbd>s)
  { file: "ui/screens/Home.ts", keyArg: "this.model.error", prints: /^menu\.err/ },
  { file: "ui/screens/Lobby.ts", keyArg: "model.startHint", prints: /^(?:menu|prompt)\.startHint_/ },
];

/** "section.key" of every string. */
const ALL_KEYS: ReadonlyArray<string> = Object.entries(SECTIONS).flatMap(([name, s]) => Object.keys(s.en).map((key) => `${name}.${key}`));

describe("{k…} strings at their call sites", () => {
  const calls = scanCalls();

  it("finds the strings and the calls (the scan is not vacuous)", () => {
    expect(KEYED.size).toBeGreaterThan(40);
    for (const k of ["hud.raftReady", "hud.launchGo", "hud.downSub", "banner.raftReadySub", "feed.downed", "feed.tip_gather", "menu.keyHoldInteract", "overlays.sbHint"]) {
      expect(KEYED.has(k), k).toBe(true);
    }
    expect(calls.length).toBeGreaterThan(300);
    expect(calls.filter((c) => c.passesKeys).length).toBeGreaterThan(15);
  });

  it("every t() / tr() call that names one passes keyParams()", () => {
    const bad = calls.filter((c) => keyedOf(c).length > 0 && !c.passesKeys).map((c) => `${c.where} ${c.keyArg} → ${keyedOf(c).join(", ")}`);
    expect(bad).toEqual([]);
  });

  it("each model-field renderer fills the keys, and every such string is covered by a call or a renderer", () => {
    for (const r of RENDERERS) {
      const hit = calls.find((c) => c.file === r.file && c.keyArg === r.keyArg);
      expect(hit, `${r.file}: t(${r.keyArg}, …)`).toBeDefined();
      expect(hit?.passesKeys, `${r.file}: t(${r.keyArg}, …) fills the keys`).toBe(true);
    }
    const covered = new Set(calls.filter((c) => c.passesKeys).flatMap(keyedOf));
    const uncovered = [...KEYED].filter((k) => !covered.has(k) && !RENDERERS.some((r) => r.keys.test(k)));
    expect(uncovered).toEqual([]);
  });

  it("every call with a run-time key fills the keys or is a listed plain renderer that prints none", () => {
    const listed = (c: TCall) => PLAIN_RENDERERS.some((r) => r.file === c.file && r.keyArg === c.keyArg);
    const unlisted = calls.filter((c) => c.dynamic && !c.passesKeys && !listed(c)).map((c) => `${c.where} ${c.keyArg}`);
    expect(unlisted).toEqual([]);
    for (const r of PLAIN_RENDERERS) {
      const label = `${r.file}: t(${r.keyArg})`;
      expect(calls.some((c) => c.file === r.file && c.keyArg === r.keyArg && c.dynamic && !c.passesKeys), `${label} is still there`).toBe(true);
      if (!r.prints) continue;
      const prints = r.prints;
      expect(ALL_KEYS.some((k) => prints.test(k)), `${label} prints real strings`).toBe(true);
      expect([...KEYED].filter((k) => prints.test(k)), `${label} prints no {k…} string`).toEqual([]);
    }
  });
});

describe("the call-site scan itself", () => {
  const scan = (text: string) => scanSource("x.ts", text);

  it("follows consts in scope and marks what only the run time knows", () => {
    const [a, b, c, d, e] = scan(`
      const KEY = "hud.raftReady";
      function f(model, key) {
        const pick = model.ok ? KEY : \`coach.\${model.id}\`;
        t(pick);
        t(model.key);
        t(key);
        t(\`\${model.section}.x\`);
        tr("downed", "feed", model.params);
      }
    `);
    expect(a).toMatchObject({ exact: ["hud.raftReady"], prefixes: ["coach."], dynamic: false, passesKeys: false });
    expect([b?.dynamic, c?.dynamic, d?.dynamic]).toEqual([true, true, true]);
    expect(e).toMatchObject({ exact: ["feed.downed"], dynamic: false, passesKeys: false });
  });

  it("a params const counts only where it is in scope, and not as a property name", () => {
    const calls = scan(`
      function a() {
        const keys = keyParams();
        t("hud.raftReady", keys);
        const both = { ...keys, n: 1 };
        t("hud.launchGo", both);
      }
      function b(keys) {
        t("hud.downSub", keys);
        t("hud.downSub", { keys: 1 });
        t("hud.downSub", this.keys);
      }
      function c() {
        t("hud.downSub", { keys });
        t("hud.downSub", withKeys({ n: 2 }));
      }
    `);
    expect(calls.map((x) => x.passesKeys)).toEqual([true, true, false, false, false, false, true]);
    const shadowed = scan(`
      const keys = keyParams();
      t("hud.raftReady", keys);
      function d(keys) {
        t("hud.raftReady", keys);
      }
    `);
    expect(shadowed.map((x) => x.passesKeys)).toEqual([true, false]);
  });
});

/* ------------------------------------------------------- the real renderers */

describe("HUD widgets print the player's keys", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    settings.set({ keyPreset: "leftHanded" });
  });
  afterEach(() => {
    settings.set({ keyPreset: "standard" });
    vi.useRealTimers();
  });

  it("feed: every feed.* line with a key, coach fallbacks and the downed line included", () => {
    const f = new Feed();
    const keyed = [...KEYED].filter((k) => k.startsWith("feed."));
    expect(keyed.length).toBeGreaterThan(10);
    for (const key of keyed) {
      f.clear();
      f.push({ key, params: { name: "Sam" }, icon: "", tone: "info" });
      const text = fake(f.el).textContent;
      expect(text, key).not.toMatch(KEY_PLACEHOLDER);
      expect(text, key).not.toBe("");
    }
    f.clear();
    f.push({ key: "feed.downed", params: { name: "Sam" }, icon: "💀", tone: "bad" });
    expect(fake(f.el).textContent).toBe("💀Sam is down! Hold U to revive");
    f.push({ key: "feed.tip_gather", icon: "💡", tone: "info" });
    expect(f.history.at(-1)?.text).toBe("Hold U on trees, rocks and bushes to gather wood, stone and rope.");
    f.clear();
  });

  it("banner: both lines, whatever the key spelling", () => {
    const b = new Banner();
    b.show({ key: "banner.raftReady", sub: "banner.raftReadySub", tone: "gold" }, true);
    expect(fake(b.el).textContent).toContain("Everyone press U on the raft to board");
    b.show({ key: "raftReady", sub: "raftReadySub", tone: "gold" }, true);
    expect(fake(b.el).textContent).not.toMatch(KEY_PLACEHOLDER);
    b.clear();
  });

  it("boarding countdown, raft card, downed screen and stats table, re-printed after a preset change", () => {
    const launch = new LaunchCountdown();
    launch.update({ secLeft: 12, aboard: 1, total: 3 }, false);
    expect(fake(launch.el).shownText).toContain("Run to the raft and press U!");

    const raft = new RaftProgress();
    const ready = { stage: 3 as const, parts: [], ready: true, aboard: 0, total: 3 };
    raft.update(ready);
    expect(fake(raft.el).shownText).toContain("READY! Press U on it");

    const down = new DownedScreen();
    down.update({ secLeft: 20, revive: 0 });
    expect(fake(down.el).shownText).toContain("they can hold U on you");

    const sb = new Scoreboard();
    sb.set([]);
    expect(fake(sb.el).shownText).toContain("Hold \\");

    settings.set({ keyPreset: "standard" });
    launch.update({ secLeft: 11, aboard: 1, total: 3 }, false);
    raft.update(ready);
    down.update({ secLeft: 19, revive: 0 });
    sb.set([]);
    expect(fake(launch.el).shownText).toContain("press E!");
    expect(fake(raft.el).shownText).toContain("READY! Press E on it");
    expect(fake(down.el).shownText).toContain("they can hold E on you");
    expect(fake(sb.el).shownText).toContain("Hold Tab");
  });

  it("guide header: the release key once, as text (no <kbd> repeating it)", () => {
    const legend = new Legend();
    const head = () => fake(fake(legend.el).kids[0]).shownText;
    legend.setOpen(true, [], 0);
    expect(head()).toBe(`🗺️ ${t("overlays.legendTitle")}Release P to close`);
    legend.setOpen(false, [], 0);
    settings.set({ keyPreset: "standard" });
    legend.setOpen(true, [], 0);
    expect(head()).toBe(`🗺️ ${t("overlays.legendTitle")}Release H to close`);
  });
});

describe("Home prints the keys of the player's keyboard", () => {
  afterEach(() => resetKeyCaps());

  it("re-prints the hint row and the device card once the layout map arrives, with no model update", async () => {
    const home = new HomeScreen(new Emitter<UiEventMap>());
    const root = fake(home.el);
    expect(root.shownText).toContain("WASD walk");
    expect(root.textContent).toContain("You walk with WASD");
    const azerty = new Map([
      ["KeyW", "z"],
      ["KeyA", "q"],
      ["KeyQ", "a"],
    ]);
    expect(await loadKeyboardLayout({ keyboard: { getLayoutMap: async () => azerty } })).toBe(true);
    expect(root.shownText).toContain("ZQSD walk");
    expect(root.shownText).not.toContain("WASD");
    expect(root.textContent).toContain("You walk with ZQSD");
    resetKeyCaps();
    expect(root.shownText).toContain("WASD walk");
  });
});
