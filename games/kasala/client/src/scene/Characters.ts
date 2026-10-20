// Gangster cast, Cemil Abi, Komiser Rıfat and the weasel lawyer: who sits where, what they look at and how
// they move. Animation is layered per actor:
//   base     — seated idle (breathing, hands on the rail, look-at the action) or a scripted sequence
//              (raid, cement shoes, podium, ghost return: characters/sequences.ts) that owns root/legs/arms;
//   clips    — emotes, moods, table gestures, the KASALA celebration and idle fidgets (characters/clips.ts),
//              cross-faded on top with channel masks, so an emote can never cancel a sequence;
//   puppet   — critically damped springs, stride from real root motion, reach-limited IK (characters/body.ts).
// First person: my own upper body / label / plate hide inside the camera and FpArms take over the hands (my
// hidden body also stops emitting particles and showing the raid plate in front of the lens).
// Labels sit in a DOM layer under the HUD and move with translate3d only; setLabelsHidden() (hero card up)
// hides the name pills but keeps taunt bubbles. Owner: client-characters.
import * as THREE from "three";
import {
  ANIMALS, ANIMAL_BY_ID, CASH_RESULT_BIG_SEC, CASH_RESULT_SEC, ELIMINATION_SEC, HARAC_PCT, RAID_RESULT_SEC,
  RAID_RESULT_SHORT_SEC, TAUNT_SEC, type Animal, type EmoteId, type RaidAnim,
} from "../../../shared/constants";
import type { KasalaStateView, Phase } from "../../../shared/protocol";
import { MASK_ALL, Pose } from "./characters/body";
import { disposeOwned } from "./characters/kit";
import { buildCop, buildLawyer, createActor, PropSet, sceneColor, type Actor, type Npc } from "./characters/cast";
import {
  CASH_CLIP, EMOTE_CLIPS, GESTURE_CLIPS, IDLE_CLIPS, MOOD_CLIPS, aimHead, clipWeight, fadeClip, startClip,
  type ClipEnv, type GestureKind, type Mood,
} from "./characters/clips";
import { Dealer, type DealerApi } from "./characters/dealer";
import { FpArms } from "./characters/fpArms";
import { Label, type PreviewTone } from "./characters/labels";
import { Particles } from "./characters/particles";
import {
  buildBoxCamera, buildBucket, buildCuff, buildMoneyPile, buildMugshotBoard, buildNumberPlate, buildPier,
  buildStars, buildStrand,
} from "./characters/props";
import {
  EliminateSeq, PodiumSeq, RaidSeq, ReturnSeq, facing, ghostPose, seatedRest, type SeqEnv, type Shared,
} from "./characters/sequences";
import { Pop, approachAngle, clamp, easeInOut, follow, followV, pick, rand, seg, wobble } from "./characters/util";
import { addOutlines } from "./toon";
import { TABLE_TOP_Y } from "./room/layout";
import type { Stage } from "./Stage";
import "./characters.css";

export type { Mood } from "./characters/clips";
export type { DealerApi } from "./characters/dealer";
export type BodyPart = "head" | "hand" | "chest" | "hat" | "eyes";
export type { GestureKind } from "./characters/clips";

/** What Characters reads from the Stage's first-person camera (see the cross-module contract). */
interface FirstPersonView {
  active: boolean;
  blend: number;
  seat: number | null;
  eye: THREE.Vector3;
  forward: THREE.Vector3;
  restYaw: number;
}
/** The first-person side of Stage, read defensively (works before and after that module lands it). */
interface StageFp {
  firstPerson?: FirstPersonView;
  setPlateHidden?(seat: number, hidden: boolean): void;
  setEyeLift?(m: number): void;
  canvasRect?(): DOMRect;
  outOfBody?(sec: number): void;
  attend?(target: THREE.Vector3 | (() => THREE.Vector3 | null), sec: number, weight?: number, priority?: number): void;
}
const NO_FP: FirstPersonView = { active: false, blend: 0, seat: null, eye: new THREE.Vector3(), forward: new THREE.Vector3(0, 0, -1), restYaw: 0 };

/** Cement-shoes pier: back-left corner, water toward the left wall (clear of every chair and the walk ring). */
const PIER_POS = new THREE.Vector3(-2.55, 0, -2.25);
const PIER_YAW = -Math.PI / 2;
const RED = new THREE.Color("#FF3B3F");
const GOLD = new THREE.Color("#FFC93C");
const fmt = new Intl.NumberFormat("tr-TR", { maximumFractionDigits: 0 });

const _v = new THREE.Vector3();
const _w = new THREE.Vector3();
const _look = new THREE.Vector3();
const _aim = new THREE.Vector3();
const _card = new THREE.Vector3();

export class Characters {
  readonly dealer: DealerApi;
  private cemil: Dealer;
  private actors = new Map<string, Actor>();
  /** Same actors as an array (allocation-free iteration every frame). */
  private list: Actor[] = [];
  private hitboxes: THREE.Object3D[] = [];
  private samples = new Set<string>();
  private particles: Particles;
  private targetable = new Set<string>();
  private hover = "";
  private highlighted = "";
  private hoverDrivenAt = -10;
  private cursor = "";
  private podiumIds: string[] | null = null;
  private piles: THREE.Group[] = [];
  private cop: Npc;
  private lawyerNpc: Npc;
  private lawyerLeft = 0;
  private lawyerFor = "";
  private shared: Shared;
  private seqEnv: SeqEnv;
  private clipEnv: ClipEnv;
  private scratch = new Pose();
  private fpArms: FpArms;
  private fpLook = "";
  private fpInside = false;
  private hiddenPlate = -1;
  private eyeLift = -1;
  private myId = "";
  private phase: Phase | "" = "";
  private activeId = "";
  private activeRow = new THREE.Vector3();
  private pendingCard = "";
  private targetingMine = false;
  private myKasa = 0;
  /** The room state last synced (a live view: Colyseus patches it in place), for per-frame reads. */
  private live: KasalaStateView | null = null;
  /** Raid chance the nerves show (follows the live one, rises only once the dealt card has landed). */
  private raidChance = 0;
  private labelsHidden = false;
  /** My chip pile (first person: the paws keep off it), re-read now and then. */
  private stackAt = new THREE.Vector3();
  private stackEnd = new THREE.Vector3();
  private stackIn = 0;
  private doorLookLeft = 0;
  private layerLeft = 0;
  private layerTop = 0;
  private layerDirty = true;
  private time = 0;
  private dt = 0;
  private hlPoint = new THREE.Vector3();
  /** Masa view: my own fedora fades when it sits between the camera and the table. */
  private hatFade: { a: Actor; parts: { mesh: THREE.Mesh; orig: THREE.Material; mat: THREE.Material }[]; shells: THREE.Object3D[]; cur: number; vel: Float32Array } | null = null;

