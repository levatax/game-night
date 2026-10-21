// Steady timer for the music / drum / loop schedulers. A tiny Worker keeps ticking when the tab is in the
// background (window timers get clamped to ≥ 1 s there); setInterval is the fallback. Owner: client-fx-audio.
// Copied from games/bonk-brawl/client/src/audio/music/ticker.ts (unchanged).

const WORKER_SOURCE =
  "let id=0;onmessage=(e)=>{clearInterval(id);id=e.data>0?setInterval(()=>postMessage(0),e.data):0;};";

export class Ticker {
  private worker: Worker | null = null;
  private workerUrl: string | null = null;
  private workerFailed = false;
  private interval: ReturnType<typeof setInterval> | null = null;
  private running = false;

  constructor(
    private readonly intervalMs: number,
    private readonly onTick: () => void,
  ) {}

  start(): void {
    if (this.running) return;
    this.running = true;
    const worker = this.ensureWorker();
    if (worker) worker.postMessage(this.intervalMs);
    else this.interval = setInterval(this.onTick, this.intervalMs);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    this.worker?.postMessage(0);
    if (this.interval !== null) clearInterval(this.interval);
    this.interval = null;
  }

  dispose(): void {
    this.stop();
    this.worker?.terminate();
    this.worker = null;
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
    this.workerUrl = null;
  }

  private ensureWorker(): Worker | null {
    if (this.worker || this.workerFailed) return this.worker;
    try {
      this.workerUrl = URL.createObjectURL(new Blob([WORKER_SOURCE], { type: "text/javascript" }));
      const worker = new Worker(this.workerUrl);
      worker.onmessage = () => {
        if (this.running) this.onTick();
      };
      worker.onerror = () => this.fallBack();
      this.worker = worker;
    } catch {
      // Workers blocked (CSP, sandbox): plain timers still work while the tab is visible.
      this.workerFailed = true;
    }
    return this.worker;
  }

  /** The worker failed to load after start(): switch to setInterval without losing the beat. */
  private fallBack(): void {
    this.workerFailed = true;
    this.worker?.terminate();
    this.worker = null;
    if (this.running && this.interval === null) this.interval = setInterval(this.onTick, this.intervalMs);
  }
}
