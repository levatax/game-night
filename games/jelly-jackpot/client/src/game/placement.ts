// Placement loop for the local active player. Owner: client-game.
// Decides when Controls.beginPlacement / endPlacement run (incl. Double Decker's second piece), streams the
// pose to the server each frame (Net throttles) and shows it locally right away via TowerView.setLocalHover.
// Hiccups: the server hops the RELAYED pose; since we show our own pose locally, we fake the same hop here.

import * as THREE from "three";
import { CAKE_TOP_Y, CHONK_SCALE, MIN_DROP_GAP, PIECES, type PieceType } from "../../../shared/constants";
import type { JellyStateView, Pose } from "../../../shared/protocol";
import type { Ctx } from "./context";

const HICCUP_SEC = 0.25;

export class Placement {
  /** piecesLeft at the moment of my last drop (−1 = not waiting for the server to catch up). */
  private awaiting = -1;
  private type: PieceType | "" = "";
  private scale = 1;
  private hiccupLeft = 0;
  private hiccupDx = 0;
  private hiccupDz = 0;
  private readonly worldHover = new THREE.Vector3();

  constructor(private ctx: Ctx) {}

  get active(): boolean {
    return this.ctx.controls.placing;
  }

  /** Every state patch: start/stop placement as the turn demands. */
  sync(state: JellyStateView, myId: string): void {
    const mine = state.phase === "placing" && state.activeId === myId && !!myId;
    if (this.awaiting >= 0 && (!mine || state.piecesLeft < this.awaiting)) this.awaiting = -1;
    const want = mine && state.piecesLeft > 0 && !!state.currentPiece && this.awaiting < 0;
    const type = state.currentPiece as PieceType;

    if (want && (!this.active || this.type !== type)) {
      if (this.active) this.ctx.controls.endPlacement();
      this.type = type;
      this.scale = state.card.id === "chonk" ? CHONK_SCALE : 1;
      this.ctx.controls.setMinY(this.minY(state));
      this.ctx.controls.beginPlacement({
        type,
        scale: this.scale,
        mirror: state.card.id === "mirrorHands",
        tiedHands: state.card.id === "tiedHands",
      });
    } else if (!want && this.active) {
      this.stop();
    }
  }

  /** Per frame while placing: min height, network pose, local hover. Returns the hover world point (or null). */
  frame(state: JellyStateView | null, dt: number): THREE.Vector3 | null {
    if (!this.active || !state || !this.type) return null;
    const c = this.ctx;
    c.controls.setMinY(this.minY(state));
    const pose = c.controls.pose();
    c.net.hover(pose);

    let hop = 0;
    if (this.hiccupLeft > 0) {
      this.hiccupLeft = Math.max(0, this.hiccupLeft - dt);
      hop = Math.sin((1 - this.hiccupLeft / HICCUP_SEC) * Math.PI);
    }
    const x = pose.x + this.hiccupDx * hop;
    const y = pose.y + 0.06 * hop;
    const z = pose.z + this.hiccupDz * hop;
    c.tower.setLocalHover(this.type, { x, y, z, quat: c.controls.poseQuat(), scale: this.scale });

    this.worldHover.set(x, y, z);
    c.stage.standGroup.updateWorldMatrix(true, false);
    return c.stage.standGroup.localToWorld(this.worldHover);
  }

  /** Controls "drop" action. Returns true when a drop was sent. */
  drop(pose: Pose, state: JellyStateView | null): boolean {
    if (!this.active || !state) return false;
    this.ctx.net.drop(pose);
    this.awaiting = Math.max(1, state.piecesLeft);
    this.stop();
    this.ctx.tower.clearHover();
    return true;
  }

  /** DROPPED for me (also covers the timer auto-drop). Stops placing unless the next piece already started. */
  serverDropped(type: PieceType, piecesLeft: number): void {
    if (!this.active || this.type !== type) return;
    this.awaiting = piecesLeft + 1;
    this.stop();
    this.ctx.tower.clearHover();
  }

  /** The server made my piece hop (Hiccups card). */
  hiccup(): void {
    this.hiccupLeft = HICCUP_SEC;
    const a = Math.random() * Math.PI * 2;
    this.hiccupDx = Math.cos(a) * 0.03;
    this.hiccupDz = Math.sin(a) * 0.03;
  }

  /** Lowest legal hover center y, mirroring the server's TowerSim.minHoverY (+1 cm margin for rounding). */
  minY(state: JellyStateView): number {
    const def = this.type ? PIECES[this.type] : undefined;
    const r = def ? def.radius * this.scale : 0.1;
    return CAKE_TOP_Y + Math.max(0, state.towerHeightCm) / 100 + MIN_DROP_GAP + r + 0.01;
  }

  stop(): void {
    if (this.active) this.ctx.controls.endPlacement();
    this.ctx.tower.setLocalHover("", null);
    this.hiccupLeft = 0;
  }

  reset(): void {
    this.stop();
    this.awaiting = -1;
    this.type = "";
  }
}
