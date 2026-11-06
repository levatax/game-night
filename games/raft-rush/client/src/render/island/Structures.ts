// Player-placed structures from WorldFrame.structures (game4.md §7/§13): fence (posts + pointed stakes; stakes
// break as hp drops), planted torch (flame shrinking with its burn, a pool light and the light-ring edge at
// night), water collector (leaf funnel + bucket whose water level follows `uses`), kraken tentacle (thrashing
// while `life` runs, sinking at the end), hut (A-frame thatch) and canoe (dugout + paddle). Created / updated /
// removed by id with a pop-in and a shrink-out. Per-kind geometries are baked once per island. Owner:
// client-render.

import * as THREE from "three";
import { COLLECTOR_USES, FENCE_HP, FENCE_LENGTH, KRAKEN_TICKS, PALETTE, TORCH_BURN_TICKS, TORCH_LIGHT_RADIUS } from "../../../../shared/constants";
import type { Heightfield } from "../../../../shared/island/types";
import type { StructureKind, StructureView } from "../../../../shared/types";
import { Baker, composeMatrix, doubleSided } from "../kit/Baker";
import type { MaterialBank } from "../kit/MaterialBank";
import { smoothing, wobble } from "../noise";
import { thatchTexture, WOOD } from "../textures";
import { addOutline, createToonMaterial, getOutlineMaterial, getSmoothOutlineGeometry, glowMaterial, toonColor, vertexColorToon } from "../Toon";
import type { LightRequest } from "./Campfire";
import { LightRing } from "./LightRing";

const POP_SEC = 0.35;
const REMOVE_SEC = 0.3;
const KRAKEN_SEGMENTS = 7;

interface Placed {
  id: string;
  kind: StructureKind;
  group: THREE.Group;
  /** 0 → 1 pop-in, then 1; counts down after removal. */
  appear: number;
  removing: boolean;
  seen: boolean;
  hp: number;
  /** Fence: the stake mesh whose geometry swaps with hp. */
  body?: THREE.Mesh;
  bodyOutline?: THREE.Mesh;
  /** Torch. */
  flames?: THREE.Object3D[];
  light?: LightRequest;
  ring?: LightRing;
  /** Collector water disc. */
  water?: THREE.Mesh;
  /** Kraken segments. */
  segments?: THREE.Object3D[];
  life: number;
  uses: number;
  phase: number;
}

export class Structures {
  readonly group = new THREE.Group();
  private readonly placed = new Map<string, Placed>();
  private readonly fenceGeos: THREE.BufferGeometry[] = [];
  private readonly geos = new Map<string, THREE.BufferGeometry>();
  private readonly lightList: LightRequest[] = [];

  constructor(
    private readonly grid: Heightfield,
    private readonly bank: MaterialBank,
  ) {
    this.group.name = "structures";
    for (let hp = 0; hp <= FENCE_HP; hp++) this.fenceGeos.push(bank.geo(fenceBaker(hp).build()));
    this.geos.set("torch", bank.geo(torchBaker().build()));
    this.geos.set("collector", bank.geo(collectorBaker().build()));
    this.geos.set("krakenSeg", bank.geo(krakenSegment().build()));
    this.geos.set("krakenBase", bank.geo(krakenBase().build()));
    this.geos.set("hut", bank.geo(hutFrame().build()));
    this.geos.set("canoe", bank.geo(canoeBaker().build()));
    const roof = new THREE.PlaneGeometry(3.4, 2.6);
    this.geos.set("hutRoof", bank.geo(roof));
    const flame = new THREE.ConeGeometry(0.11, 0.34, 6, 1, true);
    flame.translate(0, 0.17, 0);
    this.geos.set("flame", bank.geo(flame));
    const disc = new THREE.CircleGeometry(0.27, 10);
    disc.rotateX(-Math.PI / 2);
    this.geos.set("water", bank.geo(disc));
  }

  /** Planted torches' lights this frame (the Renderer's pool takes them after the campfires). */
  lights(): ReadonlyArray<LightRequest> {
    return this.lightList;
  }

