// In-game loan, score, settings, reaction, mugshot, round summary and match-end windows.
// Helpers under ui/overlays/** (OfferDock, SettingsPanel, scoreboard, matchEnd, dom), styles in ui/overlays.css.
// Nothing here sits over the felt unless the player asked for it: loan offers dock to the right edge (only the
// recipient's Kabul / Reddet take clicks), the emote / taunt picker floats above the HUD's action stack, and
// the shame titles + standings dock to the bottom so the 3D podium stays in view.
import "./overlays.css";
import { linesFor, lineDurationSec, type AnnouncerEvent } from "../../../shared/announcer";
import { EMOTES, LOAN_MAX_PCT, LOAN_MIN, LOAN_RATES, TAUNTS, type EmoteId } from "../../../shared/constants";
import type { DebtView, KasalaStateView, LoanKind, MatchEndMsg, PlayerView, RoundEndMsg } from "../../../shared/protocol";
import { settings } from "../app/settings";
import { money, toName, type UiSound } from "../app/ui";
import { addKeyGate } from "./keyGate";
import { botBadge, btn, face, h, kbd, nameTag, vals, who } from "./overlays/dom";
import { collectionsView, podiumView, titleView } from "./overlays/matchEnd";
import { OfferDock } from "./overlays/OfferDock";
import { buildScoreboard, scoreSignature } from "./overlays/scoreboard";
import { SettingsPanel } from "./overlays/SettingsPanel";

export type MatchEndStep = "collections" | "title" | "podium";
export interface OverlayCallbacks {
  onPropose(toId: string, kind: LoanKind, amount: number, ratePct: number): void;
  onRespond(offerId: string, accept: boolean): void;
  onCancelOffer(offerId: string): void;
  onRepay(debtId: string, amount: number): void;
  onEmote(emote: EmoteId): void;
  onTaunt(index: number): void;
  onRematch(): void;
  onLeave(): void;
  onStep(step: MatchEndStep, index: number): void;
  onUiSound(kind: UiSound): void;
}
type Modal = "loans" | "settings" | "score" | null;

/**
 * Match-end pacing mirrors the server's announcer script (server/room/announce.ts matchEndScript), so each shame
 * title is on screen while Cemil Abi reads it and the podium arrives with his "gecenin babası" line.
 */
const TITLE_STEP_SEC = 2.2;
const LINE_GAP_SEC = 0.35;
const eventSec = (event: AnnouncerEvent): number => linesFor(event).reduce((m, l) => Math.max(m, lineDurationSec(l.text)), 0);
/** HUD elements the picker must clear (ÇEVİR / KASALA!, the target prompt, subtitles). */
const HUD_BOTTOM = ".ks-hud-bottom";

export class Overlays {
  private readonly cb: OverlayCallbacks;
  private readonly root = h("div", "ks-ov");
  private readonly backdrop = h("div", "ks-ov-backdrop");
  private readonly endShade = h("div", "ks-ov-end-shade");
  private readonly picker = h("div", "ks-ov-picker");
  private readonly mug = h("div", "ks-ov-mugshot");
  private readonly round = h("div", "ks-ov-round");
  private readonly end = h("section", "ks-ov-end");
  private readonly endBody = h("div", "ks-ov-body");
  /** Podium only: Rövanş / Masadan kalk, outside the scrolling body so they never scroll out of view. */
  private readonly endFoot = h("div", "ks-ov-end__foot");
  private readonly offers: OfferDock;
  private readonly settingsUi: SettingsPanel;
  private readonly loans: HTMLElement;
  private readonly loanBody: HTMLElement;
  private readonly score: HTMLElement;
  private readonly scoreBody: HTMLElement;
  private readonly settingsPanel: HTMLElement;
  private state: KasalaStateView | null = null;
  private myId = "";
  private modal: Modal = null;
  private selectedId = "";
  private amount = 100;
  private rate: number = LOAN_RATES[0];
  private loanKey = "";
  private scoreKey = "";
  private mugTime = 0;
  private roundTime = 0;
  private endMsg: MatchEndMsg | null = null;
  private endState: KasalaStateView | null = null;
  private step: MatchEndStep = "collections";
  private stepIndex = 0;
  private stepTime = 0;
  private lastHover = 0;

