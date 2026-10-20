// Cemil Abi subtitle (§11, §15): a compact caption in the bottom-left corner, right above my kasa chip
// ("🐊 Sen · Bir kart daha mı evlat?", at most three lines within the corner's width), faded in (no typewriter),
// held briefly, gone. Down there it never covers the faces and name labels across the table (first person) or
// the wheel, and the corner column keeps it clear of the buttons and the bet tray. Off when settings.subtitles
// is off (also hides a line that is showing).

import { settings } from "../../app/settings";
import { h, setText, show } from "./dom";

const MIN_SEC = 1.8;
const MAX_SEC = 4.5;

export class Subtitle {
  readonly root: HTMLDivElement;
  private readonly who: HTMLSpanElement;
  private readonly text: HTMLSpanElement;
  private left = 0;
  private enabled = settings.get().subtitles;

  constructor(parent: HTMLElement) {
    this.root = h("div", "ks-hud-sub", parent);
    h("span", "ks-hud-sub__croc", this.root, "🐊");
    this.who = h("span", "ks-hud-sub__who", this.root);
    this.text = h("span", "ks-hud-sub__text", this.root);
    settings.onChange((s) => {
      this.enabled = s.subtitles;
      if (!s.subtitles) this.hide();
    });
  }

  /** `line` is "Cemil Abi: …" or "Cemil Abi → Kedi: …" (Game's format); the speaker becomes the croc. */
  say(line: string, sec: number): void {
    if (!this.enabled) return;
    const m = /^([^:]{1,40}):\s*(.*)$/s.exec(line);
    let who = "";
    let body = line;
    if (m) {
      body = m[2];
      const arrow = m[1].indexOf("→");
      who = arrow >= 0 ? m[1].slice(arrow + 1).trim() : /cemil/i.test(m[1]) ? "" : m[1].trim();
    }
    setText(this.who, who);
    show(this.who, who !== "");
    setText(this.text, body);
    this.root.title = body;
    this.left = Math.min(MAX_SEC, Math.max(MIN_SEC, sec + 0.2));
    show(this.root, true);
  }

  hide(): void {
    this.left = 0;
    show(this.root, false);
  }

  tick(dt: number): void {
    if (this.left <= 0) return;
    this.left -= dt;
    if (this.left <= 0) this.hide();
  }
}