  update(dt: number, elapsed: number, list: Iterable<StructureView>, dark: number): void {
    for (const p of this.placed.values()) p.seen = false;
    for (const s of list) {
      let p = this.placed.get(s.id);
      if (!p || p.kind !== s.kind) {
        if (p) this.drop(p);
        p = this.create(s);
        this.placed.set(s.id, p);
      }
      p.seen = true;
      p.removing = false;
      this.sync(p, s);
    }
    this.lightList.length = 0;
    for (const p of [...this.placed.values()]) {
      if (!p.seen && !p.removing) p.removing = true;
      p.appear = p.removing ? p.appear - dt / REMOVE_SEC : Math.min(1, p.appear + dt / POP_SEC);
      if (p.removing && p.appear <= 0) {
        this.drop(p);
        this.placed.delete(p.id);
        continue;
      }
      const k = p.removing ? Math.max(0.01, p.appear) : easeOutBack(p.appear);
      p.group.scale.setScalar(Math.max(0.01, k));
      this.animate(p, elapsed, dt, dark);
    }
  }

  /* ------------------------------------------------------------------ build */

  private create(s: StructureView): Placed {
    const group = new THREE.Group();
    group.name = `structure-${s.kind}`;
    const p: Placed = { id: s.id, kind: s.kind, group, appear: 0, removing: false, seen: true, hp: -1, life: s.life, uses: s.uses, phase: hashId(s.id) };
    const add = (geo: THREE.BufferGeometry, outline = true): THREE.Mesh => {
      const mesh = new THREE.Mesh(geo, vertexColorToon());
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      group.add(mesh);
      if (outline) addOutline(mesh, 0.022);
      return mesh;
    };
    switch (s.kind) {
      case "fence": {
        const mesh = new THREE.Mesh(this.fenceGeos[FENCE_HP]!, vertexColorToon());
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        const outline = new THREE.Mesh(getSmoothOutlineGeometry(this.fenceGeos[FENCE_HP]!), getOutlineMaterial(0.022));
        outline.name = "outline";
        outline.userData.isOutline = true;
        mesh.add(outline);
        group.add(mesh);
        p.body = mesh;
        p.bodyOutline = outline;
        break;
      }
      case "torch": {
        add(this.geos.get("torch")!);
        p.flames = this.addFlames(group, new THREE.Vector3(0, 1.32, 0), 1);
        p.light = { pos: new THREE.Vector3(), color: new THREE.Color(PALETTE.fire), intensity: 0, radius: TORCH_LIGHT_RADIUS, priority: 2 };
        p.ring = new LightRing(this.grid, s.x, s.z, TORCH_LIGHT_RADIUS, PALETTE.fire, this.bank);
        this.group.add(p.ring.mesh);
        break;
      }
      case "collector": {
        add(this.geos.get("collector")!);
        const water = new THREE.Mesh(this.geos.get("water")!, toonColor("#6FB4BE", { emissive: "#A9D8DC", emissiveIntensity: 0.15 }));
        water.position.y = 0.12;
        group.add(water);
        p.water = water;
        break;
      }
      case "kraken": {
        add(this.geos.get("krakenBase")!, false);
        const segs: THREE.Object3D[] = [];
        let parent: THREE.Object3D = group;
        for (let i = 0; i < KRAKEN_SEGMENTS; i++) {
          const seg = new THREE.Mesh(this.geos.get("krakenSeg")!, vertexColorToon());
          const k = 1 - i * 0.11;
          seg.scale.setScalar(k);
          seg.position.y = i === 0 ? 0.1 : 0.42;
          seg.castShadow = true;
          addOutline(seg, 0.02);
          parent.add(seg);
          segs.push(seg);
          parent = seg;
        }
        p.segments = segs;
        break;
      }
      case "hut": {
        add(this.geos.get("hut")!);
        const mat = this.bank.own(createToonMaterial(0xffffff, { map: thatchTexture(), side: THREE.DoubleSide }));
        for (const side of [-1, 1]) {
          // Slopes from the ridge (y 2.75, along X) down to the eaves at z = ±1.5.
          const roof = new THREE.Mesh(this.geos.get("hutRoof")!, mat);
          roof.position.set(0, 1.98, side * 0.75);
          roof.rotation.x = -side * 0.765;
          roof.castShadow = true;
          roof.receiveShadow = true;
          group.add(roof);
        }
        break;
      }
      case "canoe":
        add(this.geos.get("canoe")!);
        break;
    }
    this.group.add(group);
    return p;
  }

