// Card visuals painted onto a built piece (PieceView.card): Jelly Mode (translucent green jelly + bubbles,
// soft wobble), Butter Fingers (butter pats + greasy sparkles), Glue Gun (white glue blobs and drips),
// Heavy Snack (a "3 KG" weight tag on a string). Chonk is plain scale, handled by the owner.

import * as THREE from "three";
import { toonRamp } from "../toon";
import { G, M, blob, cachedMat, canvasTex, detail, mesh, softMat, sparkleMat, sprite, type PieceRig } from "./kit";

const box = new THREE.Box3();
const size = new THREE.Vector3();
const center = new THREE.Vector3();

function jellyMat(): THREE.MeshToonMaterial {
  return cachedMat("jellyMode", () =>
    new THREE.MeshToonMaterial({ color: "#5EE07A", emissive: "#0E4A1A", gradientMap: toonRamp(), transparent: true, opacity: 0.62, depthWrite: true }));
}

function weightTagMat(): THREE.SpriteMaterial {
  return cachedMat("weightTag", () => {
    const tex = canvasTex("weightTag", 128, 72, (ctx) => {
      // A kettlebell-ish weight with "3 KG" stamped on it.
      ctx.fillStyle = "#2D2A32";
      ctx.beginPath();
      ctx.arc(64, 14, 12, Math.PI, 0);
      ctx.lineWidth = 7;
      ctx.strokeStyle = "#2D2A32";
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(18, 22);
      ctx.lineTo(110, 22);
      ctx.lineTo(122, 68);
      ctx.lineTo(6, 68);
      ctx.closePath();
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(22, 27);
      ctx.lineTo(106, 27);
      ctx.lineTo(115, 63);
      ctx.lineTo(13, 63);
      ctx.closePath();
      ctx.fillStyle = "#FFC23F";
      ctx.fill();
      ctx.fillStyle = "#2D2A32";
      ctx.font = "bold 30px Arial Black, Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("3 KG", 64, 47);
    });
    return new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false });
  });
}

/** Apply the card look; call after outlines were added. */
export function applyCard(r: PieceRig, card: string): void {
  if (!card) return;
  r.root.updateMatrixWorld(true);
  box.setFromObject(r.body);
  if (box.isEmpty()) return;
  box.getSize(size);
  box.getCenter(center);
  const top = box.max.y;
  switch (card) {
    case "jellyMode": {
      const jm = jellyMat();
      r.body.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        if (m.name === "outline") {
          // Outline shells of swapped meshes vanish (the jelly is see-through).
          if (!(m.parent?.userData.face)) m.visible = false;
          return;
        }
        if (m.userData.face) return;
        m.material = jm;
        m.castShadow = false;
      });
      // Bubbles suspended in the jelly.
      for (let i = 0; i < 4; i++) {
        const a = i * 2.4;
        blob(softMat("#FFFFFF", 0.7), r.body, [center.x + Math.cos(a) * size.x * 0.2, center.y + (i / 4 - 0.4) * size.y * 0.5, center.z + Math.sin(a) * size.z * 0.2], [0.006, 0.006, 0.006]);
      }
      r.jelly = true;
      break;
    }
    case "butterFingers": {
      const butter = M("#FFE27A");
      const n = size.x > 0.12 || size.z > 0.12 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const pat = mesh(G.rbox(0.028, 0.01, 0.022, 0.003), butter, r.body, center.x + (i - (n - 1) / 2) * size.x * 0.35, top + 0.004, center.z + (i ? 0.01 : -0.008));
        pat.rotation.y = 0.4 + i * 0.9;
        pat.userData.face = true;
      }
      // Greasy drips + sparkles of sheen.
      blob(softMat("#FFF4B0", 0.75), r.body, [box.max.x - 0.004, center.y + size.y * 0.15, center.z], [0.006, 0.014, 0.006]);
      blob(softMat("#FFF4B0", 0.75), r.body, [box.min.x + 0.004, center.y + size.y * 0.1, center.z - size.z * 0.2], [0.006, 0.012, 0.006]);
      const sparks = [
        sprite(sparkleMat("#FFF2A0"), r.body, 0.03, box.min.x + size.x * 0.2, top, box.max.z),
        sprite(sparkleMat("#FFF2A0"), r.body, 0.03, box.max.x, center.y, box.min.z + size.z * 0.3),
      ];
      r.anims.push((_rig, _dt, t) => {
        for (let i = 0; i < sparks.length; i++) sparks[i].scale.setScalar(0.004 + Math.max(0, Math.sin(t * 3.3 + i * 2.7)) * 0.03);
      });
      break;
    }
    case "glueGun": {
      const glue = M("#F8F8F0");
      for (let i = 0; i < 3; i++) {
        const a = i * 2.1 + 0.4;
        blob(glue, r.body, [center.x + Math.cos(a) * size.x * 0.25, top - 0.002, center.z + Math.sin(a) * size.z * 0.25], [0.014, 0.005, 0.012], true);
      }
      // Drips hanging down the sides (they slowly stretch).
      const drips: THREE.Object3D[] = [];
      const spots: [number, number][] = [[box.max.x - 0.002, center.z], [center.x, box.max.z - 0.002], [box.min.x + 0.002, center.z + size.z * 0.2], [center.x - size.x * 0.25, box.min.z + 0.002]];
      for (const [x, z] of spots) {
        const holder = new THREE.Group();
        holder.position.set(x, top - Math.min(0.01, size.y * 0.25), z);
        r.body.add(holder);
        const d = detail(G.capsule(0.004, 0.016, 6), glue, holder, 0, -0.008, 0);
        detail(G.sphere(0.006, 8, 6), glue, d, 0, -0.01, 0);
        drips.push(holder);
      }
      r.anims.push((rig, _dt, t) => {
        for (let i = 0; i < drips.length; i++) drips[i].scale.y = 0.9 + 0.35 * (0.5 + 0.5 * Math.sin(t * 0.9 + i * 1.3 + rig.seed * 5));
      });
      break;
    }
    case "heavySnack": {
      const tagX = box.max.x + 0.03;
      const tagY = center.y + 0.005;
      const string = detail(G.cyl(0.0012, 0.0012, 1, 4), M("#2D2A32"), r.body);
      const from = new THREE.Vector3(box.max.x - 0.005, top - 0.004, center.z);
      const to = new THREE.Vector3(tagX, tagY + 0.02, center.z);
      string.position.copy(from).add(to).multiplyScalar(0.5);
      string.scale.y = from.distanceTo(to);
      string.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), to.clone().sub(from).normalize());
      const tag = sprite(weightTagMat(), r.body, 0.05, tagX, tagY, center.z);
      tag.scale.set(0.075, 0.042, 1);
      r.anims.push((rig, _dt, t) => {
        tag.position.y = tagY + Math.sin(t * 2.2 + rig.seed * 4) * 0.003;
      });
      break;
    }
    default:
      break;
  }
}