  constructor(private stage: Stage, private labelLayer: HTMLElement) {
    this.particles = new Particles(stage.world);
    labelLayer.style.pointerEvents = "none";
    this.cemil = new Dealer(stage.world, stage.anchors, this.particles);
    this.dealer = this.cemil;

    this.cop = buildCop();
    stage.world.add(this.cop.root);
    this.lawyerNpc = buildLawyer();
    stage.world.add(this.lawyerNpc.root);

    // Shared raid / elimination props (built once, hidden, re-parented when used).
    const props = new PropSet();
    const cuffs: [THREE.Mesh, THREE.Mesh] = [buildCuff(), buildCuff()];
    for (const c of cuffs) addOutlines(c, 1.08);
    const strand = (color: string, r: number): [THREE.Mesh, THREE.Mesh] => {
      const s: [THREE.Mesh, THREE.Mesh] = [buildStrand(color, r), buildStrand(color, r)];
      for (const m of s) {
        m.visible = false;
        stage.world.add(m);
      }
      return s;
    };
    const stars = buildStars();
    stars.position.set(0, 0.62, 0);
    const plate = buildNumberPlate();
    const board = buildMugshotBoard();
    board.scale.setScalar(0.85);
    stage.world.add(board);
    const camera = buildBoxCamera();
    const cement: [ReturnType<typeof buildBucket>, ReturnType<typeof buildBucket>] = [buildBucket("#8E8E8E", 0.11, 0.17), buildBucket("#8E8E8E", 0.11, 0.17)];
    for (const b of cement) b.fill.position.y = 0.15;
    const pier = buildPier();
    pier.group.position.copy(PIER_POS);
    pier.group.rotation.y = PIER_YAW;
    pier.group.visible = false;
    stage.world.add(pier.group);
    this.shared = {
      props, cuffs, cuffH: [props.add(cuffs[0]), props.add(cuffs[1])],
      chain: strand("#AEB4C2", 0.009), rope: strand("#8C6A3F", 0.012),
      stars, starsH: props.add(stars), plate, plateH: props.add(plate.group),
      board, boardH: props.add(board), camera, cameraH: props.add(camera.group),
      cement, cementH: [props.add(cement[0].group), props.add(cement[1].group)],
      pier, pierPop: new Pop(140, 16),
    };
    this.seqEnv = { anchors: stage.anchors, particles: this.particles, cop: this.cop, shared: this.shared, time: 0, dt: 0, inside: false };
    this.clipEnv = { particles: this.particles, target: null, mask: MASK_ALL, time: 0, dt: 0, inside: false };

    this.fpArms = new FpArms(this.particles, plate.group);
    stage.world.add(this.fpArms.root);

    // Fallback hover for the mouse when nobody drives updateHover (pointer lock always uses updateHover).
    stage.canvas.addEventListener("pointermove", (e) => {
      if (!this.targetable.size || this.time - this.hoverDrivenAt < 0.5) return;
      const id = this.pick(e.clientX, e.clientY);
      this.setHover(id && this.targetable.has(id) ? id : "");
    });
    const dirty = (): void => {
      this.layerDirty = true;
    };
    window.addEventListener("resize", dirty);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(dirty).observe(labelLayer);
  }

  private get sx(): StageFp {
    return this.stage as unknown as StageFp;
  }

  private fpState(): FirstPersonView {
    const f = this.sx.firstPerson;
    return f && f.eye && f.forward ? f : NO_FP;
  }

  // ===================================================================== state
  sync(state: KasalaStateView, myId: string): void {
    if (this.samples.size) this.removeSamples();
    const prevActive = this.activeId;
    this.live = myId ? state : null;
    this.myId = myId;
    this.phase = state.phase;
    this.activeId = state.activeId;
    this.pendingCard = state.pendingCard;
    if (prevActive !== state.activeId || !myId) this.raidChance = myId ? state.raidChance : 0;
    this.targetingMine = !!myId && state.phase === "targeting" && state.activeId === myId;
    this.myKasa = state.players.get(myId)?.kasa ?? 0;
    const lobby = state.phase === "lobby";
    const ids: string[] = [];
    if (lobby) state.players.forEach((p) => { if (!p.spectator) ids.push(p.id); });
    else state.turnOrder.forEach((id) => ids.push(id));
    const keep = new Set(ids);
    let changed = false;
    for (const id of ids) {
      const p = state.players.get(id);
      if (!p) continue;
      let a = this.actors.get(id);
      if (a && (a.animal !== p.animal || a.color !== p.color)) {
        this.removeActor(a);
        this.actors.delete(id);
        a = undefined;
      }
      if (!a) {
        a = this.makeActor(id, p.animal, p.color, false);
        this.actors.set(id, a);
        changed = true;
      }
      a.data = p;
      a.active = state.activeId === id;
      // A new turn heals the raid black eye.
      if (a.active && prevActive !== id && !a.seq) a.blackEye = false;
      const pose = this.stage.seatPose(p.seat, this.stage.seatCount);
      this.place(a, p.seat, pose.chair, pose.yaw);
      if (a.active) this.activeRow.copy(pose.cardRow);
      a.pr.collar.want = p.taslik;
      a.pr.ironBall.want = p.taslik;
      a.pr.nazar.want = p.cursed;
      a.pr.briefcase.want = p.lawyerNext;
      a.pr.moss.want = a.pr.fish.want = p.ghostReturned;
      a.pr.stamp.want = p.karaListe;
      a.skin = p.ghost ? "ghost" : p.connected ? "normal" : "grey";
      const me = id === myId;
      const l = a.label;
      l.setName(p.nickname);
      l.setKasa(lobby ? "" : `${fmt.format(p.kasa)}$`);
      l.setIcons(
        (p.bot ? "🤖" : "") + (p.ghost ? "👻" : "") + (p.taslik ? "⛓" : "") + (p.cursed ? "🧿" : "") +
        (p.trapped ? "🪤" : "") + (p.lawyerNext ? "⚖️" : ""),
      );
      l.setColor(sceneColor(p.color));
      l.flag("ks-char-label--me", me);
      l.flag("ks-char-label--ghost", p.ghost);
      l.flag("ks-char-label--offline", !p.connected);
      l.flag("ks-char-label--active", a.active && !lobby);
    }
    for (const [id, a] of this.actors) {
      if (keep.has(id)) continue;
      this.removeActor(a);
      this.actors.delete(id);
      changed = true;
    }
    if (changed) this.refreshList();
    else this.refreshHitboxes();
    this.refreshPreviews();
    this.refreshFpLook();
    this.stackIn = 0;
  }

