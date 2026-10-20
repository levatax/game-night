// Home + Lobby screens (§16.1, §16.2). Owner: client-menu. PUBLIC API IS THE CONTRACT.
// Helpers under ui/menu/** (HomeScreen, LobbyScreen, portraits, copy, dom), styles in ui/menu.css. All text Turkish.
//
// Home: flickering neon "KASALA!" logo (Monoton, .ks-neon), tagline, nickname field (NICKNAME_MAX, remembered
// via NICKNAME_STORAGE_KEY), big "Masa Kur" (create) and "Masaya Otur" (join with a 4-letter code input;
// auto-uppercase, CODE_ALPHABET only), a "play alone with bots" hint. Inline error line. Busy state on the
// buttons while connecting. A small "← Oyun Gecesi" link back to the hub portal ("/"). The 3D scene (Cemil
// shuffling) shows behind it; the panel stays compact on the left so the table stays visible.
// Lobby: big room code + "Linki kopyala" (copies `${location.origin}/r/${code}`, toast "Kopyalandı!"), up to
// MAX_PLAYERS player cards (SVG animal heads in a player-color fedora, nickname, color, "Hazır ✓", host crown,
// "sen" tag, "🤖 BOT" tag), the host's "🤖 Bot ekle" on the first empty chair and "✕ Çıkar" on bot cards, my
// animal + hat color picker (taken ones disabled), a 3-step "Nasıl oynanır" strip, host settings (read-only +
// live for the others), "Hazırım" toggle, "Başlat" for the host (locked with the reason until ≥ MIN_PLAYERS
// connected players or bots and everyone ready), "Masadan kalk". Spectators aren't shown in the lobby.
// The neon flicker / siren beam calm down with prefers-reduced-motion or settings.reducedFlashing.
//
// Also owns `games/kasala/cover.svg`: the 16:10 hub card art.

import "./menu.css";
import type { Animal } from "../../../shared/constants";
import type { KasalaStateView, SettingsMsg } from "../../../shared/protocol";
import { settings } from "../app/settings";
import type { UiSound } from "../app/ui";
import { addKeyGate } from "./keyGate";
import { h, replay } from "./menu/dom";
import { HomeScreen } from "./menu/HomeScreen";
import { LobbyScreen } from "./menu/LobbyScreen";

export interface MenuCallbacks {
  onCreate(nickname: string): void;
  onJoin(code: string, nickname: string): void;
  onReady(ready: boolean): void;
  onAnimal(animal: Animal): void;
  onColor(color: number): void;
  onSettings(patch: SettingsMsg): void;
  onStart(): void;
  onLeave(): void;
  /** Host, lobby: seat a bot in the first free chair (net.addBot). */
  onAddBot(): void;
  /** Host, lobby: remove that bot (net.removeBot). */
  onRemoveBot(id: string): void;
  onUiSound(kind: UiSound): void;
}

export class Menu {
  private readonly el: HTMLElement;
  private readonly home: HomeScreen;
  private readonly lobby: LobbyScreen;
  private readonly toastEl: HTMLElement;
  private toastTimer = 0;
  private lastHover = 0;

