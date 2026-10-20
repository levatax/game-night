// Lobby turntable preview. Owner: client-characters.

import * as THREE from "three";
import { EMOTE_IDS, GRAVITY } from "../../../shared/constants";
import type { CharacterId } from "../../../shared/types";
import type { PlayerFrame } from "../net/types";
import { Animal } from "./Animal";
import { Animator } from "./Animator";
import { easeInCubic } from "./pose";
import { createPuppetFrame } from "./puppet";
import { createBlobShadow, type BlobShadow } from "./shadowBlob";

const FOV = 30;
const CAMERA_POS = new THREE.Vector3(0, 1.12, 4.35);
const LOOK_AT = new THREE.Vector3(0, 0.7, 0);
/** Faces the camera (+Z) at turntable angle 0. */
const FRONT_YAW = Math.PI;
const HOP_VY = 3.0;
const SWAP_OUT_SEC = 0.16;
const MAX_DT = 0.1;
const MAX_PIXEL_RATIO = 2;

interface Shown {
  character: CharacterId;
  animal: Animal;
  animator: Animator;
  frame: PlayerFrame;
  /** Seconds since it appeared (drives the entrance hop). */
  age: number;
  landed: boolean;
}

/**
 * Own small WebGLRenderer (alpha: true, antialias) on the given canvas (the lobby's
 * previewCanvas), own scene with the shared toon lighting, a pedestal, and the selected animal
 * slowly rotating + playing idle and an occasional emote. Resizes to the canvas client size.
 * Runs its own requestAnimationFrame loop only while started.
 */
export class CharacterPreview {
  private readonly canvas: HTMLCanvasElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
  private readonly shadow: BlobShadow;
  private shown: Shown | null = null;
  private leaving: { animal: Animal; t: number } | null = null;
  private slotColor = "";
  private started = false;
  private intersecting = true;
  private rafId = 0;
  private lastMs = 0;
  private turntable = 0;
  private emoteIn = 2.5;
  private emoteIndex = 0;
  private readonly observer: IntersectionObserver | null;
  private readonly onVisibility = (): void => this.refreshLoop();
  private readonly tick = (now: number): void => this.frame(now);

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.camera.position.copy(CAMERA_POS);
    this.camera.lookAt(LOOK_AT);
    this.scene.add(new THREE.HemisphereLight("#DDF2FF", "#9ED9A8", 1.25));
    const key = new THREE.DirectionalLight("#FFF4D6", 2.3);
    key.position.set(-2.5, 4, 3.5);
    const rim = new THREE.DirectionalLight("#CFE8FF", 0.9);
    rim.position.set(3, 2, -3);
    this.scene.add(key, rim);
    this.shadow = createBlobShadow(0.62, 0.32);
    this.scene.add(this.shadow.mesh);

