// Cosmetic time scaling: hit-stop and slow-mo, plus a trauma-model screen shake. Owner: client-fx.

/** Max simultaneous slow-mo requests tracked (strongest wins). */
const SLOWMO_SLOTS = 4;
/** Trauma lost per real second (1 → 0 in ~0.6 s). */
const TRAUMA_DECAY = 1.6;
/** Camera offset (m) and roll (rad) at trauma 1. */
const SHAKE_MAX_OFFSET = 0.32;
const SHAKE_MAX_ROLL = 0.06;

/** Camera shake sample written by Feel.shakeOffset(). */
export interface ShakeSample {
  x: number;
  y: number;
  z: number;
  roll: number;
}

/**
 * Never touches networked positions/prediction (TECH_BRIEF §3). update(realDt) returns the
 * cosmetic dt for animation/particles/pop text: 0 during a hit-stop, dt × scale during a slow-mo
 * (overlapping requests: the strongest wins, durations measured in REAL time).
 *
 * Screen shake (trauma model): addTrauma() accumulates 0..1 trauma that decays in real time;
 * shakeOffset() returns a smooth pseudo-random camera offset scaled by trauma², which the camera
 * owner adds on top of the CameraRig pose (or forwards to CameraRig.shake via onShake).
 */
export class Feel {
  /** Optional bridge so fx-side code can request camera shake (e.g. wired to CameraRig.shake). */
  onShake: ((intensity: number, durationSec: number) => void) | null = null;

  private hitStopLeft = 0;
  private readonly slowScale = new Float32Array(SLOWMO_SLOTS);
  private readonly slowLeft = new Float32Array(SLOWMO_SLOTS);
  private scale = 1;
  private traumaValue = 0;
  private shakeTime = 0;

  /** Freeze cosmetic time for `ms` (HIT_STOP_MS = 60 on hits you deal or receive). */
  hitStop(ms: number): void {
    this.hitStopLeft = Math.max(this.hitStopLeft, Math.max(0, ms) / 1000);
    this.scale = 0;
  }

  /** Scale cosmetic time (CATCH_SLOWMO_SCALE for CATCH_SLOWMO_MS on your catches). */
  slowMo(scale: number, ms: number): void {
    const s = Math.min(1, Math.max(0, scale));
    const sec = Math.max(0, ms) / 1000;
    if (sec <= 0 || s >= 1) return;
    let slot = 0;
    for (let i = 0; i < SLOWMO_SLOTS; i++) {
      if (this.slowLeft[i] <= 0) {
        slot = i;
        break;
      }
      // All slots busy: replace the one that ends first.
      if (this.slowLeft[i] < this.slowLeft[slot]) slot = i;
    }
    this.slowScale[slot] = s;
    this.slowLeft[slot] = sec;
    if (this.hitStopLeft <= 0) this.scale = Math.min(this.scale, s);
  }

  /** Advance real time; returns the cosmetic dt for this frame. */
  update(realDt: number): number {
    const dt = Math.max(0, realDt);
    this.decayTrauma(dt);
    // The frozen part of this frame produces no cosmetic time; the remainder runs slowed.
    const frozen = Math.min(this.hitStopLeft, dt);
    this.hitStopLeft -= frozen;
    const running = dt - frozen;
    const slow = this.advanceSlowMo(dt);
    this.scale = this.hitStopLeft > 0 ? 0 : slow;
    return running * slow;
  }

  /** Current cosmetic time scale (0..1), e.g. to pitch-shift audio during slow-mo. */
  get timeScale(): number {
    return this.scale;
  }

  /** Add screen-shake trauma (0.3 ≈ hit victim, 0.6 ≈ mega hit / shockwave). Also forwards to onShake. */
  addTrauma(amount: number, durationSec = 0.4): void {
    if (amount <= 0) return;
    this.traumaValue = Math.min(1, this.traumaValue + amount);
    this.onShake?.(Math.min(1, amount), durationSec);
  }

  /** Current trauma 0..1. Shake strength is trauma² (small knocks stay subtle). */
  get trauma(): number {
    return this.traumaValue;
  }

  /** Smooth pseudo-random camera offset (meters) and roll (radians) for the current trauma. */
  shakeOffset(out: ShakeSample): ShakeSample {
    const k = this.traumaValue * this.traumaValue;
    const t = this.shakeTime;
    out.x = k * SHAKE_MAX_OFFSET * wobble(t, 31.7, 1.3);
    out.y = k * SHAKE_MAX_OFFSET * wobble(t, 27.1, 4.1);
    out.z = k * SHAKE_MAX_OFFSET * 0.5 * wobble(t, 23.3, 2.2);
    out.roll = k * SHAKE_MAX_ROLL * wobble(t, 19.9, 5.7);
    return out;
  }

  /** Cancel every hit-stop, slow-mo and shake (leaving the game view). */
  reset(): void {
    this.hitStopLeft = 0;
    this.slowLeft.fill(0);
    this.scale = 1;
    this.traumaValue = 0;
  }

  private advanceSlowMo(dt: number): number {
    let strongest = 1;
    for (let i = 0; i < SLOWMO_SLOTS; i++) {
      if (this.slowLeft[i] <= 0) continue;
      strongest = Math.min(strongest, this.slowScale[i]);
      this.slowLeft[i] = Math.max(0, this.slowLeft[i] - dt);
    }
    return strongest;
  }

  private decayTrauma(dt: number): void {
    this.shakeTime += dt;
    this.traumaValue = Math.max(0, this.traumaValue - TRAUMA_DECAY * dt);
  }
}

/** Sum of incommensurate sines: cheap smooth noise in [-1, 1]. */
function wobble(t: number, freq: number, seed: number): number {
  return 0.6 * Math.sin(t * freq + seed) + 0.4 * Math.sin(t * freq * 2.37 + seed * 3.1);
}
