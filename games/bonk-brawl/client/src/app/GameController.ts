// Per-frame game loop wiring input → net → characters/fx/camera/audio/ui. Owner: client-app.

import type { AudioEngine } from "../audio/AudioEngine";
import type { Characters } from "../characters/Characters";
import type { Fx } from "../fx/Fx";
import type { Input } from "../input/Input";
import type { Net } from "../net/Net";
import type { CameraRig } from "../render/CameraRig";
import type { Renderer } from "../render/Renderer";
import type { Ui } from "../ui/Ui";

export interface GameControllerDeps {
  net: Net;
  input: Input;
  renderer: Renderer;
  camera: CameraRig;
  characters: Characters;
  fx: Fx;
  audio: AudioEngine;
  ui: Ui;
}

/**
 * Active while the room phase is countdown / playing / suddenDeath / roundEnd / matchEnd.
 *
 * frame(now, realDt) — exact order (docs/ARCHITECTURE.md §5):
 *  1. dt = fx.feel.update(realDt)                       (cosmetic dt: hit-stop / slow-mo)
 *  2. fixed-step input: if !net.wantsInput → acc = 0 (no backlog burst later). Else
 *     acc += min(realDt, 0.25); while acc >= DT: cmd = input.sample(++seq); net.sendInput(cmd)
 *     (prediction; localThrow/localStep events); acc -= DT. alpha = acc / DT.
 *     `seq` is ONE counter for the page lifetime (a field initialized once, never reset on
 *     enter/exit, new rounds, matches or reconnects): the server drops seq <= the last seen one.
 *  3. net.update(now, realDt)
 *  4. local = net.getLocalPlayer(alpha, { yaw: input.yaw, pitch: input.pitch });
 *     remotes = net.getRemotePlayers(now); balls = net.getBalls()
 *  5. renderer.arena.syncRings(state.rings)
 *  6. characters.sync([local, ...remotes], { crownId, localId, hideLocal }, dt)
 *  7. fx.balls.sync(balls, dt, { handOf: characters.getHandPosition, colorOf });
 *     charge telegraph for EVERY alive player frame (local and remote, chargeTicks is synced):
 *     fx.balls.setChargeGlow(id, chargeFraction(frame)) and a positional "charge" loop per
 *     charging player (setParam(charge), setPosition(hand), stop when the charge ends);
 *     fx.powerUps.sync(state powerUps, dt, elapsed); fx.shadows.update(players + balls);
 *     fx.arc.update(local full charge && settings.showArcPreview ? sampleTrajectory(...) : null, color);
 *     bounce SFX/squash for balls with `bounced`; zoomies speed lines + "zoomies" loop and Pip's
 *     "slide" loop per player while active
 *  8. fx.update(dt)
 *  9. camera.update(realDt, follow local | ghost when dead/spectating | orbit at matchEnd)
 * 10. audio.setListener(camera pos, forward); audio.setTimeScale(fx.feel.timeScale)
 * 11. renderer.update(dt, elapsed); renderer.render()
 * 12. ui.updateHud(buildHudModel(...)); ui.setIndicators(computeOffscreenIndicators(...));
 *     scoreboard rows while Tab is held
 *
 * Net events → feedback: see the event→feedback table in docs/ARCHITECTURE.md §8 (subscribe in
 * enter(), unsubscribe in exit()).
 */
export class GameController {
  constructor(deps: GameControllerDeps) {
    void deps;
  }

  /**
   * Enter the game view: renderer.loadArena(state.mapId) (and again whenever mapId changes),
   * camera.setFloorQuery, fx.setArena, input.setLook(spawn yaw), music "fight", subscribe to
   * net gameplay events. Idempotent.
   * FloorQuery objects handed to camera/fx must read the CURRENT state.rings: either a live view
   * ({ arena, get rings() { return net.state?.rings ?? [] } }) or re-set them on every map change
   * and after a reconnect (a reconnect creates a new decoded state object).
   */
  enter(): void {}

  /** Leave the game view: unsubscribe, stop loops, fx.clear(), characters.clear(). Idempotent. */
  exit(): void {}

  get active(): boolean {
    return false;
  }

  /** One render frame (see order above). */
  frame(nowMs: number, realDt: number): void {
    void nowMs;
    void realDt;
  }
}
