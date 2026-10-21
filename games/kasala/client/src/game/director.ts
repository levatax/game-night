// Camera framing + music mode, decided from the displayed state (§14, §15). Owner: client-net-game.
// Only calls stage.setFocus / audio.setMusic when the decision changes. Short overrides (the raid door shot,
// which carries the raided seat so Stage frames the door AND that player) and the match-end steps sit on top
// of the phase-based choice. In first person Stage turns the same focus into where the seated player looks
// (seat → that player's head, door, wheel; podium / home → the Masa camera), so nothing here changes per view.

import type { MusicMode } from "../audio/Music";
import type { KasalaStateView } from "../../../shared/protocol";
import type { CameraFocus } from "../scene/Stage";
import type { Ctx } from "./context";

interface Shot {
  focus: CameraFocus;
  seat?: number;
}

export class Director {
  private focusKey = "";
  private musicMode: MusicMode | "" = "";
  private override: (Shot & { until: number }) | null = null;
  private endShot: Shot | null = null;
  private wheelOn = false;
  private lastView: KasalaStateView | null = null;
  private inRoom = false;

  constructor(private ctx: Ctx) {}

  get wheelActive(): boolean {
    return this.wheelOn;
  }

  /** Back to the home screen: slow attract orbit + lobby jazz. */
  home(): void {
    this.override = null;
    this.endShot = null;
    this.wheelOn = false;
    this.lastView = null;
    this.inRoom = false;
    this.apply({ focus: "home" }, "lobby");
  }

  /** Patronun Çarkı on screen (camera on the wheel, wheel music). */
  setWheel(on: boolean): void {
    if (this.wheelOn === on) return;
    this.wheelOn = on;
    this.refresh(this.lastView, this.inRoom);
  }

  /** Short camera shot (e.g. the door + the raided seat during a raid), then back to the phase framing. */
  overrideFor(focus: CameraFocus, seat: number | undefined, sec: number): void {
    if (!(sec > 0)) return;
    this.override = { focus, seat, until: performance.now() + sec * 1000 };
    this.refresh(this.lastView, this.inRoom);
  }

  /** Match end steps: collections → table, titles → the shamed player's seat, podium. */
  setEndShot(focus: CameraFocus | null, seat?: number): void {
    this.endShot = focus ? { focus, seat } : null;
    this.refresh(this.lastView, this.inRoom);
  }

  reset(): void {
    this.override = null;
    this.endShot = null;
    this.wheelOn = false;
  }

  /** Per frame: an expired override hands the camera back. */
  tick(): void {
    if (this.override && performance.now() >= this.override.until) {
      this.override = null;
      this.refresh(this.lastView, this.inRoom);
    }
  }

  refresh(view: KasalaStateView | null, inRoom: boolean): void {
    this.lastView = view;
    this.inRoom = inRoom;
    if (!inRoom || !view) {
      this.apply({ focus: "home" }, "lobby");
      return;
    }
    this.apply(this.shotFor(view), this.musicFor(view));
  }

  private seatOf(view: KasalaStateView, id: string): number | undefined {
    return id ? view.players.get(id)?.seat : undefined;
  }

  private shotFor(v: KasalaStateView): Shot {
    if (this.override && performance.now() < this.override.until) return this.override;
    switch (v.phase) {
      case "lobby":
      case "intro":
        return { focus: "table" };
      case "matchEnd":
        return this.endShot ?? { focus: "podium" };
      default:
        break;
    }
    if (this.wheelOn) return { focus: "wheel" };
    switch (v.phase) {
      case "betting":
      case "flipping":
      case "result":
      case "market": {
        const seat = this.seatOf(v, v.activeId);
        return seat === undefined ? { focus: "table" } : { focus: "seat", seat };
      }
      case "lastChance": {
        const seat = this.seatOf(v, v.lastChanceId);
        return seat === undefined ? { focus: "table" } : { focus: "seat", seat };
      }
      default:
        return { focus: "table" };
    }
  }

  private musicFor(v: KasalaStateView): MusicMode {
    if (v.phase === "lobby") return "lobby";
    if (v.phase === "matchEnd") return "victory";
    if (this.wheelOn) return "wheel";
    return v.finalTable ? "tango" : "lounge";
  }

  private apply(shot: Shot, music: MusicMode): void {
    const key = `${shot.focus}:${shot.seat ?? ""}`;
    if (key !== this.focusKey) {
      this.focusKey = key;
      this.ctx.stage.setFocus(shot.focus, shot.seat);
    }
    if (music !== this.musicMode) {
      this.musicMode = music;
      this.ctx.audio.setMusic(music);
    }
  }
}