  constructor(root: HTMLElement, cb: MenuCallbacks) {
    this.el = h("div", "ks-menu");
    root.appendChild(this.el);

    const sound = (kind: UiSound) => cb.onUiSound(kind);
    this.home = new HomeScreen({ onCreate: (n) => cb.onCreate(n), onJoin: (c, n) => cb.onJoin(c, n), sound });
    this.lobby = new LobbyScreen({
      onReady: (r) => cb.onReady(r),
      onAnimal: (a) => cb.onAnimal(a),
      onColor: (c) => cb.onColor(c),
      onSettings: (p) => cb.onSettings(p),
      onStart: () => cb.onStart(),
      onLeave: () => cb.onLeave(),
      onAddBot: () => cb.onAddBot(),
      onRemoveBot: (id) => cb.onRemoveBot(id),
      sound,
      toast: (text, ms) => this.toast(text, ms),
    });
    this.toastEl = h("div", "ks-menu-toast", { role: "status", "aria-live": "polite" });
    this.el.append(this.home.el, this.lobby.el, this.toastEl);

    // Shared button feel: squish on press, click + throttled hover sounds (delegated).
    this.el.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement).closest("button");
      if (!btn || btn.disabled) return;
      replay(btn, "ks-menu-squish");
      if (!btn.matches(".ks-menu-animal, .ks-menu-swatch, .ks-menu-ready, .ks-menu-dice, .ks-menu-seg-btn, .ks-menu-copy, .ks-menu-start")) {
        cb.onUiSound("click");
      }
    });
    this.el.addEventListener("pointerover", (e) => {
      const btn = (e.target as HTMLElement).closest("button, summary, .ks-menu-back");
      if (!btn || (btn as HTMLButtonElement).disabled) return;
      if (e.relatedTarget instanceof Node && btn.contains(e.relatedTarget)) return;
      const now = performance.now();
      if (now - this.lastHover < 80) return;
      this.lastHover = now;
      cb.onUiSound("hover");
    });

    const applyCalm = () => this.el.classList.toggle("ks-menu--calm", settings.get().reducedFlashing);
    applyCalm();
    settings.onChange(applyCalm);
    addKeyGate(() => this.capturesKeys());

    this.show(null);
  }

  /** Home screen. `code` prefills the join field (?room=CODE / share link). */
  showHome(opts: { nickname: string; code?: string; error?: string }): void {
    this.show(this.home.el);
    this.home.show(opts);
  }

  /** Disable the home buttons while connecting (label e.g. "Bağlanıyor…"). */
  setBusy(busy: boolean, label?: string): void {
    this.home.setBusy(busy, label);
  }

  showError(text: string): void {
    if (!this.home.el.hidden) this.home.showError(text);
    else {
      this.home.setBusy(false);
      this.toast(text, 4000, true);
    }
  }

  showLobby(): void {
    this.home.setBusy(false);
    if (this.lobby.el.hidden) this.show(this.lobby.el);
  }

  /** Every patch while in the lobby. */
  updateLobby(state: KasalaStateView, myId: string): void {
    this.lobby.update(state, myId);
  }

  /** Hide both screens (match running). */
  hide(): void {
    this.show(null);
  }

  /** True while the nickname/code inputs (or a lobby select) have focus (game keys must be ignored). */
  capturesKeys(): boolean {
    if (this.el.hidden) return false;
    const a = document.activeElement;
    if (!a || !this.el.contains(a)) return false;
    return a instanceof HTMLInputElement ? a.type === "text" : a instanceof HTMLSelectElement || a instanceof HTMLTextAreaElement;
  }

  // ------------------------------------------------------------------ internals
  private show(screen: HTMLElement | null): void {
    const active = document.activeElement;
    for (const s of [this.home.el, this.lobby.el]) {
      const on = s === screen;
      if (!on && active instanceof HTMLElement && s.contains(active)) active.blur();
      if (s.hidden === !on && !on) continue;
      s.hidden = !on;
      if (on) replay(s, "ks-menu-enter");
      if (s === this.lobby.el) this.lobby.setVisible(on);
    }
    this.el.hidden = screen === null;
    if (screen === null) this.hideToast();
  }

  private toast(text: string, ms = 1800, bad = false): void {
    window.clearTimeout(this.toastTimer);
    this.toastEl.textContent = text;
    this.toastEl.classList.toggle("ks-menu-toast--bad", bad);
    this.toastEl.hidden = false;
    replay(this.toastEl, "ks-menu-toast--in");
    this.toastTimer = window.setTimeout(() => this.hideToast(), ms);
  }

  private hideToast(): void {
    window.clearTimeout(this.toastTimer);
    this.toastEl.hidden = true;
    this.toastEl.classList.remove("ks-menu-toast--in");
  }
}