  constructor(root: HTMLElement, cb: OverlayCallbacks) {
    this.cb = cb;
    root.appendChild(this.root);
    this.backdrop.hidden = this.endShade.hidden = true;
    this.backdrop.addEventListener("click", () => { if (this.closeTop()) this.sound("close"); });
    this.root.append(this.endShade, this.backdrop);
    [this.loans, this.loanBody] = this.dialog("loans", "📒 Borç Masası", "Borç ver, borç iste ve hesabını kapat.");
    [this.score, this.scoreBody] = this.dialog("score", "🏆 Kasa Tablosu", "Masadaki bütün hesaplar.");
    let settingsBody: HTMLElement;
    [this.settingsPanel, settingsBody] = this.dialog("settings", "⚙️ Ayarlar", "Kamera, ses, görüntü ve kontroller.");
    this.settingsUi = new SettingsPanel(settingsBody, {
      onClose: () => { this.setModal(null); this.sound("close"); },
      onLeave: () => cb.onLeave(),
      sound: (kind) => this.sound(kind),
      inMatch: () => this.seatedInMatch(),
    });
    this.offers = new OfferDock(this.root, {
      onRespond: (id, accept) => cb.onRespond(id, accept),
      sound: (kind) => this.sound(kind),
      keysAllowed: () => !this.modal && !this.endMsg,
    });
    this.picker.hidden = this.mug.hidden = this.round.hidden = this.end.hidden = true;
    this.picker.setAttribute("role", "menu");
    this.end.setAttribute("aria-label", "Maç sonucu");
    this.endFoot.hidden = true;
    this.end.append(this.endBody, this.endFoot);
    this.round.setAttribute("role", "status");
    this.root.append(this.picker, this.mug, this.round, this.end);
    this.root.addEventListener("pointerover", (event) => {
      const target = event.target instanceof Element ? event.target.closest("button") : null;
      if (!target || (target as HTMLButtonElement).disabled) return;
      if (event.relatedTarget instanceof Node && target.contains(event.relatedTarget)) return;
      const now = performance.now();
      if (now - this.lastHover > 80) { this.lastHover = now; this.sound("hover"); }
    });
    const calm = () => this.root.classList.toggle("ks-ov--calm", settings.get().reducedFlashing);
    calm();
    settings.onChange(calm);
    addKeyGate(() => this.capturesKeys());
  }

