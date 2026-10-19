// Cosmetic time scaling: hit-stop and slow-mo. Owner: client-fx.

/**
 * Never touches networked positions/prediction (TECH_BRIEF §3). update(realDt) returns the
 * cosmetic dt for animation/particles/pop text: 0 during a hit-stop, dt × scale during a slow-mo
 * (overlapping requests: the strongest wins, durations measured in REAL time).
 */
export class Feel {
  /** Freeze cosmetic time for `ms` (HIT_STOP_MS = 60 on hits you deal or receive). */
  hitStop(ms: number): void {
    void ms;
  }

  /** Scale cosmetic time (CATCH_SLOWMO_SCALE for CATCH_SLOWMO_MS on your catches). */
  slowMo(scale: number, ms: number): void {
    void scale;
    void ms;
  }

  /** Advance real time; returns the cosmetic dt for this frame. */
  update(realDt: number): number {
    return realDt; // TODO(client-fx)
  }

  /** Current cosmetic time scale (0..1), e.g. to pitch-shift audio during slow-mo. */
  get timeScale(): number {
    return 1;
  }
}