  private addFlames(group: THREE.Group, at: THREE.Vector3, scale: number): THREE.Object3D[] {
    const flames: THREE.Object3D[] = [];
    const colors = ["#FF6A2B", PALETTE.fire, "#FFF1A8"];
    colors.forEach((c, i) => {
      const m = new THREE.Mesh(this.geos.get("flame")!, glowMaterial(new THREE.Color(c).multiplyScalar(1.6), 0.9));
      m.position.copy(at);
      m.scale.setScalar(scale * (1 - i * 0.25));
      m.renderOrder = 4;
      group.add(m);
      flames.push(m);
    });
    return flames;
  }

  private sync(p: Placed, s: StructureView): void {
    p.group.position.set(s.x, s.y, s.z);
    p.group.rotation.y = s.yaw;
    p.life = s.life;
    p.uses = s.uses;
    if (p.kind === "fence" && s.hp !== p.hp && p.body && p.bodyOutline) {
      const hp = Math.max(0, Math.min(FENCE_HP, Math.round(s.hp)));
      p.body.geometry = this.fenceGeos[hp]!;
      p.bodyOutline.geometry = getSmoothOutlineGeometry(this.fenceGeos[hp]!);
    }
    p.hp = s.hp;
  }

  private animate(p: Placed, elapsed: number, dt: number, dark: number): void {
    if (p.kind === "torch" && p.flames && p.light && p.ring) {
      const burn = p.life > 0 ? Math.min(1, p.life / TORCH_BURN_TICKS) : 1;
      const dying = burn < 0.15 ? 0.5 + 0.5 * Math.max(0, wobble(elapsed * 8, p.phase)) : 1;
      const size = (0.55 + 0.45 * burn) * dying * Math.max(0, p.appear);
      p.flames.forEach((f, i) => {
        const fl = 1 + wobble(elapsed * 10 + i, p.phase + i) * 0.15;
        f.scale.set(size * (1 - i * 0.25), size * fl * (1 - i * 0.2), size * (1 - i * 0.25));
        f.rotation.y = elapsed * (1 + i);
      });
      p.group.updateMatrixWorld();
      p.light.pos.set(0, 1.55, 0).applyMatrix4(p.group.matrixWorld);
      p.light.intensity = (p.removing ? 0 : 1) * size * (1 + wobble(elapsed * 9, p.phase) * 0.1);
      p.ring.setOpacity(size * smoothstep(0.35, 0.8, dark) * 0.28);
      this.lightList.push(p.light);
      return;
    }
    if (p.kind === "collector" && p.water) {
      const level = Math.max(0, Math.min(1, p.uses / COLLECTOR_USES));
      p.water.visible = level > 0.01;
      p.water.position.y += (0.1 + level * 0.42 - p.water.position.y) * smoothing(4, dt);
      return;
    }
    if (p.kind === "kraken" && p.segments) {
      const left = p.life > 0 ? Math.min(1, p.life / KRAKEN_TICKS) : 1;
      const fury = left > 0.1 ? 1 : left / 0.1;
      p.segments.forEach((seg, i) => {
        const t = elapsed * 4.2 + p.phase;
        seg.rotation.z = Math.sin(t - i * 0.6) * 0.32 * fury;
        seg.rotation.x = Math.cos(t * 0.8 - i * 0.5) * 0.22 * fury;
      });
      // Sink back into the sand at the end.
      p.segments[0]!.position.y = 0.1 - (1 - fury) * 2.2;
      return;
    }
  }

  private drop(p: Placed): void {
    p.group.removeFromParent();
    if (p.ring) p.ring.mesh.removeFromParent();
  }
}

