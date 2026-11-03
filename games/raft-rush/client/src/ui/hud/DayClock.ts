// Top-center day clock (§17): a sun / moon arc that tracks HudModel.cycle, "Day 2/3 — 1:35" (time left in the
// current day phase), today's weather and the storm countdown (red and pulsing once stormWarning is on).
// Owner: client-ui.

import { DAY_SEC, DUSK_SEC, NIGHT_SEC } from "../../../../shared/constants";
import { clockLabel } from "../../../../shared/rules/tempo";
import type { DayPhase, Phase, Weather } from "../../../../shared/types";
import { clockText, t, weatherName } from "../../i18n";
import { WEATHER_ICON } from "../content";
import { clamp01, el, setHidden, setText, setVar, svg, toggleClass } from "../dom";
import { ICON_MOON, ICON_STORM, ICON_SUN } from "../icons";
import type { HudModel } from "../models";

/** Fractions of the cycle where daylight ends / dusk ends (normal timings; the fast test clock is close enough). */
const CYCLE = DAY_SEC + DUSK_SEC + NIGHT_SEC;
const DAY_END = DAY_SEC / CYCLE;
const DUSK_END = (DAY_SEC + DUSK_SEC) / CYCLE;

export class DayClock {
  readonly el = el("div", "rr-clock");
  private readonly arc = el("div", "rr-clock__arc");
  private readonly sun = el("span", "rr-clock__body rr-clock__body--sun", svg(ICON_SUN));
  private readonly moon = el("span", "rr-clock__body rr-clock__body--moon", svg(ICON_MOON));
  private readonly title = el("span", "rr-clock__title");
  private readonly time = el("span", "rr-clock__time");
  private readonly weather = el("span", "rr-clock__weather");
  private readonly storm = el("span", "rr-clock__storm");
  private readonly stormText = el("span", "rr-clock__storm-text");

  private phaseKey = "";
  private titleText = "";
  private timeSec = -1;
  private stormSec = -1;
  private weatherId: Weather | null = null;
  private pos = -1;

  constructor() {
    this.arc.append(el("span", "rr-clock__horizon"), this.sun, this.moon);
    this.storm.append(el("span", "rr-clock__storm-icon", svg(ICON_STORM)), this.stormText);
    const line = el("div", "rr-clock__line", this.title, el("span", "rr-clock__dash", "—"), this.time);
    this.el.append(this.arc, line, el("div", "rr-clock__meta", this.weather, this.storm));
  }

  update(m: HudModel): void {
    this.renderPhase(m.phase, m.dayPhase);
    this.renderTitle(m);
    this.renderArc(m.phase, m.dayPhase, m.cycle);
    this.renderWeather(m.weather);
    this.renderStorm(m);
  }

  private renderPhase(phase: Phase, dayPhase: DayPhase): void {
    const key = phase === "playing" ? dayPhase : phase === "landing" ? "day" : phase === "storm" ? "storm" : phase === "launch" ? "launch" : dayPhase;
    if (key === this.phaseKey) return;
    this.phaseKey = key;
    this.el.dataset.phase = key;
  }

  private renderTitle(m: HudModel): void {
    const vars = { day: Math.max(1, m.day), days: m.days };
    let title: string;
    if (m.phase === "landing") title = t("hud.clockLanding");
    else if (m.phase === "launch") title = t("hud.clockLaunch");
    else if (m.phase === "storm") title = t("hud.clockStorm");
    else if (m.dayPhase === "dusk") title = t("hud.clockDusk", vars);
    else if (m.dayPhase === "night") title = t("hud.clockNight", vars);
    else title = t("hud.clockDay", vars);
    if (title !== this.titleText) {
      this.titleText = title;
      setText(this.title, title);
    }
    const showTime = m.phase === "playing" || m.phase === "landing";
    const sec = showTime ? Math.max(0, Math.ceil(m.phaseSecLeft)) : -1;
    if (sec !== this.timeSec) {
      this.timeSec = sec;
      setText(this.time, sec >= 0 ? clockText(sec) : "");
      toggleClass(this.el, "has-time", sec >= 0);
    }
  }

  /** Sun crosses the arc during day + dusk (it sets at the right end), the moon during the night. */
  private renderArc(phase: Phase, dayPhase: DayPhase, cycle: number): void {
    let sunT: number;
    let night: boolean;
    if (phase === "landing") {
      sunT = 0.02;
      night = false;
    } else if (dayPhase === "night" || phase === "storm") {
      night = true;
      sunT = clamp01((cycle - DUSK_END) / (1 - DUSK_END));
    } else {
      night = false;
      sunT = dayPhase === "dusk" ? 0.85 + 0.15 * clamp01((cycle - DAY_END) / (DUSK_END - DAY_END)) : 0.85 * clamp01(cycle / DAY_END);
    }
    const pos = Math.round(sunT * 400) / 400;
    if (pos === this.pos && this.arc.classList.contains("is-night") === night) return;
    this.pos = pos;
    toggleClass(this.arc, "is-night", night);
    // Position on a half ellipse: x 0..100%, y follows sin.
    const ang = Math.PI * (1 - pos);
    const x = 50 + 50 * Math.cos(ang);
    const y = 100 - 100 * Math.sin(ang);
    const body = night ? this.moon : this.sun;
    setVar(body, "--x", `${x.toFixed(2)}%`);
    setVar(body, "--y", `${y.toFixed(2)}%`);
    setHidden(this.sun, night);
    setHidden(this.moon, !night);
  }

  private renderWeather(weather: Weather): void {
    if (weather === this.weatherId) return;
    this.weatherId = weather;
    setHidden(this.weather, weather === "clear");
    setText(this.weather, `${WEATHER_ICON[weather]} ${weatherName(weather)}`);
    this.weather.title = t(`items.weather_${weather}_desc`);
  }

  private renderStorm(m: HudModel): void {
    const show = (m.phase === "playing" || m.phase === "landing") && m.stormSecLeft > 0;
    const sec = show ? Math.max(0, Math.ceil(m.stormSecLeft)) : -1;
    toggleClass(this.storm, "is-warning", show && m.stormWarning);
    toggleClass(this.storm, "is-calm", m.reducedFlashing);
    if (sec === this.stormSec) return;
    this.stormSec = sec;
    setHidden(this.storm, !show);
    if (show) setText(this.stormText, t(m.stormWarning ? "hud.stormSoon" : "hud.stormIn", { t: clockLabel(sec) }));
  }
}