  update(state: KasalaStateView, myId: string): void {
    this.state = state;
    this.myId = myId;
    this.offers.render(state, myId);
    if (this.modal === "loans") this.renderLoans();
    if (this.modal === "score") this.renderScore();
  }
  tick(dt: number): void {
    if (this.mugTime > 0 && (this.mugTime -= dt) <= 0) this.mug.hidden = true;
    if (this.roundTime > 0 && (this.roundTime -= dt) <= 0) this.round.hidden = true;
    if (!this.endMsg || this.step === "podium" || (this.stepTime -= dt) > 0) return;
    if (this.step === "collections") { this.step = this.endMsg.titles.length ? "title" : "podium"; this.stepIndex = 0; }
    else if (this.stepIndex + 1 < this.endMsg.titles.length) this.stepIndex++;
    else this.step = "podium";
    this.showEndStep();
  }
  toggleLoans(open?: boolean, playerId?: string): void {
    if (open ?? this.modal !== "loans") {
      if (playerId) { this.selectedId = playerId; this.amount = 100; }
      this.setModal("loans"); this.loanKey = ""; this.renderLoans();
    } else if (this.modal === "loans") this.setModal(null);
  }
  setScoreboard(open: boolean): void {
    if (open) { this.setModal("score"); this.scoreKey = ""; this.renderScore(); }
    else if (this.modal === "score") this.setModal(null);
  }
  toggleSettings(open?: boolean): void {
    if (open ?? this.modal !== "settings") { this.settingsUi.sync(); this.setModal("settings"); }
    else if (this.modal === "settings") this.setModal(null);
  }
  openPicker(kind: "emote" | "taunt" | null): void {
    this.picker.hidden = kind === null;
    this.picker.replaceChildren();
    if (!kind) return;
    this.placePicker();
    this.picker.setAttribute("aria-label", kind === "emote" ? "Emote seç" : "Laf sok");
    this.picker.appendChild(h("h3", "", kind === "emote" ? "🎭 Emote seç" : "💬 Laf sok"));
    const item = (key: string, label: string, action: () => void) => {
      const b = btn("", action, undefined, "ks-ov-picker__item");
      b.setAttribute("role", "menuitem");
      b.append(kbd(key), h("span", "", label));
      this.picker.appendChild(b);
    };
    if (kind === "emote") EMOTES.forEach((em, i) => item(String(i + 1), `${em.icon} ${em.label}`, () => this.cb.onEmote(em.id)));
    else TAUNTS.forEach((line, i) => item(String(i + 1), line, () => this.cb.onTaunt(i)));
    this.picker.appendChild(h("p", "ks-ov-picker__hint", "Rakamla seç · Esc kapatır"));
  }
  closeTop(): boolean { if (!this.modal) return false; this.setModal(null); return true; }
  /** Closes every modal, picker, offer card and the match end (leaving the room / going home). */
  closeAll(): void {
    this.modal = null;
    this.loans.hidden = this.score.hidden = this.settingsPanel.hidden = true;
    this.openPicker(null);
    this.mug.hidden = true; this.mugTime = 0;
    this.round.hidden = true; this.roundTime = 0;
    this.hideMatchEnd();
    this.offers.clear();
    this.state = null;
    this.loanKey = this.scoreKey = "";
    this.syncBackdrop();
  }
  capturesKeys(): boolean { return this.modal === "loans" || this.modal === "settings" || !!this.endMsg; }
  mugshot(player: PlayerView): void {
    const card = h("div", "ks-ov-mugshot__card");
    card.append(h("h2", "", "SABIKA FOTOĞRAFI"), face(player), h("strong", "", player.nickname), h("p", "", "SUÇU: Bir kart daha çevirmek."));
    this.mug.replaceChildren(card);
    this.mug.hidden = false; this.mugTime = 2.5;
  }
  /** Between full rounds: who has what and how this round went for them, while the room pauses (msg.pauseSec). */
  roundSummary(msg: RoundEndMsg, state: KasalaStateView, myId: string): void {
    if (msg.pauseSec <= 0) return;
    const card = h("div", "ks-ov-round__card");
    card.appendChild(h("h2", "", `${msg.round}. TUR BİTTİ`));
    const list = h("ol", "ks-ov-round__list");
    msg.standings.forEach((row, i) => {
      const p = state.players.get(row.playerId);
      if (!p) return;
      const li = h("li");
      li.style.setProperty("--i", String(i));
      if (p.id === myId) li.dataset.me = "true";
      if (p.ghost) li.dataset.ghost = "true";
      const tone = row.delta > 0 ? "ks-ov-pos" : row.delta < 0 ? "ks-ov-neg" : "";
      li.append(
        h("span", "ks-ov-round__rank", i === 0 && !p.ghost ? "👑" : String(i + 1)),
        nameTag(p),
        h("strong", "ks-ov-round__kasa", money(row.kasa)),
        h("span", `ks-ov-round__delta ${tone}`, row.delta ? money(row.delta, true) : "±0$"),
      );
      list.appendChild(li);
    });
    card.appendChild(list);
    const next = msg.finalTableNext ? "Sıradaki tur SON MASA: her şey ×2!" : `Sıradaki tur: ${msg.round + 1}/${state.totalRounds}`;
    card.appendChild(h("p", msg.finalTableNext ? "ks-ov-round__next ks-ov-round__next--final" : "ks-ov-round__next", next));
    this.round.replaceChildren(card);
    this.round.hidden = false;
    this.roundTime = msg.pauseSec;
  }
  matchEnd(msg: MatchEndMsg, state: KasalaStateView, myId: string): void {
    this.state = this.endState = state; this.myId = myId; this.endMsg = msg;
    this.step = "collections"; this.stepIndex = 0;
    this.setModal(null); this.openPicker(null); this.mug.hidden = this.round.hidden = true;
    this.offers.clear();
    this.end.hidden = false; this.showEndStep();
  }
  hideMatchEnd(): void {
    this.endMsg = null; this.endState = null; this.end.hidden = true; this.endBody.replaceChildren();
    this.endFoot.replaceChildren(); this.endFoot.hidden = true;
    this.end.className = "ks-ov-end";
    this.endShade.hidden = true;
    this.syncBackdrop();
  }

