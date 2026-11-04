// The in-game HUD layer (§17, KASALA declutter): owns every always-on, contextual and transient widget and lays
// them out. Owner: client-ui.
//   top: compass strip, day clock (+ weather, storm countdown), boarding countdown · top-left: teammates ·
//   top-right: raft card + fire flame · center: crosshair, charge ring, interact prompt, fishing bar ·
//   bottom-left: sound captions above the feed above the survival bars · bottom-center: hotbar · full screen:
//   downed / washed screens.
// update() runs every frame and only touches the DOM when a value changed. Cinematics (launch / storm) and
// spectating strip it down to the clock, the raft and the teammates; spectating and washed ashore add the
// spectator-camera hint under the clock (drag to look, click / Space for the next teammate).

import { t } from "../../i18n";
import { el, setHidden, setText, toggleClass } from "../dom";
import type { HudModel } from "../models";
import { ChargeBar } from "./ChargeBar";
import { Compass } from "./Compass";
import { Crosshair } from "./Crosshair";
import { DayClock } from "./DayClock";
import { DownedScreen } from "./DownedScreen";
import { Feed } from "./Feed";
import { FireMeter } from "./FireMeter";
import { FishingBar } from "./FishingBar";
import { Hotbar } from "./Hotbar";
import { InteractPrompt } from "./InteractPrompt";
import { LaunchCountdown } from "./LaunchCountdown";
import { RaftProgress } from "./RaftProgress";
import { Subtitle } from "./Subtitle";
import { SurvivalBars } from "./SurvivalBars";
import { Teammates } from "./Teammates";
import { WashedScreen } from "./WashedScreen";
import type { CoachAnchor } from "./Coach";

export class Hud {
  readonly el = el("div", "rr-hud");
  readonly bars = new SurvivalBars();
  readonly hotbar = new Hotbar();
  readonly clock = new DayClock();
  readonly compass = new Compass();
  readonly raft = new RaftProgress();
  readonly fire = new FireMeter();
  readonly prompt = new InteractPrompt();
  readonly crosshair = new Crosshair();
  readonly charge = new ChargeBar();
  readonly fishing = new FishingBar();
  readonly downed = new DownedScreen();
  readonly washed = new WashedScreen();
  readonly launch = new LaunchCountdown();
  readonly mates = new Teammates();
  readonly feed = new Feed();
  readonly captions = new Subtitle();
  private readonly spectator = el("div", "rr-spectator");
  private readonly spectateHint = el("p", "rr-spectate-hint");
  private readonly top = el("div", "rr-hud__top");
  private readonly center = el("div", "rr-hud__center");
  private readonly topRight = el("div", "rr-hud__tr");
  private readonly bottomLeft = el("div", "rr-hud__bl");
  private mode = "";
  private calm: boolean | null = null;

  constructor() {
    setText(this.spectator, `👀 ${t("hud.spectating")}`);
    this.spectator.hidden = true;
    setText(this.spectateHint, `🎥 ${t("hud.spectateHint")}`);
    this.spectateHint.hidden = true;
    this.top.append(this.compass.el, this.clock.el, this.launch.el, this.spectator, this.spectateHint);
    this.center.append(this.crosshair.el, this.charge.el, this.prompt.el, this.fishing.el);
    this.topRight.append(this.raft.el, this.fire.el);
    this.bottomLeft.append(this.captions.el, this.feed.el, this.bars.el);
    const topLeft = el("div", "rr-hud__tl", this.mates.el);
    const bottomCenter = el("div", "rr-hud__bc", this.hotbar.el);
    this.el.append(this.downed.el, this.washed.el, this.top, topLeft, this.topRight, this.center, this.bottomLeft, bottomCenter);
  }

  setVisible(visible: boolean): void {
    setHidden(this.el, !visible);
  }

  /** The element a coach tip of `anchor` points at. */
  anchor(a: CoachAnchor): HTMLElement | null {
    switch (a) {
      case "bars":
        return this.bars.el;
      case "hotbar":
        return this.hotbar.el;
      case "clock":
        return this.clock.el;
      case "raft":
        return this.raft.el;
      case "fire":
        return this.fire.el;
      case "compass":
        return this.compass.el;
      case "mates":
        return this.mates.el;
      case "center":
        return null;
    }
  }

  update(m: HudModel): void {
    if (m.reducedFlashing !== this.calm) {
      this.calm = m.reducedFlashing;
      toggleClass(this.el, "rr-calm", m.reducedFlashing);
    }
    const cinematic = m.phase === "launch" || m.phase === "storm";
    const mode = m.spectator ? "spectator" : cinematic ? "cinematic" : m.washed ? "washed" : m.downed ? "downed" : m.boarded ? "boarded" : "play";
    if (mode !== this.mode) {
      this.mode = mode;
      this.el.dataset.mode = mode;
      setHidden(this.spectator, mode !== "spectator");
      setHidden(this.spectateHint, mode !== "spectator" && mode !== "washed");
    }
    const active = mode === "play" || mode === "boarded" || mode === "downed";
    const canAct = mode === "play";

    this.compass.update(m.compass.yaw, mode === "washed" || cinematic ? [] : m.compass.marks);
    this.clock.update(m);
    this.raft.update(m.raft);
    this.raft.updateStatus(m.status, m.heavy);
    this.fire.update(m.fire);
    this.mates.update(m.teammates);
    this.launch.update(cinematic ? null : m.launch, m.boarded);

    if (active) {
      this.bars.update(m);
      this.hotbar.update(m.slots, m.activeSlot);
    }
    this.crosshair.update(canAct ? m.crosshair : "hidden");
    this.charge.update(canAct ? m.charge : 0);
    this.prompt.update(canAct || mode === "boarded" ? m.prompt : null);
    this.fishing.update(canAct ? m.fishing : null);
    this.downed.update(mode === "downed" ? m.downed : null);
    this.washed.update(mode === "washed" ? m.washed : null);
  }
}
