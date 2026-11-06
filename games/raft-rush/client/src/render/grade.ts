// The global color grade (calm, naturalistic tropical look; not neon) without an extra full-screen pass: two
// three.js shader-chunk patches installed once before anything compiles. Owner: client-render.
//
// 1. `CustomToneMapping` (renderer.toneMapping = THREE.CustomToneMapping): exposure, a mild global saturation trim
//    and a soft highlight shoulder (Khronos PBR Neutral's shoulder, starting earlier, without its black toe so
//    nights don't crush). Every built-in material runs it in its own `tonemapping_fragment` on the direct path
//    (low / medium tiers); on the post-FX path (high) OutputPass runs the same function over the whole frame.
//    Below the shoulder (linear < SHOULDER) the curve is just exposure × saturation, so ShaderMaterials that
//    skip `tonemapping_fragment` (sky dome, clouds, fog color, water, particles) differ from graded meshes only by
//    the small saturation trim. `toneMapped: false` materials (flames, glows, nameplates, markers) skip it on
//    the direct path and keep their full punch against the calmer world. On the post-FX path the depth-test-free
//    overlay (Toon.ts OVERLAY_LAYER: marker labels, nameplates) is drawn after OutputPass, so it stays ungraded
//    there too; depth-tested glows (flames, charge glows, light rings, arc preview) stay in the composer (they need
//    the scene depth and bloom) and get the curve, i.e. the 0.9 saturation trim and the shoulder above 0.68.
// 2. Toon shadow band tint: `getGradientIrradiance` (MeshToonMaterial only) gives the darkest ramp step a cool
//    blue tint that fades out toward the lit step, so shade reads as sky-lit instead of grey.

import * as THREE from "three";

/** renderer.toneMappingExposure (a uniform: retuning it never recompiles). */
export const GRADE_EXPOSURE = 1.0;
/** Global saturation (1 = untouched). Kept mild: the palette itself is muted (DayNight, kit colors). */
const SATURATION = 0.9;
/** Linear value where highlights start to roll off (Neutral uses 0.76). */
const SHOULDER = 0.68;
/** How much rolled-off highlights drift toward white (Neutral uses 0.15). */
const SHOULDER_DESAT = 0.2;
/** Multiplier on the toon ramp's darkest step (cool, sky-lit shade). */
const SHADOW_TINT = [0.86, 0.93, 1.06] as const;

const GRADE_GLSL = /* glsl */ `
vec3 CustomToneMapping( vec3 color ) {
	// Raft Rush grade (client/src/render/grade.ts).
	color *= toneMappingExposure;
	float luma = dot( color, vec3( 0.2126, 0.7152, 0.0722 ) );
	color = max( mix( vec3( luma ), color, ${SATURATION.toFixed(3)} ), 0.0 );
	float peak = max( color.r, max( color.g, color.b ) );
	if ( peak <= ${SHOULDER.toFixed(3)} ) return color;
	float d = 1.0 - ${SHOULDER.toFixed(3)};
	float newPeak = 1.0 - d * d / ( peak + d - ${SHOULDER.toFixed(3)} );
	color *= newPeak / peak;
	float g = 1.0 - 1.0 / ( ${SHOULDER_DESAT.toFixed(3)} * ( peak - newPeak ) + 1.0 );
	return mix( color, vec3( newPeak ), g );
}
`;

const CUSTOM_STUB = "vec3 CustomToneMapping( vec3 color ) { return color; }";
const GRADIENT_LOOKUP = "return vec3( texture2D( gradientMap, coord ).r );";
const GRADIENT_TINTED = /* glsl */ `float rampStep = texture2D( gradientMap, coord ).r;
		// Cool shade on the darkest ramp step (client/src/render/grade.ts).
		return vec3( rampStep ) * mix( vec3( ${SHADOW_TINT.map((v) => v.toFixed(3)).join(", ")} ), vec3( 1.0 ), smoothstep( 0.4, 0.75, rampStep ) );`;

let installed: boolean | null = null;

/**
 * Patch three's shader chunks (idempotent; call before the first compile: Renderer's constructor and the toon
 * ramp both do). Returns false when this three build's chunks don't match (then the caller falls back to
 * NeutralToneMapping and the toon ramp stays untinted).
 */
export function installGrade(): boolean {
  if (installed !== null) return installed;
  const chunks = THREE.ShaderChunk as unknown as Record<string, string>;
  const tone = chunks.tonemapping_pars_fragment ?? "";
  const ramp = chunks.gradientmap_pars_fragment ?? "";
  const toneOk = tone.includes(CUSTOM_STUB);
  if (toneOk) chunks.tonemapping_pars_fragment = tone.replace(CUSTOM_STUB, GRADE_GLSL);
  if (ramp.includes(GRADIENT_LOOKUP)) chunks.gradientmap_pars_fragment = ramp.replace(GRADIENT_LOOKUP, GRADIENT_TINTED);
  if (!toneOk) console.warn("[render] color grade chunk not found; using NeutralToneMapping");
  installed = toneOk;
  return installed;
}

/** The tone mapping the renderer should use (after installGrade()). */
export function gradeToneMapping(): THREE.ToneMapping {
  return installGrade() ? THREE.CustomToneMapping : THREE.NeutralToneMapping;
}