  private dialog(kind: Exclude<Modal, null>, title: string, sub: string): [HTMLElement, HTMLElement] {
    const panel = h("section", `ks-ov-dialog ks-ov-${kind}`);
    panel.hidden = true; panel.setAttribute("role", "dialog"); panel.setAttribute("aria-modal", "true"); panel.setAttribute("aria-label", title);
    const head = h("div", "ks-ov-head");
    const text = h("div"); text.append(h("h2", "ks-ov-title", title), h("p", "", sub));
    head.append(text, btn("✕", () => { this.setModal(null); this.sound("close"); }, "ghost", "ks-ov-close"));
    const body = h("div", "ks-ov-body"); panel.append(head, body); this.root.appendChild(panel);
    return [panel, body];
  }
  private setModal(modal: Modal): void {
    if (this.modal === modal) return;
    this.modal = modal;
    this.loans.hidden = modal !== "loans"; this.score.hidden = modal !== "score"; this.settingsPanel.hidden = modal !== "settings";
    this.syncBackdrop();
    if (modal) this.sound("open");
  }
  /** The dimmed, blurred backdrop is for modals and the debt collection only (titles / podium keep the 3D in view). */
  private syncBackdrop(): void {
    this.backdrop.hidden = !this.modal && !(this.endMsg && this.step === "collections");
  }
  private sound(kind: UiSound): void { this.cb.onUiSound(kind); }
  private seatedInMatch(): boolean {
    const s = this.state, me = s?.players.get(this.myId);
    return !!s && !!me && !me.spectator && s.phase !== "lobby" && s.phase !== "matchEnd";
  }

  /** Float the picker just above the HUD's bottom stack (measured on open; CSS keeps a safe minimum). */
  private placePicker(): void {
    const stack = document.querySelector<HTMLElement>(HUD_BOTTOM);
    const rect = stack?.getBoundingClientRect();
    const own = this.root.getBoundingClientRect();
    const clear = rect && rect.height > 0 ? Math.max(0, own.bottom - rect.top) : 0;
    this.picker.style.setProperty("--ov-hud-clear", `${Math.round(clear)}px`);
  }

