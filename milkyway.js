import * as THREE from "three";
import { raDecDistanceToXyz } from "./utils.js";

const GALACTIC_CENTER_RA_DEG = 266.4051;
const GALACTIC_CENTER_DEC_DEG = -28.936175;
const GALACTIC_CENTER_DISTANCE_LY = 26996; // matches index.html's showGalaxyCenter()
const NORTH_GALACTIC_POLE_RA_DEG = 192.85948;
const NORTH_GALACTIC_POLE_DEC_DEG = 27.12825;

const DISK_OUTER_RADIUS_LY = 50000.0; // matches index.html's controls.maxDistance
const DISK_SCALE_LENGTH_LY = 16000.0; // radial exponential falloff — stylized, not real-disk-accurate
const DISK_SCALE_HEIGHT_LY = 1400.0; // vertical falloff
const ARM_COUNT = 2.0;
const ARM_PITCH_RAD = 0.14;
const ARM_SHARPNESS = 1.3; // was an implicit 2.0 (spiralCos*spiralCos)
const ARM_REFERENCE_RADIUS_LY = 12000.0;
const ARM_STRENGTH = 1.6;
const ARM_START_RADIUS_LY = 10000.0;
const SPUR_STRENGTH = 0.9;
const BAR_LENGTH_LY = 6000.0; // half-length, along local +X (a stylized reference axis — the real bar sits at ~25deg to the Sun-center line, not reproduced here)
const BAR_WIDTH_LY = 1500.0; // half-width
const BAR_STRENGTH = 1.1;
const BAR_COLOR = 0xffe0a0;
const BULGE_FLATTEN = 0.55; // z-axis squash relative to the disk plane
const BULGE_SCALE_LY = 5000.0; // gaussian sigma, not a hard edge
const BULGE_STRENGTH = 1.3;
const CORE_SCALE_LY = 400.0; // tight, bright pinpoint at the very center
const CORE_STRENGTH = 4.0;
const NOISE_FREQ = 0.00035; // ~1/(2900ly) — clumpy dust-lane-ish texture scale
const NOISE_AMOUNT = 0.35;
const DISK_COLOR = 0xbba36a; // diffuse disk — older, yellower population
const ARM_COLOR = 0xaaccff; // spiral arms — young, bluer population
const BULGE_COLOR = 0xffcc88;
const CORE_COLOR = 0xfff3d6;
const DENSITY_MULTIPLIER = 0.0005;
const GALAXY_OPACITY = 0.95;
const RAYMARCH_STEPS = 64;

const VERT = `
varying vec3 vLocalPos;
void main() {
  vLocalPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const GALAXY_FRAG = `
precision highp float;
varying vec3 vLocalPos;
uniform mat4 uWorldToLocal;
uniform vec3 uBoxHalf;
uniform float uScaleLength;
uniform float uDiskScaleHeight;
uniform float uArmCount;
uniform float uArmPitch;
uniform float uArmScale;
uniform float uArmStrength;
uniform float uArmSharpness;
uniform float uArmStartRadius;
uniform float uSpurStrength;
uniform float uBarLength;
uniform float uBarWidth;
uniform float uBarStrength;
uniform float uBulgeFlatten;
uniform float uBulgeScale;
uniform float uBulgeStrength;
uniform float uCoreScale;
uniform float uCoreStrength;
uniform float uNoiseFreq;
uniform float uNoiseAmount;
uniform vec3  uDiskColor;
uniform vec3  uArmColor;
uniform vec3  uBarColor;
uniform vec3  uBulgeColor;
uniform vec3  uCoreColor;
uniform float uDensity;
uniform float uOpacity;

#define STEPS ${RAYMARCH_STEPS}

float mwHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float mwNoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float v000 = mwHash(i),                 v100 = mwHash(i + vec3(1.,0.,0.));
  float v010 = mwHash(i + vec3(0.,1.,0.)), v110 = mwHash(i + vec3(1.,1.,0.));
  float v001 = mwHash(i + vec3(0.,0.,1.)), v101 = mwHash(i + vec3(1.,0.,1.));
  float v011 = mwHash(i + vec3(0.,1.,1.)), v111 = mwHash(i + vec3(1.,1.,1.));
  return mix(mix(mix(v000, v100, u.x), mix(v010, v110, u.x), u.y),
             mix(mix(v001, v101, u.x), mix(v011, v111, u.x), u.y), u.z);
}
float mwFbm(vec3 p) {
  return mwNoise(p) * 0.5 + mwNoise(p * 2.0) * 0.25 + mwNoise(p * 4.0) * 0.125;
}

bool rayBox(vec3 o, vec3 d, out float t0, out float t1) {
  vec3 dSign = step(vec3(0.0), d) * 2.0 - 1.0;
  vec3 dSafe = dSign * max(abs(d), 1e-6);
  vec3 inv = 1.0 / dSafe;
  vec3 ta = (-uBoxHalf - o) * inv;
  vec3 tb = ( uBoxHalf - o) * inv;
  vec3 tl = min(ta, tb);
  vec3 th = max(ta, tb);
  t0 = max(max(tl.x, tl.y), tl.z);
  t1 = min(min(th.x, th.y), th.z);
  return t1 >= max(t0, 0.0);
}

vec4 sampleGalaxy(vec3 p) {
  float rCyl = length(p.xy);
  float h = p.z;

  float n = mwFbm(p * uNoiseFreq);

  float diskRadial = exp(-rCyl / uScaleLength);
  float diskVertical = exp(-abs(h) / uDiskScaleHeight);
  float theta = atan(p.y, p.x);
  float armRadius = max(rCyl, uArmStartRadius);
  float phase = theta - (1.0 / tan(uArmPitch)) * log(armRadius / uArmScale);
  float spiralCos = 0.5 + 0.5 * cos(uArmCount * phase);
  float spiral = pow(spiralCos, uArmSharpness);

  float jitter = mwNoise(vec3(rCyl * 0.00008, theta * 1.5, 7.3)) * 2.0 - 1.0;
  float spurPhase = phase + jitter * 2.0;
  float spurCos = 0.5 + 0.5 * cos((uArmCount * 2.0) * spurPhase);
  float spur = spurCos * spurCos * spurCos;
  float spurPatch = smoothstep(0.35, 0.85, mwNoise(p * uNoiseFreq * 2.3 + 11.0));
  float arms = spiral + uSpurStrength * spur * spurPatch;

  float armMask = smoothstep(uArmStartRadius * 0.4, uArmStartRadius, rCyl);
  float disk = diskRadial * diskVertical * (0.25 + uArmStrength * arms * armMask);

  float barT = abs(p.x) / uBarLength;
  float barT2 = barT * barT;
  float barProfile = exp(-(barT2 * barT2)) * exp(-(p.y * p.y) / (2.0 * uBarWidth * uBarWidth));
  float bar = uBarStrength * barProfile * exp(-abs(h) / (uDiskScaleHeight * 1.3));

  vec3 pb = vec3(p.xy, p.z / uBulgeFlatten);
  float rb2 = dot(pb, pb);
  float bulge = uBulgeStrength * exp(-rb2 / (2.0 * uBulgeScale * uBulgeScale));
  float core  = uCoreStrength  * exp(-rb2 / (2.0 * uCoreScale  * uCoreScale));

  float noiseMul = mix(1.0 - uNoiseAmount, 1.0 + uNoiseAmount, n);

  float total = (disk + bar + bulge + core) * noiseMul;
  if (total < 0.0001) return vec4(0.0);

  float weightSum = max(disk + bar + bulge + core, 0.0001);
  vec3 diskColor = mix(uDiskColor, uArmColor, clamp(arms * armMask, 0.0, 1.0));
  vec3 color = (diskColor * disk + uBarColor * bar + uBulgeColor * bulge + uCoreColor * core) / weightSum;

  return vec4(color, total);
}