  /**
   * Hide every floating name label (taunt bubbles stay), e.g. while a hero card is held up so names never
   * draw over it. Cheap to call every frame: only a change is stored, the DOM follows in the label pass.
   */
  setLabelsHidden(on: boolean): void {
    this.labelsHidden = on;
  }

  setAttract(on: boolean): void {
    if (!on) {
      this.removeSamples();
      return;
    }
    if (this.samples.size) return;
    for (let i = 0; i < 4; i++) {
      const id = "sample-" + i;
      const a = this.makeActor(id, ANIMALS[i]!.id, i, true);
      const pose = this.stage.seatPose(i, 4);
      this.place(a, i, pose.chair, pose.yaw);
      this.actors.set(id, a);
      this.samples.add(id);
    }
    this.refreshList();
    this.dealer.shuffle(true);
  }

  // ================================================================ targeting
  pick(clientX: number, clientY: number): string | null {
    if (!this.hitboxes.length) return null;
    const hits = this.stage.raycast(clientX, clientY, this.hitboxes, false);
    const id = hits[0]?.object.userData.playerId;
    return typeof id === "string" ? id : null;
  }

  setTargetable(ids: string[] | null): void {
    this.targetable = new Set(ids ?? []);
    if (!this.targetable.has(this.hover)) this.hover = "";
    if (!this.targetable.has(this.highlighted)) this.highlighted = "";
    this.setCursor(this.targetable.size ? "crosshair" : "");
    for (const a of this.list) a.marker.group.visible = this.targetable.has(a.id);
    this.refreshPreviews();
  }

  /** Per frame while targeting: `aim` is the pointer (or the screen center under pointer lock), null = none. */
  updateHover(aim: { x: number; y: number } | null): void {
    this.hoverDrivenAt = this.time;
    if (!this.targetable.size) {
      this.setHover("");
      return;
    }
    const id = aim ? this.pick(aim.x, aim.y) : null;
    this.setHover(id && this.targetable.has(id) ? id : "");
  }

  /** Keyboard target cycling: mark one target (and in first person, turn the view toward them). */
  highlight(playerId: string | null): void {
    const id = playerId && this.targetable.has(playerId) ? playerId : "";
    if (id === this.highlighted) return;
    this.highlighted = id;
    if (id && this.fpInside) {
      const a = this.actors.get(id);
      const at = this.hlPoint;
      if (a) this.sx.attend?.(() => (a.root.visible ? a.face.head.getWorldPosition(at) : null), 1.2, 0.8);
    }
  }

  private setHover(id: string): void {
    this.hover = id;
    this.setCursor(this.targetable.size ? (id ? "pointer" : "crosshair") : "");
  }

  private setCursor(c: string): void {
    if (c === this.cursor) return;
    this.cursor = c;
    this.stage.canvas.style.cursor = c;
  }

  // ================================================================== anchors
  anchor(playerId: string, part: BodyPart, out: THREE.Vector3): boolean {
    const a = this.actors.get(playerId);
    if (!a) return false;
    if (playerId === this.myId && this.fpInside) {
      // In first person my own head/hands are around the camera: give points in front of the eye instead.
      const fp = this.fpState();
      const fx = Math.sin(a.yaw);
      const fz = Math.cos(a.yaw);
      switch (part) {
        case "eyes":
          out.copy(fp.eye);
          break;
        case "hand":
          this.fpArms.handWorld(0, out);
          break;
        case "chest":
          out.set(fp.eye.x + fx * 0.45, fp.eye.y - 0.3, fp.eye.z + fz * 0.45);
          break;
        default:
          out.set(fp.eye.x + fx * 0.9, fp.eye.y + 0.08, fp.eye.z + fz * 0.9);
      }
      return true;
    }
    if (part === "eyes") {
      a.face.eyes[0]!.root.getWorldPosition(out);
      a.face.eyes[1]!.root.getWorldPosition(_v);
      out.add(_v).multiplyScalar(0.5);
      return true;
    }
    const obj = part === "head" ? a.face.head : part === "hat" ? a.fedora.group : part === "chest" ? a.rig.chest : a.rig.arms[1].hand;
    obj.getWorldPosition(out);
    return true;
  }

  // ================================================================ reactions
  react(playerId: string, mood: Mood): void {
    const a = this.actors.get(playerId);
    if (!a || mood === "idle") return;
    startClip(a, MOOD_CLIPS[mood], mood === "shock" ? 1.2 : 1.65);
    a.puppet.kick(mood === "shock" ? -4 : mood === "happy" || mood === "cheer" ? 3 : mood === "laugh" ? 1.5 : -1, mood === "angry" ? 2 : 0);
    if (mood === "shock") a.puppet.blink();
    // A sequence (raid, ghost return…) owns my hands meanwhile: the reaction stays on the (hidden) face.
    if (this.isMeInside(playerId) && !a.seq) {
      if (mood === "cheer") this.fpArms.play("cheer");
      else if (mood === "shock") this.fpArms.play("flinch");
      else if (mood === "nervous") this.fpArms.play("drum");
    }
  }

  emote(playerId: string, emote: EmoteId): void {
    const a = this.actors.get(playerId);
    if (!a) return;
    startClip(a, EMOTE_CLIPS[emote]);
    // Never over a sequence (my at-seat raid keeps its cuffs / wallet / plate): face only, like the 3D body.
    if (this.isMeInside(playerId) && !a.seq) this.fpArms.play(emote, { target: this.emoteTarget(a, _aim) ? _aim : null });
  }

  taunt(playerId: string, text: string): void {
    const a = this.actors.get(playerId);
    if (!a) return;
    a.label.setBubble(text);
    a.tauntLeft = TAUNT_SEC;
    a.puppet.kick(1);
  }

  /** Table gestures: knock on the felt (flip), slam + rake (KASALA), push chips (bet). */
  gesture(playerId: string, kind: GestureKind): void {
    const a = this.actors.get(playerId);
    if (!a) return;
    startClip(a, GESTURE_CLIPS[kind]);
    if (this.isMeInside(playerId)) this.fpArms.play(kind);
  }