  private loanSignature(s: KasalaStateView): string {
    return `${this.myId}:${s.phase}:${s.settings.loans}:${this.selectedId}:${this.rate}|` +
      vals(s.players).map((p) => `${p.id}:${p.nickname}:${p.kasa}:${p.ghost}:${p.spectator}:${p.connected}:${p.bot}`).join("|") +
      vals(s.debts).map((d) => `${d.id}:${d.owed}`).join("|") + vals(s.offers).map((o) => o.id).join("|");
  }
  private renderLoans(): void {
    const s = this.state; if (!s) return;
    const key = this.loanSignature(s); if (key === this.loanKey) return; this.loanKey = key;
    this.loanBody.replaceChildren();
    const me = s.players.get(this.myId);
    if (!s.settings.loans) { this.loanBody.appendChild(h("p", "", "Bu masada borç sistemi kapalı.")); return; }
    if (!me || me.spectator || me.ghost || s.phase === "lobby" || s.phase === "matchEnd") {
      this.loanBody.appendChild(h("p", "", "Şu anda borç işlemi yapamazsın.")); return;
    }
    const others = vals(s.players).filter((p) => p.id !== this.myId && !p.spectator && !p.ghost);
    if (!others.some((p) => p.id === this.selectedId && p.connected)) this.selectedId = others.find((p) => p.connected)?.id ?? "";
    this.loanBody.appendChild(h("h3", "", "Kiminle iş yapacaksın?"));
    const people = h("div", "ks-ov-players");
    for (const p of others) {
      const b = btn("", () => { this.selectedId = p.id; this.amount = 100; this.loanKey = ""; this.renderLoans(); this.sound("click"); }, undefined, "ks-ov-player");
      b.dataset.selected = String(p.id === this.selectedId);
      b.disabled = !p.connected;
      const info = h("span"); info.append(h("strong", "", p.nickname));
      if (p.bot) info.appendChild(botBadge());
      info.appendChild(h("small", "", ` · ${money(p.kasa)} kasa`));
      if (!p.connected) info.appendChild(h("small", "", " · Bağlı değil"));
      b.append(face(p), info); people.appendChild(b);
    }
    this.loanBody.appendChild(people);
    const target = others.find((p) => p.id === this.selectedId);
    if (target) this.loanBody.appendChild(this.contract(me, target));
    this.loanBody.appendChild(h("hr"));
    this.loanBody.appendChild(h("h3", "", "Açık hesaplar"));
    const debts = vals(s.debts).filter((d) => d.owed > 0 && (d.borrowerId === this.myId || d.lenderId === this.myId));
    if (!debts.length) this.loanBody.appendChild(h("p", "", "Defter şimdilik tertemiz."));
    for (const d of debts) this.loanBody.appendChild(this.debtRow(s, me, d));
    const outgoing = vals(s.offers).filter((o) => o.fromId === this.myId);
    if (outgoing.length) {
      this.loanBody.appendChild(h("h3", "", "Bekleyen teklifler"));
      for (const o of outgoing) {
        const row = h("div", "ks-ov-actions");
        row.append(h("span", "", `${who(s, o.toId)} · ${money(o.amount)} · %${o.ratePct} tur faizi`), btn("Vazgeç", () => { this.cb.onCancelOffer(o.id); this.sound("click"); }, "ghost"));
        this.loanBody.appendChild(row);
      }
    }
  }
  private contract(me: PlayerView, target: PlayerView): HTMLElement {
    const form = h("section");
    form.appendChild(h("h3", "", `${target.nickname} ile anlaşma`));
    const lend = Math.floor(me.kasa * LOAN_MAX_PCT), borrow = Math.floor(target.kasa * LOAN_MAX_PCT);
    const max = Math.max(lend, borrow);
    this.amount = Math.max(LOAN_MIN, Math.min(this.amount, Math.max(LOAN_MIN, max)));
    const field = h("div", "ks-ov-field");
    field.appendChild(h("label", "", "Miktar"));
    const amountLabel = h("strong", "", money(this.amount));
    const slider = h("input");
    slider.type = "range"; slider.min = String(LOAN_MIN); slider.max = String(Math.max(LOAN_MIN, max)); slider.value = String(this.amount); slider.disabled = max < LOAN_MIN;
    field.append(amountLabel, slider, h("small", "", `Teklif sınırı ${money(lend)} · İstek sınırı ${money(borrow)}`));
    form.appendChild(field);
    const rateField = h("div", "ks-ov-field"); rateField.appendChild(h("label", "", "Tur faizi"));
    const rates = h("div", "ks-ov-actions");
    for (const r of LOAN_RATES) {
      const b = btn(`%${r}`, () => { this.rate = r; [...rates.querySelectorAll("button")].forEach((x) => x.dataset.selected = String(x === b)); this.sound("click"); });
      b.dataset.selected = String(r === this.rate); rates.appendChild(b);
    }
    rateField.appendChild(rates); form.appendChild(rateField);
    const actions = h("div", "ks-ov-actions");
    const offer = btn("💵 Teklif Et", () => { this.cb.onPropose(target.id, "offer", this.amount, this.rate); this.sound("chip"); }, "green");
    const request = btn("🤝 Borç İste", () => { this.cb.onPropose(target.id, "request", this.amount, this.rate); this.sound("chip"); });
    const updateAmount = () => {
      this.amount = Math.floor(Number(slider.value)); amountLabel.textContent = money(this.amount);
      offer.disabled = lend < LOAN_MIN || this.amount > lend;
      request.disabled = borrow < LOAN_MIN || this.amount > borrow;
    };
    slider.addEventListener("input", updateAmount); updateAmount();
    actions.append(offer, request); form.appendChild(actions);
    return form;
  }
  private debtRow(s: KasalaStateView, me: PlayerView, d: DebtView): HTMLElement {
    const owe = d.borrowerId === this.myId;
    const row = h("div", "ks-ov-field");
    const other = who(s, owe ? d.lenderId : d.borrowerId);
    row.append(h("strong", "", owe ? `${toName(other)} borçlusun: ${money(d.owed)}` : `${other} sana ${money(d.owed)} borçlu`), h("small", "", `Anapara ${money(d.principal)} · tur faizi %${d.ratePct}`));
    if (owe) {
      const max = Math.min(me.kasa, d.owed);
      const pay = h("div", "ks-ov-actions");
      const slider = h("input");
      slider.type = "range"; slider.min = "1"; slider.max = String(Math.max(1, max)); slider.value = String(Math.max(1, max)); slider.disabled = max < 1;
      const amount = h("span", "", money(max));
      slider.addEventListener("input", () => { amount.textContent = money(Number(slider.value)); });
      const b = btn("Öde", () => { this.cb.onRepay(d.id, Math.floor(Number(slider.value))); this.sound("chip"); }, "green"); b.disabled = max < 1;
      pay.append(slider, amount, b); row.appendChild(pay);
    }
    return row;
  }

