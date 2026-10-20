// Center-top transient banner ("SIRA SENDE!", rare/attack card names): a compact sticker that pops in once,
// rests, then fades up and away. A new banner replaces the old. Game only calls it for turn changes and rare+
// cards (turn outcomes are fx.slam's), so its life is short.

import { h, replay, setText, setVar, show } from "./dom";

export class Banner {
  readonly root: HTMLDivElement;
  private readonly main: HTMLDivElement;
  private readonly sub: HTMLDivElement;
  private left = 0;
  private leaving = false;

  constructor(parent: HTMLElement) {
    this.root = h("div", "ks-hud-banner", parent);
    this.main = h("div", "ks-hud-banner__main", this.root);
    this.sub = h("div", "ks-hud-banner__sub", this.root);
  }

  get showing(): boolean {
    return this.left > 0 || this.leaving;
  }

  show(text: string, color: string, sub?: string): void {
    setText(this.main, text);
    setText(this.sub, sub ?? "");
    show(this.sub, !!sub);
    setVar(this.root, "--bc", color || "#FFF4DF");
    this.root.classList.remove("ks-hud-banner--out");
    show(this.root, true);
    replay(this.root, "ks-hud-banner--in");
    this.left = 1.2 + Math.min(1.1, (text.length + (sub?.length ?? 0) * 0.5) * 0.04);
    this.leaving = false;
  }

  hide(): void {
    this.left = 0;
    this.leaving = false;
    this.root.classList.remove("ks-hud-banner--in", "ks-hud-banner--out");
    show(this.root, false);
  }

  tick(dt: number): void {
    if (this.left <= 0 && !this.leaving) return;
    this.left -= dt;
    if (!this.leaving && this.left <= 0) {
      this.leaving = true;
      this.left = 0.25;
      this.root.classList.add("ks-hud-banner--out");
      return;
    }
    if (this.leaving && this.left <= 0) this.hide();
  }
}