function hashId(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return ((h >>> 0) % 1000) / 159;
}

function easeOutBack(t: number): number {
  const c = 1.70158;
  const u = Math.min(1, Math.max(0, t)) - 1;
  return 1 + (c + 1) * u * u * u + c * u * u;
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

/* ================================================================ bakers */

/** Fence along local X (FENCE_LENGTH), 3 posts, 2 rails, 5 pointed stakes; `hp` < max breaks stakes. */
function fenceBaker(hp: number): Baker {
  const b = new Baker();
  const half = FENCE_LENGTH / 2;
  for (let k = -1; k <= 1; k++) {
    b.addAt(new THREE.CylinderGeometry(0.09, 0.11, 1.25, 6), WOOD.dark, new THREE.Vector3((k * FENCE_LENGTH) / 3, 0.55, 0), null, 1, true);
  }
  for (const y of [0.42, 0.85]) {
    b.addAt(new THREE.BoxGeometry(FENCE_LENGTH, 0.08, 0.07), WOOD.mid, new THREE.Vector3(0, y, 0.09), null, 1, true);
  }
  const stakes = 5;
  const broken = Math.max(0, Math.round(((FENCE_HP - hp) / FENCE_HP) * stakes));
  for (let i = 0; i < stakes; i++) {
    const x = -half + 0.22 + (i / (stakes - 1)) * (FENCE_LENGTH - 0.44);
    // Break from alternating ends inward so damage reads everywhere.
    const order = [0, 4, 2, 1, 3][i]!;
    const isBroken = order < broken;
    const h = isBroken ? 0.45 : 1.05 + ((i * 37) % 10) / 60;
    const tilt = isBroken ? (i % 2 ? 0.5 : -0.4) : ((i * 13) % 5) * 0.02 - 0.04;
    const m = composeMatrix(new THREE.Vector3(x, h / 2, -0.05), new THREE.Euler(isBroken ? 0.3 : 0, 0, tilt), 1);
    b.add(new THREE.CylinderGeometry(0.06, 0.07, h, 5), WOOD.light, m, true);
    if (!isBroken) b.add(new THREE.ConeGeometry(0.06, 0.18, 5).translate(0, h / 2 + 0.09, 0), WOOD.light, m, true);
  }
  return b;
}

function torchBaker(): Baker {
  const b = new Baker();
  b.addAt(new THREE.CylinderGeometry(0.035, 0.05, 1.3, 5), WOOD.mid, new THREE.Vector3(0, 0.65, 0), null, 1, true);
  b.addAt(new THREE.CylinderGeometry(0.08, 0.06, 0.2, 6), "#C9A15A", new THREE.Vector3(0, 1.25, 0), null, 1, true);
  b.addAt(new THREE.CylinderGeometry(0.075, 0.075, 0.05, 6), "#3E2C22", new THREE.Vector3(0, 1.36, 0), null, 1, true);
  return b;
}

function collectorBaker(): Baker {
  const b = new Baker();
  // Bucket (open top: a ring wall and a bottom).
  b.addAt(doubleSided(new THREE.CylinderGeometry(0.3, 0.26, 0.6, 10, 1, true)), WOOD.mid, new THREE.Vector3(0, 0.3, 0), null, 1, true);
  b.addAt(new THREE.CylinderGeometry(0.26, 0.26, 0.04, 10), WOOD.dark, new THREE.Vector3(0, 0.03, 0), null, 1, true);
  for (const y of [0.12, 0.48]) b.addAt(new THREE.TorusGeometry(0.29, 0.022, 3, 12), "#5A5E66", new THREE.Vector3(0, y, 0), new THREE.Euler(Math.PI / 2, 0, 0), 1, true);
  // Leaf funnel on three sticks.
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    b.addAt(new THREE.CylinderGeometry(0.02, 0.025, 1.3, 4), WOOD.dark, new THREE.Vector3(Math.cos(a) * 0.36, 0.65, Math.sin(a) * 0.36), new THREE.Euler(Math.sin(a) * 0.12, 0, -Math.cos(a) * 0.12), 1, true);
  }
  b.addAt(doubleSided(new THREE.ConeGeometry(0.75, 0.4, 7, 1, true)), "#5D7A45", new THREE.Vector3(0, 1.15, 0), new THREE.Euler(Math.PI, 0, 0), 1, true);
  return b;
}