  private renderScore(): void {
    const s = this.state; if (!s) return;
    const key = scoreSignature(s, this.myId);
    if (key === this.scoreKey) return; this.scoreKey = key;
    this.scoreBody.replaceChildren(...buildScoreboard(s, this.myId));
  }

  private showEndStep(): void {
    const m = this.endMsg, s = this.endState; if (!m || !s) return;
    const docked = this.step !== "collections";
    this.end.className = `ks-ov-end ks-ov-end--${this.step}${docked ? " ks-ov-end--dock" : ""}`;
    this.end.setAttribute("role", docked ? "region" : "dialog");
    this.endShade.hidden = !docked;
    this.syncBackdrop();
    if (this.step === "collections") {
      this.stepTime = eventSec("matchEnd") + LINE_GAP_SEC + (m.collections.length ? 1.2 : 0);
      this.endBody.replaceChildren(...collectionsView(m, s));
    } else if (this.step === "title") {
      const award = m.titles[this.stepIndex];
      this.stepTime = award ? Math.max(TITLE_STEP_SEC, eventSec(`title_${award.title}` as AnnouncerEvent) + LINE_GAP_SEC) : TITLE_STEP_SEC;
      this.endBody.replaceChildren(...titleView(m, s, this.stepIndex));
    } else {
      this.stepTime = 0;
      const view = podiumView(m, s, this.myId, {
        onRematch: () => this.cb.onRematch(),
        onLeave: () => this.cb.onLeave(),
        sound: (kind) => this.sound(kind),
      });
      this.endBody.replaceChildren(...view.body);
      this.endFoot.replaceChildren(view.actions);
    }
    this.endFoot.hidden = this.step !== "podium";
    if (this.endFoot.hidden) this.endFoot.replaceChildren();
    this.cb.onStep(this.step, this.stepIndex);
  }
}