void main() {
  vec3 ro = (uWorldToLocal * vec4(cameraPosition, 1.0)).xyz;
  vec3 rd = normalize(vLocalPos - ro);

  float t0, t1;
  if (!rayBox(ro, rd, t0, t1)) discard;
  t0 = max(t0, 0.0);
  float stepLen = (t1 - t0) / float(STEPS);

  vec3 color = vec3(0.0);
  float alpha = 0.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 p = ro + rd * (t0 + (float(i) + 0.5) * stepLen);
    vec4 s = sampleGalaxy(p);
    float d = clamp(s.a * stepLen * uDensity, 0.0, 1.0);
    color += (1.0 - alpha) * s.rgb * d;
    alpha += (1.0 - alpha) * d;
    if (alpha > 0.98) break;
  }
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(color, alpha * uOpacity);
}`;

function buildGalaxyVolume() {
  const boxHalf = new THREE.Vector3(
    DISK_OUTER_RADIUS_LY * 1.05,
    DISK_OUTER_RADIUS_LY * 1.05,
    BULGE_SCALE_LY * 6.0,
  );
  const geometry = new THREE.BoxGeometry(boxHalf.x * 2, boxHalf.y * 2, boxHalf.z * 2);
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: GALAXY_FRAG,
    uniforms: {
      uWorldToLocal: { value: new THREE.Matrix4() }, // filled in once by buildMilkyWayGroup
      uBoxHalf: { value: boxHalf },
      uScaleLength: { value: DISK_SCALE_LENGTH_LY },
      uDiskScaleHeight: { value: DISK_SCALE_HEIGHT_LY },
      uArmCount: { value: ARM_COUNT },
      uArmPitch: { value: ARM_PITCH_RAD },
      uArmScale: { value: ARM_REFERENCE_RADIUS_LY },
      uArmStrength: { value: ARM_STRENGTH },
      uArmSharpness: { value: ARM_SHARPNESS },
      uArmStartRadius: { value: ARM_START_RADIUS_LY },
      uSpurStrength: { value: SPUR_STRENGTH },
      uBarLength: { value: BAR_LENGTH_LY },
      uBarWidth: { value: BAR_WIDTH_LY },
      uBarStrength: { value: BAR_STRENGTH },
      uBulgeFlatten: { value: BULGE_FLATTEN },
      uBulgeScale: { value: BULGE_SCALE_LY },
      uBulgeStrength: { value: BULGE_STRENGTH },
      uCoreScale: { value: CORE_SCALE_LY },
      uCoreStrength: { value: CORE_STRENGTH },
      uNoiseFreq: { value: NOISE_FREQ },
      uNoiseAmount: { value: NOISE_AMOUNT },
      uDiskColor: { value: new THREE.Color(DISK_COLOR) },
      uArmColor: { value: new THREE.Color(ARM_COLOR) },
      uBarColor: { value: new THREE.Color(BAR_COLOR) },
      uBulgeColor: { value: new THREE.Color(BULGE_COLOR) },
      uCoreColor: { value: new THREE.Color(CORE_COLOR) },
      uDensity: { value: DENSITY_MULTIPLIER },
      uOpacity: { value: GALAXY_OPACITY },
    },
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
  });
  return new THREE.Mesh(geometry, material);
}

export function buildMilkyWayGroup() {
  const group = new THREE.Group();
  group.name = "milkyWay";

  const mesh = buildGalaxyVolume();
  group.add(mesh);

  const center = raDecDistanceToXyz(GALACTIC_CENTER_RA_DEG, GALACTIC_CENTER_DEC_DEG, GALACTIC_CENTER_DISTANCE_LY);
  const pole = raDecDistanceToXyz(NORTH_GALACTIC_POLE_RA_DEG, NORTH_GALACTIC_POLE_DEC_DEG, 1);
  const poleUnit = new THREE.Vector3(pole.x, pole.y, pole.z).normalize();
  group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), poleUnit);
  group.position.set(center.x, center.y, center.z);

  group.updateMatrixWorld(true);
  mesh.material.uniforms.uWorldToLocal.value.copy(mesh.matrixWorld).invert();

  return group;
}