    this.observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver((entries) => {
            this.intersecting = entries.some((e) => e.isIntersecting);
            this.refreshLoop();
          });
    this.observer?.observe(canvas);
    document.addEventListener("visibilitychange", this.onVisibility);
  }

  /** Show `character` tinted with the slot color (swap with a little hop). */
  setCharacter(character: CharacterId, slotColor: string): void {
    const current = this.shown;
    if (current && current.character === character) {
      if (slotColor !== this.slotColor) current.animal.setSlotColor(slotColor);
      this.slotColor = slotColor;
      return;
    }
    this.slotColor = slotColor;
    if (current) this.retire(current.animal);
    this.shown = this.createShown(character, slotColor, current !== null);
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.refreshLoop();
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.refreshLoop();
  }

  dispose(): void {
    this.stop();
    this.observer?.disconnect();
    document.removeEventListener("visibilitychange", this.onVisibility);
    if (this.leaving) this.leaving.animal.dispose();
    this.leaving = null;
    this.shown?.animal.dispose();
    this.shown = null;
    this.shadow.dispose();
    this.renderer?.dispose();
    this.renderer = null;
  }

  /* ----------------------------------------------------------- internals */

  private createShown(character: CharacterId, slotColor: string, hop: boolean): Shown {
    const animal = new Animal(character, slotColor);
    animal.setCastShadows(false);
    const animator = new Animator(animal, character);
    const frame = createPuppetFrame(character, "preview");
    frame.yaw = FRONT_YAW + this.turntable;
    this.scene.add(animal.rig.root);
    this.emoteIn = hop ? 0.75 : 2.5;
    return { character, animal, animator, frame, age: hop ? 0 : 10, landed: !hop };
  }

  /** Shrink the previous animal away while the new one hops in. */
  private retire(animal: Animal): void {
    if (this.leaving) this.leaving.animal.dispose();
    this.leaving = { animal, t: 0 };
  }

  /** Run the RAF loop only while started, the tab is visible and the canvas is on screen. */
  private refreshLoop(): void {
    const run = this.started && !document.hidden && this.intersecting;
    if (run && this.rafId === 0) {
      this.lastMs = performance.now();
      this.rafId = requestAnimationFrame(this.tick);
    } else if (!run && this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
  }

  private frame(now: number): void {
    this.rafId = 0;
    const dt = Math.min(MAX_DT, Math.max(0, (now - this.lastMs) / 1000));
    this.lastMs = now;
    this.update(dt);
    this.render();
    this.refreshLoop();
  }

  private update(dt: number): void {
    // Linger facing the camera, sweep faster around the back.
    const speed = 0.3 + 0.7 * Math.abs(Math.sin(this.turntable / 2));
    this.turntable = (this.turntable + dt * speed) % (Math.PI * 2);
    this.updateLeaving(dt);
    const shown = this.shown;
    if (!shown) return;
    this.updateHop(shown, dt);
    this.updateEmotes(shown, dt);
    shown.frame.yaw = FRONT_YAW + this.turntable;
    shown.animator.update(shown.frame, dt);
    const lift = shown.animal.rig.root.position.y;
    this.shadow.setLift(lift);
  }

  private updateLeaving(dt: number): void {
    const leaving = this.leaving;
    if (!leaving) return;
    leaving.t += dt;
    const k = 1 - easeInCubic(leaving.t / SWAP_OUT_SEC);
    if (k <= 0) {
      leaving.animal.dispose();
      this.leaving = null;
      return;
    }
    leaving.animal.rig.root.scale.setScalar(k);
  }

  /** Entrance hop: a small ballistic jump with jump/fall poses, then a squash on landing. */
  private updateHop(shown: Shown, dt: number): void {
    shown.age += dt;
    const f = shown.frame;
    const root = shown.animal.rig.root;
    if (shown.landed) {
      root.position.y = 0;
      root.scale.setScalar(1);
      f.grounded = true;
      f.vy = 0;
      return;
    }
    const t = shown.age;
    const y = HOP_VY * t + 0.5 * GRAVITY * t * t;
    if (y <= 0 && t > 0.05) {
      shown.landed = true;
      root.position.y = 0;
      f.grounded = true;
      f.vy = 0;
      shown.animator.trigger("land", { strength: 0.65 });
      return;
    }
    root.position.y = Math.max(0, y);
    root.scale.setScalar(Math.min(1, 0.4 + t * 4));
    f.grounded = false;
    f.vy = HOP_VY + GRAVITY * t;
  }

  private updateEmotes(shown: Shown, dt: number): void {
    if (!shown.landed) return;
    this.emoteIn -= dt;
    if (this.emoteIn > 0) return;
    const emote = EMOTE_IDS[this.emoteIndex % EMOTE_IDS.length];
    this.emoteIndex = (this.emoteIndex + 1 + Math.floor(Math.random() * 2)) % EMOTE_IDS.length;
    shown.animator.trigger("emote", { emote: shown.age < 2 ? "wave" : emote });
    this.emoteIn = 4.5 + Math.random() * 3;
  }

  private render(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    if (w === 0 || h === 0) return;
    const renderer = this.ensureRenderer();
    const ratio = Math.min(MAX_PIXEL_RATIO, window.devicePixelRatio || 1);
    // Same rounding as WebGLRenderer.setSize, so an unchanged size never re-allocates.
    const pw = Math.floor(w * ratio);
    const ph = Math.floor(h * ratio);
    if (this.canvas.width !== pw || this.canvas.height !== ph) {
      renderer.setPixelRatio(ratio);
      renderer.setSize(w, h, false);
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
    }
    renderer.render(this.scene, this.camera);
  }

  /** Created on the first visible frame, so a never-shown lobby costs no GL context. */
  private ensureRenderer(): THREE.WebGLRenderer {
    if (!this.renderer) {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: true });
      this.renderer.outputColorSpace = THREE.SRGBColorSpace;
      this.renderer.setClearColor(0x000000, 0);
    }
    return this.renderer;
  }
}