  /**
   * KASALA celebration sized to the result phase. Game sends gesture("slam") right before: the celebration
   * rises once the slam has hit and the pot is raked in (≈0.6 s), in third person and in first person.
   */
  cash(playerId: string, big: boolean, sec?: number): void {
    const a = this.actors.get(playerId);
    if (!a) return;
    const dur = Math.max(1.4, (sec ?? (big ? CASH_RESULT_BIG_SEC : CASH_RESULT_SEC)) - 0.25);
    startClip(a, CASH_CLIP, dur, big);
    if (this.isMeInside(playerId)) this.fpArms.play("cheer", { sec: Math.min(dur - 0.55, 1.6), delay: 0.55, bills: big ? 16 : 7 });
  }

  // ================================================================ sequences
  raid(playerId: string, anim: RaidAnim, opts?: { long?: boolean; sec?: number }): void {
    const a = this.actors.get(playerId);
    if (!a) return;
    this.endSeq(a);
    const long = opts?.long ?? true;
    const sec = opts?.sec ?? (long ? RAID_RESULT_SEC : RAID_RESULT_SHORT_SEC);
    const seq = new RaidSeq(a, { anim, long, sec }, this.envNow());
    a.seq = seq;
    a.face.head.add(this.shared.stars);
    for (const r of a.clips) if (r.def.kind !== "mood") fadeClip(r);
    this.doorLookLeft = seq.mode === "seat" ? 0 : 1.3;
    if (playerId === this.myId) {
      if (seq.outOfBodySec > 0) this.sx.outOfBody?.(seq.outOfBodySec);
      else if (this.fpInside) this.fpHold(seq);
    }
  }

  /** First person: my arms take over what the hidden body holds in this raid (plate, cuffs, wallet). */
  private fpHold(seq: RaidSeq): void {
    const hold = seq.fpHold();
    if (hold) this.fpArms.play(hold.pose, { sec: hold.left });
  }

  lawyer(playerId: string): void {
    const a = this.actors.get(playerId);
    if (!a) return;
    this.lawyerFor = playerId;
    this.lawyerLeft = 1.8;
    _v.copy(a.home).addScaledVector(a.right, 0.55).addScaledVector(a.out, 0.18).setY(0);
    this.lawyerNpc.appear(_v, a.yaw - 0.6, true);
    this.particles.poof(_w.copy(_v).setY(0.8), 0.14, "#E9E4F0", 12);
    startClip(a, MOOD_CLIPS.happy, 1.8);
    a.puppet.kick(3);
  }

  eliminate(playerId: string): void {
    const a = this.actors.get(playerId);
    if (!a) return;
    this.endSeq(a);
    for (const r of a.clips) if (r.def.kind !== "mood") fadeClip(r);
    const seq = new EliminateSeq(a, ELIMINATION_SEC, this.envNow());
    a.seq = seq;
    if (playerId === this.myId) this.sx.outOfBody?.(seq.outOfBodySec);
  }

  ghostReturn(playerId: string): void {
    const a = this.actors.get(playerId);
    if (!a) return;
    this.endSeq(a);
    a.seq = new ReturnSeq(2);
  }

  podium(order: string[] | null): void {
    this.podiumIds = order;
    for (const pile of this.piles) this.stage.world.remove(pile);
    this.piles = [];
    if (!order) {
      for (const a of this.list) {
        if (a.seq?.kind === "podium") this.endSeq(a);
        a.blackEye = false;
      }
      this.shared.pierPop.target = 0;
      return;
    }
    const base = this.stage.anchors.podium;
    const cam = _w.set(base.x + 0.4, 0, base.z + 5.4);
    const offsets = [0, -1.1, 1.1];
    const tops: number[] = [];
    // Money piles for the top three, but never for the last place (2–3 players): they sulk on the floor under
    // the sack.
    const pileCount = order.length <= 1 ? order.length : Math.min(3, order.length - 1);
    order.slice(0, pileCount).forEach((_id, i) => {
      const pile = buildMoneyPile(7 - i * 2, i + 1);
      pile.position.copy(base).add(_v.set(offsets[i]!, 0, 0));
      this.stage.world.add(pile);
      this.piles.push(pile);
      tops.push(Number(pile.userData.top ?? 0));
    });
    const losers = Math.max(0, order.length - pileCount);
    order.forEach((id, k) => {
      const a = this.actors.get(id);
      if (!a) return;
      this.endSeq(a);
      let at: THREE.Vector3;
      let top = 0;
      if (k < pileCount && this.piles[k]) {
        top = tops[k]!;
        at = this.piles[k]!.position.clone().setY(top);
      } else {
        const j = k - pileCount;
        at = new THREE.Vector3(base.x - 0.35 + (j - (losers - 1) / 2) * 0.75, 0, base.z + 0.8);
      }
      a.seq = new PodiumSeq(a, { at, top, place: k + 1, last: k === order.length - 1 && order.length > 1, faceYaw: facing(at, cam) }, 0.15 * k);
    });
  }

  // ==================================================================== frame
  update(dt: number, time: number): void {
    this.time = time;
    this.dt = dt;
    this.doorLookLeft = Math.max(0, this.doorLookLeft - dt);
    this.updateRaidChance();
    const fp = this.fpState();
    this.updateFp(fp);
    this.envNow();
    // Cemil Abi watches the active player (my eye in first person on my turn) and deals toward their row.
    const act = this.activeId ? this.actors.get(this.activeId) : undefined;
    if (act && act.root.visible) {
      if (act.id === this.myId && this.fpInside) this.cemil.focus.copy(fp.eye);
      else act.face.head.getWorldPosition(this.cemil.focus).y += 0.15;
      this.cemil.hasFocus = true;
      this.cemil.dealTo.copy(this.activeRow);
    } else {
      this.cemil.hasFocus = false;
      this.cemil.dealTo.copy(this.stage.anchors.deck);
    }
    this.cemil.update(dt, time);
    let copOwned = false;
    for (const a of this.list) {
      this.updateActor(a, dt, time, fp);
      if (a.seq && this.cop.owner === a.seq) copOwned = true;
    }
    if (!copOwned && this.cop.shown) this.cop.vanish();
    this.cop.update(dt, time);
    this.updateLawyer(dt, time);
    // First person: anyone passing right through my head disappears instead of filling the screen.
    this.clipNearEye(this.cop.rig.tilt, this.cop.root, fp);
    this.clipNearEye(this.lawyerNpc.rig.tilt, this.lawyerNpc.root, fp);
    this.updateShared(dt, time);
    const me = this.myId ? this.actors.get(this.myId) : undefined;
    if (me && this.fpInside) {
      this.fpArms.setSkin(me.skin);
      this.fpArms.setNervous(me.active && this.inMatch ? this.raidChance : 0);
      this.stackIn -= dt;
      if (this.stackIn <= 0) {
        // My pile moves when first person turns on (Stage.seatPose → layout.fpPileSpot): re-read it now and
        // then. It is a chip tower at the anchor with the bricks running in toward the table center, ~20 cm
        // wide: the paws keep off a capsule along that axis.
        this.stackIn = 0.5;
        const at = this.stage.seatPose(me.seat, this.stage.seatCount).stack;
        this.stackAt.copy(at).addScaledVector(me.right, 0.03).addScaledVector(me.out, 0.06);
        this.stackEnd.copy(at).addScaledVector(me.right, 0.03).addScaledVector(me.out, -0.22);
        this.fpArms.setAvoid(this.phase === "lobby" ? null : this.stackAt, this.stackEnd);
      }
      // The arms follow the seat's rest view (camera convention yaw → model yaw), not the mouse-look.
      const yaw = Number.isFinite(fp.restYaw) ? fp.restYaw + Math.PI : me.yaw;
      const cam = this.stage.camera;
      this.fpArms.update(dt, time, fp.eye, yaw, TABLE_TOP_Y, true, cam.fov, cam.aspect);
    } else this.fpArms.update(dt, time, fp.eye, 0, TABLE_TOP_Y, false);
    this.updateHatFade(dt);
    this.particles.update(dt, time);
    this.updateLabels(fp);
  }