function krakenBase(): Baker {
  const b = new Baker();
  b.addAt(new THREE.CylinderGeometry(0.55, 0.7, 0.14, 9), "#A88F68", new THREE.Vector3(0, 0.05, 0), null, 1, true);
  return b;
}

/** One tentacle segment (0.45 m): purple with pale suckers on one side, origin at its base. */
function krakenSegment(): Baker {
  const b = new Baker();
  b.addAt(new THREE.CylinderGeometry(0.17, 0.22, 0.48, 7), "#8E4FB8", new THREE.Vector3(0, 0.24, 0), null, 1, true);
  for (const y of [0.12, 0.32]) b.addAt(new THREE.CylinderGeometry(0.06, 0.06, 0.04, 6), "#F2C6E8", new THREE.Vector3(0, y, 0.2), new THREE.Euler(Math.PI / 2, 0, 0), 1, true);
  return b;
}

function hutFrame(): Baker {
  const b = new Baker();
  b.addAt(new THREE.BoxGeometry(3.4, 0.14, 2.8), WOOD.dark, new THREE.Vector3(0, 0.07, 0), null, 1, true);
  for (const x of [-1.5, 1.5]) for (const z of [-1.2, 1.2]) b.addAt(new THREE.CylinderGeometry(0.08, 0.1, 2.2, 6), WOOD.mid, new THREE.Vector3(x, 1.1, z), null, 1, true);
  b.addAt(new THREE.CylinderGeometry(0.07, 0.07, 3.6, 6), WOOD.mid, new THREE.Vector3(0, 2.75, 0), new THREE.Euler(0, 0, Math.PI / 2), 1, true);
  // Back wall of woven sticks.
  b.addAt(new THREE.BoxGeometry(3.0, 1.6, 0.08), WOOD.light, new THREE.Vector3(0, 0.95, 1.22), null, 1, true);
  return b;
}

function canoeBaker(): Baker {
  const b = new Baker();
  // Dugout: half a stretched cylinder, open top, with pointy ends.
  b.addAt(doubleSided(new THREE.CylinderGeometry(0.42, 0.42, 3.2, 10, 1, true, Math.PI / 2, Math.PI)), WOOD.mid, new THREE.Vector3(0, 0.42, 0), new THREE.Euler(Math.PI / 2, 0, 0), new THREE.Vector3(1, 1, 0.7), true);
  // Rounded, upswept bow and stern.
  for (const z of [-1.6, 1.6]) {
    b.addAt(new THREE.SphereGeometry(0.42, 8, 4, 0, Math.PI * 2, Math.PI / 2, Math.PI / 2), WOOD.mid, new THREE.Vector3(0, 0.42, z), null, new THREE.Vector3(1, 0.7, 0.9), true);
    b.addAt(new THREE.ConeGeometry(0.08, 0.35, 5), WOOD.dark, new THREE.Vector3(0, 0.5, z * 1.2), new THREE.Euler(Math.sign(z) * 1.2, 0, 0), 1, true);
  }
  b.addAt(new THREE.BoxGeometry(0.7, 0.06, 0.25), WOOD.light, new THREE.Vector3(0, 0.36, 0.4), null, 1, true);
  // Paddle across it.
  b.addAt(new THREE.CylinderGeometry(0.025, 0.025, 1.6, 5), WOOD.light, new THREE.Vector3(0.1, 0.5, -0.4), new THREE.Euler(Math.PI / 2, 0.5, 0), 1, true);
  b.addAt(new THREE.BoxGeometry(0.18, 0.03, 0.4), WOOD.light, new THREE.Vector3(0.45, 0.5, -1.05), new THREE.Euler(0, 0.5, 0), 1, true);
  return b;
}