  private get inMatch(): boolean {
    return this.phase !== "lobby" && this.phase !== "";
  }

  /**
   * The nerves follow the live raid chance (sync only runs on roster changes, the chance moves with every
   * card). A rise waits until the dealt card has landed, so the sweat never tells the card before it shows.
   */
  private updateRaidChance(): void {
    const live = this.live ? this.live.raidChance : 0;
    if (!Number.isFinite(live) || live === this.raidChance) return;
    if (live < this.raidChance || this.cemil.sinceDeal > 1.3) this.raidChance = live;
  }

  // =================================================================== actors
  private makeActor(id: string, animal: Animal, color: number, sample: boolean): Actor {
    const label = new Label(this.labelLayer, sceneColor(color));
    const a = createActor(id, animal, color, sample, label);
    this.stage.world.add(a.root, a.chair);
    return a;
  }

  /** Seat (re)assignment: teleport straight to the new chair unless a sequence owns the root. */
  private place(a: Actor, seat: number, chair: THREE.Vector3, yaw: number): void {
    if (a.placed && a.seat === seat && a.chairHome.distanceToSquared(chair) < 1e-6) return;
    const first = !a.placed;
    a.placed = true;
    a.seat = seat;
    a.yaw = yaw;
    a.phi = yaw - Math.PI;
    a.out.set(Math.sin(a.phi), 0, Math.cos(a.phi));
    a.right.set(Math.cos(a.phi), 0, -Math.sin(a.phi));
    a.chairHome.copy(chair).setY(0);
    a.home.copy(a.chairHome).addScaledVector(a.out, -0.08);
    const girth = a.animal === "domuz" ? 1.18 : a.animal === "fare" ? 0.82 : 1;
    const lateral = 0.17 + 0.05 * girth;
    for (let i = 0; i < 2; i++) {
      a.rest[i]!.copy(a.out).multiplyScalar(1.5).addScaledVector(a.right, i === 0 ? lateral : -lateral).setY(TABLE_TOP_Y + 0.15);
    }
    a.chair.rotation.y = yaw;
    a.chair.position.copy(a.chairHome).addScaledVector(a.out, 0.35 * a.chairOut);
    if (!a.seq) {
      a.root.position.copy(a.home);
      a.root.rotation.y = yaw;
      a.rootVel.set(0, 0, 0);
      a.puppet.resetMotion();
      if (!first) this.particles.poof(_v.copy(a.home).setY(0.9), 0.14, "#E9E4F0", 10);
    }
    if (first) {
      a.puppet.target.reset();
      a.puppet.refreshTorso();
      seatedRest(a, a.puppet.target);
      a.puppet.settle();
    }
  }

  private removeActor(a: Actor): void {
    this.endSeq(a);
    if (this.hatFade?.a === a) this.releaseHatFade();
    if (this.hiddenPlate === a.seat && a.id === this.myId) {
      this.sx.setPlateHidden?.(this.hiddenPlate, false);
      this.hiddenPlate = -1;
    }
    this.stage.world.remove(a.root, a.chair);
    // Shared raid props may hang on this rig: take them back before freeing it.
    const sh = this.shared;
    for (const o of [sh.stars, sh.plate.group, sh.cuffs[0], sh.cuffs[1], sh.cement[0].group, sh.cement[1].group]) {
      let p = o.parent;
      while (p && p !== a.root) p = p.parent;
      if (p) o.removeFromParent();
    }
    a.props.clear();
    disposeOwned(a.root);
    a.label.remove();
  }

  private removeSamples(): void {
    if (!this.samples.size) return;
    for (const id of this.samples) {
      const a = this.actors.get(id);
      if (a) {
        this.removeActor(a);
        this.actors.delete(id);
      }
    }
    this.samples.clear();
    this.refreshList();
    this.dealer.shuffle(false);
  }

  private refreshList(): void {
    this.list.length = 0;
    for (const a of this.actors.values()) this.list.push(a);
    this.refreshHitboxes();
  }

  private refreshHitboxes(): void {
    this.hitboxes.length = 0;
    for (const a of this.list) if (!a.sample && a.id !== this.myId) this.hitboxes.push(a.rig.hitbox);
  }

  private endSeq(a: Actor): void {
    if (!a.seq) return;
    a.seq.finish(a, this.envNow());
    a.seq = null;
    a.root.visible = true;
  }

  private envNow(): SeqEnv {
    this.seqEnv.time = this.time;
    this.seqEnv.dt = this.dt;
    return this.seqEnv;
  }

  private isMeInside(id: string): boolean {
    return id === this.myId && this.fpInside;
  }

  private updateActor(a: Actor, dt: number, time: number, fp: FirstPersonView): void {
    if (a.tauntLeft > 0) {
      a.tauntLeft = Math.max(0, a.tauntLeft - dt);
      if (a.tauntLeft === 0) a.label.setBubble("");
    }
    const g = a.glance;
    g.next -= dt;
    if (g.left > 0) g.left -= dt;
    else if (g.next <= 0) this.newGlance(a);
    const p = a.puppet.target.reset();
    a.puppet.refreshTorso();
    const seq = a.seq;
    const inside = this.fpInside && a.id === this.myId;
    this.seqEnv.inside = this.clipEnv.inside = inside;
    let lock = 0;
    if (seq) {
      seq.t += dt;
      seq.update(a, p, this.seqEnv);
      lock = seq.lock;
      // First person: the raid's number plate hangs on my (hidden) body right in front of the lens; FpArms
      // hold their own copy instead.
      const sh = this.shared;
      if (inside && sh.plate.group.parent === a.root) {
        sh.plateH.want = false;
        sh.plateH.pop.snap(0);
      }
    } else {
      this.poseBase(a, p, dt, time, fp);
      // Back home without snapping (after a seat change mid-move, a finished sequence…).
      followV(a.root.position, a.home, a.rootVel, 9, dt);
      a.root.rotation.y = approachAngle(a.root.rotation.y, a.yaw, 8, dt);
    }
    if (a.clips.length) this.applyClips(a, p, dt, time, lock);
    // The chair slides back when they stand.
    const want = seq?.chairOut ?? clamp((1 - a.puppet.pose.sit) * 1.6, 0, 1);
    a.chairOut = follow(a.chairOut, want, a.chairVel, 0, 10, dt);
    a.chair.position.copy(a.chairHome).addScaledVector(a.out, 0.35 * a.chairOut);
    a.root.visible = !seq?.hidden;
    a.rig.squash.visible = !inside;
    if (a.id !== this.myId) this.clipNearEye(a.rig.tilt, a.root, fp);
    a.puppet.setSkin(seq?.skin ?? a.skin);
    if (a.pr.blackEye) a.pr.blackEye.want = a.blackEye;
    a.props.update(dt);
    // Target marker: pulse, gold when hovered / highlighted.
    if (a.marker.group.visible) {
      const hot = a.id === this.hover || a.id === this.highlighted;
      if (a.marker.group.userData.hot !== hot) {
        a.marker.group.userData.hot = hot;
        const c = hot ? GOLD : RED;
        (a.marker.ring.material as THREE.MeshBasicMaterial).color.copy(c);
        a.marker.arrow.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && m.name !== "outline") (m.material as THREE.MeshToonMaterial).color.copy(c);
        });
      }
      a.marker.ring.scale.setScalar(0.62 * (1 + Math.sin(time * (hot ? 12 : 8)) * (hot ? 0.14 : 0.08)));
      a.marker.arrow.position.y = 1.85 + Math.sin(time * 7) * 0.09;
      a.marker.arrow.rotation.y += dt * (hot ? 5 : 1.5);
    }
    if (seq?.settleNow) {
      a.puppet.settle();
      seq.settleNow = false;
    }
    if (a.root.visible) a.puppet.update(dt, time);
    if (seq && seq.done) {
      seq.finish(a, this.seqEnv);
      a.seq = null;
    }
  }

  /** Seated life: breathing, hands on the rail, watching the action, nerves on your own turn, fidgets. */
  private poseBase(a: Actor, p: Pose, dt: number, time: number, fp: FirstPersonView): void {
    const inMatch = this.phase !== "lobby" && this.phase !== "";
    if (a.skin === "ghost") {
      ghostPose(p, time, a.seed);
    } else if (a.data && !a.data.connected) {
      // Dozing off while disconnected.
      seatedRest(a, p);
      p.hand(0, -0.15, 0.1, 0.24, -0.7, -0.4, -0.4).hand(1, 0.15, 0.1, 0.24, 0.7, -0.4, -0.4);
      p.lid = 0.05;
      p.headPitch = 0.38;
      p.headRoll = 0.15;
      p.lean = 0.1;
      p.mouth = "flat";
      return;
    } else {
      seatedRest(a, p);
      const ph = time * 2.2 + a.seed;
      p.stretch += 0.025 * Math.sin(ph);
      p.shrug += 0.12 * Math.max(0, Math.sin(ph));
      p.headPitch -= 0.03 * Math.sin(ph - 0.6);
      p.lean = 0.05;
      p.lid = 0.9;
      p.mouth = "smirk";
      if (a.active && inMatch) {
        // On the spot: leaning in, eyes wide; past ~30% raid chance the hands shake and the sweat starts.
        p.lean = 0.12;
        p.lid = 1.15;
        const nerves = clamp((this.raidChance - 0.25) / 0.35, 0, 1);
        if (nerves > 0) {
          const j = 0.01 * nerves;
          for (let i = 0; i < 2; i++) {
            const arm = p.arms[i]!;
            arm.t.x += wobble(time * 11, a.seed + i) * j;
            arm.t.y += Math.abs(wobble(time * 13, a.seed + 3 + i)) * j;
          }
          p.brow = "skeptic";
          p.mouth = nerves > 0.6 ? "flat" : "smirk";
          a.sweatIn -= dt;
          if (a.sweatIn <= 0 && !(this.fpInside && a.id === this.myId)) {
            a.sweatIn = 1.5 - nerves * 0.6;
            a.face.head.localToWorld(_v.set(0.17, 0.3, 0.08));
            this.particles.drop(_v, _w.set(0, -0.1, 0), 0.02, "#BFE9FF", 1.1, 2.2);
          }
        }
      }
    }
    // Look-at layer: eyes lead, the head follows.
    const w = this.lookFor(a, fp, _look);
    if (w > 0) aimHead(p, a, _look, w);
    // Fidgets now and then (samples on the home screen also emote).
    a.idleIn -= dt;
    if (a.idleIn <= 0) {
      a.idleIn = rand(4, 9);
      if (!a.clips.length && a.skin === "normal") {
        if (a.sample && Math.random() < 0.45) startClip(a, EMOTE_CLIPS[pick(["puro", "paraSay", "opucuk", "allahAllah", "yumruk"] as const)]);
        else startClip(a, pick(IDLE_CLIPS));
      }
    }
  }

  /** Where this actor looks (world point) and how strongly. */
  private lookFor(a: Actor, fp: FirstPersonView, out: THREE.Vector3): number {
    if (this.doorLookLeft > 0) {
      out.copy(this.stage.anchors.door).setY(1.3);
      return 0.9;
    }
    if (this.cardPoint(out)) return 0.85;
    const g = a.glance;
    if (g.left > 0) {
      if (g.id === "dealer") {
        this.cemil.face.head.getWorldPosition(out).y += 0.15;
        return 0.75;
      }
      const o = this.actors.get(g.id);
      if (o && o.root.visible) {
        if (o.id === this.myId && this.fpInside) out.copy(fp.eye);
        else o.face.head.getWorldPosition(out).y += 0.15;
        return 0.75;
      }
    }
    if (a.id === this.activeId) {
      out.copy(this.stage.anchors.deck);
      return 0.6;
    }
    const act = this.activeId ? this.actors.get(this.activeId) : undefined;
    if (act && act.root.visible && !act.sample) {
      if (act.id === this.myId && this.fpInside) out.copy(fp.eye);
      else act.face.head.getWorldPosition(out).y += 0.15;
      return 0.85;
    }
    if (this.cemil.talking) {
      this.cemil.face.head.getWorldPosition(out).y += 0.15;
      return 0.7;
    }
    out.set(0, TABLE_TOP_Y + 0.25, 0);
    return 0.35;
  }

  /** The card in flight right after a deal (tower → the active seat's row), for everyone's eyes. */
  private cardPoint(out: THREE.Vector3): boolean {
    const s = this.cemil.sinceDeal;
    if (s > 1.15 || !this.activeId) return false;
    out.copy(this.stage.anchors.deck);
    out.y += 0.2;
    _card.copy(this.activeRow);
    _card.y += 0.12;
    out.lerp(_card, easeInOut(seg(s, 0.3, 1.05)));
    return true;
  }

  private newGlance(a: Actor): void {
    a.glance.next = rand(3, 7);
    if (this.list.length < 2 || Math.random() < 0.2) {
      a.glance.id = "dealer";
    } else {
      let o = a;
      for (let k = 0; k < 4 && o === a; k++) o = this.list[Math.floor(Math.random() * this.list.length)]!;
      if (o === a) return;
      a.glance.id = o.id;
    }
    a.glance.left = rand(0.6, 1.3);
    if (Math.random() < 0.5) a.puppet.blink();
  }

  private applyClips(a: Actor, p: Pose, dt: number, time: number, lock: number): void {
    const env = this.clipEnv;
    env.time = time;
    env.dt = dt;
    env.target = this.emoteTarget(a, _aim) ? _aim : null;
    for (let i = 0; i < a.clips.length; i++) {
      const r = a.clips[i]!;
      r.t += dt;
      const w = clipWeight(r);
      const mask = r.def.mask & ~lock;
      if (w <= 0 || !mask) continue;
      env.mask = mask;
      this.scratch.copy(p);
      r.def.pose(this.scratch, r, a, env);
      p.blend(this.scratch, w, mask);
    }
    for (let i = a.clips.length - 1; i >= 0; i--) if (a.clips[i]!.t >= a.clips[i]!.dur) a.clips.splice(i, 1);
  }

  /** Who an aimed emote goes to: the active player (if not me), else the nearest rival. */
  private emoteTarget(a: Actor, out: THREE.Vector3): boolean {
    let best: Actor | null = null;
    const act = this.activeId ? this.actors.get(this.activeId) : undefined;
    if (act && act !== a && act.root.visible && !act.sample) best = act;
    else {
      let bestD = Infinity;
      for (const o of this.list) {
        if (o === a || !o.root.visible) continue;
        const d = o.root.position.distanceToSquared(a.root.position);
        if (d < bestD) {
          bestD = d;
          best = o;
        }
      }
    }
    if (!best) return false;
    if (best.id === this.myId && this.fpInside) out.copy(this.fpState().eye);
    else best.face.head.getWorldPosition(out).y += 0.2;
    return true;
  }

  // ================================================================ first person
  private updateFp(fp: FirstPersonView): void {
    const me = this.myId ? this.actors.get(this.myId) : undefined;
    const inside = !!me && !me.sample && fp.active && fp.blend > 0.8 && !(me.seq && (me.seq.away || me.seq.hidden));
    if (inside !== this.fpInside) {
      this.fpInside = inside;
      this.stackIn = 0;
      if (!inside) this.fpArms.clear();
      // Back inside mid-raid (after the drag out, or a view switch): the arms pick up what the body holds.
      else if (me && me.seq instanceof RaidSeq) this.fpHold(me.seq);
    }
    const seat = inside && me ? me.seat : -1;
    if (seat !== this.hiddenPlate) {
      if (this.hiddenPlate >= 0) this.sx.setPlateHidden?.(this.hiddenPlate, false);
      if (seat >= 0) this.sx.setPlateHidden?.(seat, true);
      this.hiddenPlate = seat;
    }
    const lift = me && !me.seq?.away ? clamp((1 - me.puppet.pose.sit) * 0.125, 0, 0.125) : 0;
    if (Math.abs(lift - this.eyeLift) > 0.0005) {
      this.eyeLift = lift;
      this.sx.setEyeLift?.(lift);
    }
  }

  private clipNearEye(part: THREE.Object3D, root: THREE.Object3D, fp: FirstPersonView): void {
    let show = true;
    if (this.fpInside && root.visible) {
      const dx = root.position.x - fp.eye.x;
      const dy = root.position.y + 1.0 - fp.eye.y;
      const dz = root.position.z - fp.eye.z;
      show = dx * dx + dy * dy + dz * dz > 0.45 * 0.45;
    }
    if (part.visible !== show) part.visible = show;
  }

  private refreshFpLook(): void {
    const me = this.myId ? this.actors.get(this.myId) : undefined;
    if (this.hatFade && this.hatFade.a !== me) this.releaseHatFade();
    if (!me) return;
    if (!this.hatFade) this.setupHatFade(me);
    const key = `${me.animal}|${me.color}`;
    if (key === this.fpLook) return;
    this.fpLook = key;
    this.fpArms.setLook(ANIMAL_BY_ID[me.animal].fur, sceneColor(me.color));
  }

  /** Give my own fedora private fadeable materials (everyone else keeps the shared ones). */
  private setupHatFade(a: Actor): void {
    const parts: { mesh: THREE.Mesh; orig: THREE.Material; mat: THREE.Material }[] = [];
    const shells: THREE.Object3D[] = [];
    a.fedora.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      if (m.name === "outline") {
        shells.push(m);
        return;
      }
      if (m.userData.keepSkin || Array.isArray(m.material)) return;
      const orig = (m.userData.mat0 as THREE.Material | undefined) ?? (m.material as THREE.Material);
      const mat = orig.clone();
      mat.transparent = true;
      parts.push({ mesh: m, orig, mat });
      a.puppet.setMaterial(m, mat);
    });
    this.hatFade = { a, parts, shells, cur: 1, vel: new Float32Array(1) };
  }

  private releaseHatFade(): void {
    const f = this.hatFade;
    if (!f) return;
    for (const p of f.parts) {
      f.a.puppet.setMaterial(p.mesh, p.orig);
      p.mat.dispose();
    }
    for (const s of f.shells) s.visible = true;
    this.hatFade = null;
  }

  private updateHatFade(dt: number): void {
    const f = this.hatFade;
    if (!f) return;
    let want = 1;
    if (!this.fpInside && f.a.root.visible && this.phase !== "lobby") {
      // Does my hat sit on the camera's line of sight to the table center?
      const cam = this.stage.camera.position;
      f.a.fedora.group.getWorldPosition(_v);
      _w.set(0, TABLE_TOP_Y, 0).sub(cam);
      const len = _w.length();
      _w.divideScalar(Math.max(1e-4, len));
      const along = _v.sub(cam).dot(_w);
      if (along > 0 && along < len) {
        const off = _v.addScaledVector(_w, -along).length();
        want = off < 0.5 ? 0.3 : off < 0.8 ? 0.3 + ((off - 0.5) / 0.3) * 0.7 : 1;
      }
    }
    f.cur = clamp(follow(f.cur, want, f.vel, 0, 8, dt), 0, 1);
    for (const p of f.parts) p.mat.opacity = f.cur;
    const solid = f.cur > 0.97;
    for (const s of f.shells) s.visible = solid;
  }

  // ==================================================================== npcs
  private updateLawyer(dt: number, time: number): void {
    const law = this.lawyerNpc;
    if (this.lawyerLeft > 0 && law.shown) {
      this.lawyerLeft = Math.max(0, this.lawyerLeft - dt);
      const t = 1.8 - this.lawyerLeft;
      const p = law.puppet.target.reset();
      p.sit = 0;
      law.puppet.refreshTorso();
      p.hand(0, -0.22, 0.03, 0.08, -0.7, -0.2, -0.6);
      p.hand(1, 0.24, 0.62 + Math.sin(t * 12) * 0.06, 0.3, 0.8, -0.3, -0.3);
      p.mouth = "grin";
      p.brow = "up";
      p.bounce = Math.abs(Math.sin(t * 12)) * 0.02;
      const a = this.actors.get(this.lawyerFor);
      if (a) aimHead(p, law, a.face.head.getWorldPosition(_v), 0.8);
      if (this.lawyerLeft <= 0.25) law.vanish();
    } else if (law.shown && law.pop.target > 0) law.vanish();
    law.update(dt, time);
  }

  private updateShared(dt: number, time: number): void {
    const sh = this.shared;
    sh.props.update(dt);
    if (sh.stars.visible) {
      sh.stars.rotation.y += dt * 4;
      const kids = sh.stars.children;
      for (let i = 0; i < kids.length; i++) {
        const st = kids[i]!;
        const ph = (st.userData.phase as number) ?? 0;
        st.position.set(Math.cos(ph) * 0.22, Math.sin(time * 6 + i * 2) * 0.03, Math.sin(ph) * 0.22);
        st.rotation.z += dt * 3;
      }
    }
    const pier = sh.pier.group;
    sh.pierPop.step(dt);
    const x = sh.pierPop.x;
    pier.visible = x > 0.003;
    pier.scale.set(1, Math.max(0.001, x), 1);
  }

  // =================================================================== labels
  private refreshPreviews(): void {
    for (const a of this.list) {
      let text = "";
      let tone: PreviewTone = "bad";
      if (this.targetingMine && this.targetable.has(a.id) && a.data) {
        const kasa = a.data.kasa;
        switch (this.pendingCard) {
          case "harac":
            text = `💸 −${fmt.format(Math.max(0, Math.floor((kasa * Math.round(HARAC_PCT * 100)) / 100)))}$`;
            tone = "bad";
            break;
          case "takas":
            text = `🔄 ${fmt.format(kasa)}$ ⇄ ${fmt.format(this.myKasa)}$`;
            tone = kasa > this.myKasa ? "good" : "bad";
            break;
          case "lanet":
            text = "🧿 ilk para kartı 0$";
            tone = "info";
            break;
          default:
            break;
        }
      }
      a.label.setPreview(text, tone);
    }
  }

  private wantLabel(a: Actor, fp: FirstPersonView): boolean {
    if (a.sample || this.podiumIds || !a.data || !a.root.visible || a.seq?.hidden) return false;
    if (a.id === this.myId || this.labelsHidden) return a.tauntLeft > 0;
    if (this.phase === "lobby" || !this.fpInside) return true;
    if (a.active || this.targetable.has(a.id) || a.tauntLeft > 0) return true;
    // First person: only what I'm looking straight at.
    a.face.head.getWorldPosition(_v).sub(fp.eye);
    const len = _v.length();
    return len > 0.01 && _v.dot(fp.forward) / len > 0.99;
  }

  private updateLabels(fp: FirstPersonView): void {
    if (this.layerDirty) {
      const r = this.labelLayer.getBoundingClientRect();
      this.layerLeft = r.left;
      this.layerTop = r.top;
      this.layerDirty = false;
    }
    let rect: DOMRect | null = null;
    const cam = this.stage.camera;
    let camReady = false;
    for (const a of this.list) {
      const l = a.label;
      const hot = a.id === this.hover || a.id === this.highlighted;
      l.flag("ks-char-label--hot", hot);
      l.flag("ks-char-label--target", this.targetable.has(a.id));
      l.flag("ks-char-label--bubbleonly", this.labelsHidden);
      if (!this.wantLabel(a, fp)) {
        l.show(false);
        continue;
      }
      if (a.id === this.myId && this.fpInside) {
        // My own speech bubble, up and to the right in front of me.
        const fx = Math.sin(a.yaw);
        const fz = Math.cos(a.yaw);
        _v.set(fp.eye.x + fx * 1.2 - fz * 0.35, fp.eye.y + 0.32, fp.eye.z + fz * 1.2 + fx * 0.35);
      } else {
        a.face.hatMount.getWorldPosition(_v);
        _v.y += 0.36;
      }
      if (!camReady) {
        cam.updateMatrixWorld();
        rect = this.sx.canvasRect ? this.sx.canvasRect() : this.stage.canvas.getBoundingClientRect();
        camReady = true;
      }
      _v.project(cam);
      if (_v.z < -1 || _v.z > 1 || Math.abs(_v.x) > 1.05 || Math.abs(_v.y) > 1.05 || !rect) {
        l.show(false);
        continue;
      }
      l.place(rect.left - this.layerLeft + ((_v.x + 1) / 2) * rect.width, rect.top - this.layerTop + ((1 - _v.y) / 2) * rect.height);
      l.show(true);
    }
  }
}
