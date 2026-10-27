import * as THREE from "three";
import { raDecDistanceToXyz, degreesToRad } from "./utils.js";

const ANDROMEDA_RA_DEG = 10.68458;
const ANDROMEDA_DEC_DEG = 41.26917;

const ANDROMEDA_DISTANCE_LY = 2537000.0;

const ANDROMEDA_INCLINATION_DEG = 77.0;
const ANDROMEDA_POSITION_ANGLE_DEG = 35.0;
const ANDROMEDA_NEAR_SIDE_SIGN = -1;

const DISK_OUTER_RADIUS_LY = 50000.0;
const DISK_SCALE_LENGTH_LY = 16000.0; // radial exponential falloff — stylized, not real-disk-accurate
const DISK_SCALE_HEIGHT_LY = 500.0; // vertical falloff — smaller = flatter edge-on band
const ARM_COUNT = 2.0;
const ARM_PITCH_RAD = 0.14;
const ARM_SHARPNESS = 1.3;
const ARM_REFERENCE_RADIUS_LY = 12000.0;
const ARM_STRENGTH = 1.6;
const ARM_START_RADIUS_LY = 10000.0;
const SPUR_STRENGTH = 0.9;
const BAR_LENGTH_LY = 6000.0;
const BAR_WIDTH_LY = 1500.0;
const BAR_STRENGTH = 3.0;
const BAR_COLOR = 0xffe0a0;
const BULGE_FLATTEN = 0.55; // z-axis squash relative to the disk plane
const BULGE_SCALE_LY = 2000.0; // gaussian sigma, not a hard edge
const BULGE_STRENGTH = 1.3;
const BULGE_BRIGHTNESS = 2.8;
const CORE_SCALE_LY = 600.0;
const CORE_STRENGTH = 20.0;
const CORE_BRIGHTNESS = 8.0;
const NOISE_FREQ = 0.00035;
const NOISE_AMOUNT = 0.35;
const DISK_COLOR = 0xbba36a;
const ARM_COLOR = 0xc9c1ab;
const BULGE_COLOR = 0xffffff;
const CORE_COLOR = 0xffffff;
const FILL_INNER_RADIUS_LY = 4000.0; // where the fade-in starts (kept outside the core/bulge)
const FILL_INNER_FEATHER_LY = 6000.0; // fade-in reaches full strength at FILL_INNER_RADIUS_LY + this
const FILL_SCALE_LENGTH_LY = 30000.0; // radial exponential falloff — smaller = fades sooner moving outward
const FILL_OUTER_FEATHER_LY = 8000.0; // fade-out starts this far inside DISK_OUTER_RADIUS_LY
const FILL_SCALE_HEIGHT_LY = 800.0; // vertical falloff — puffier than the thin arm disk
const FILL_STRENGTH = 0.6; // medium emission, relative to the other components
const FILL_COLOR = 0xa8b2bf; // light grey
const FILL_BRIGHTNESS = 2.0;

const DENSITY_MULTIPLIER = 0.0005;
const GALAXY_OPACITY = 0.5; // master brightness dimmer — final alpha *= this, shape/balance untouched
const RAYMARCH_STEPS = 20; // perf/quality knob — dense regions (bulge/core) exit early via the alpha>0.95 break anyway

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
uniform float uFillInnerRadius;
uniform float uFillInnerFeather;
uniform float uFillScaleLength;
uniform float uFillOuterRadius;
uniform float uFillOuterFeather;
uniform float uFillScaleHeight;
uniform float uFillStrength;
uniform float uNoiseFreq;
uniform float uNoiseAmount;
uniform vec3  uDiskColor;
uniform vec3  uArmColor;
uniform vec3  uBarColor;
uniform vec3  uBulgeColor;
uniform vec3  uCoreColor;
uniform vec3  uFillColor;
uniform float uDensity;
uniform float uOpacity;

#define STEPS ${RAYMARCH_STEPS}

float andHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float andNoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  vec3 u = f * f * (3.0 - 2.0 * f);
  float v000 = andHash(i),                 v100 = andHash(i + vec3(1.,0.,0.));
  float v010 = andHash(i + vec3(0.,1.,0.)), v110 = andHash(i + vec3(1.,1.,0.));
  float v001 = andHash(i + vec3(0.,0.,1.)), v101 = andHash(i + vec3(1.,0.,1.));
  float v011 = andHash(i + vec3(0.,1.,1.)), v111 = andHash(i + vec3(1.,1.,1.));
  return mix(mix(mix(v000, v100, u.x), mix(v010, v110, u.x), u.y),
             mix(mix(v001, v101, u.x), mix(v011, v111, u.x), u.y), u.z);
}
float andFbm(vec3 p) {
  return andNoise(p) * 0.5 + andNoise(p * 2.0) * 0.25 + andNoise(p * 4.0) * 0.125;
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

  float n = andFbm(p * uNoiseFreq);

  float diskRadial = exp(-rCyl / uScaleLength);
  float diskVertical = exp(-abs(h) / uDiskScaleHeight);
  float theta = atan(p.y, p.x);
  float armRadius = max(rCyl, uArmStartRadius);
  float phase = theta - (1.0 / tan(uArmPitch)) * log(armRadius / uArmScale);
  float spiralCos = 0.5 + 0.5 * cos(uArmCount * phase);
  float spiral = pow(spiralCos, uArmSharpness);

  float jitter = andNoise(vec3(rCyl * 0.00008, theta * 1.5, 7.3)) * 2.0 - 1.0;
  float spurPhase = phase + jitter * 2.0;
  float spurCos = 0.5 + 0.5 * cos((uArmCount * 2.0) * spurPhase);
  float spur = spurCos * spurCos * spurCos;
  float spurPatch = smoothstep(0.35, 0.85, andNoise(p * uNoiseFreq * 2.3 + 11.0));
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

  float fillInner = smoothstep(uFillInnerRadius, uFillInnerRadius + uFillInnerFeather, rCyl);
  float fillOuter = 1.0 - smoothstep(uFillOuterRadius - uFillOuterFeather, uFillOuterRadius, rCyl);
  float fillRadial = exp(-rCyl / uFillScaleLength);
  float fillVertical = exp(-abs(h) / uFillScaleHeight);
  float fill = uFillStrength * fillInner * fillOuter * fillRadial * fillVertical;

  float noiseMul = mix(1.0 - uNoiseAmount, 1.0 + uNoiseAmount, n);

  float total = (disk + bar + bulge + core + fill) * noiseMul;
  if (total < 0.0001) return vec4(0.0);

  float weightSum = max(disk + bar + bulge + core + fill, 0.0001);
  vec3 diskColor = mix(uDiskColor, uArmColor, clamp(arms * armMask, 0.0, 1.0));
  vec3 color = (diskColor * disk + uBarColor * bar + uBulgeColor * bulge + uCoreColor * core + uFillColor * fill) / weightSum;

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
    if (alpha > 0.95) break;
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
      uWorldToLocal: { value: new THREE.Matrix4() },
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
      uFillInnerRadius: { value: FILL_INNER_RADIUS_LY },
      uFillInnerFeather: { value: FILL_INNER_FEATHER_LY },
      uFillScaleLength: { value: FILL_SCALE_LENGTH_LY },
      uFillOuterRadius: { value: DISK_OUTER_RADIUS_LY },
      uFillOuterFeather: { value: FILL_OUTER_FEATHER_LY },
      uFillScaleHeight: { value: FILL_SCALE_HEIGHT_LY },
      uFillStrength: { value: FILL_STRENGTH },
      uNoiseFreq: { value: NOISE_FREQ },
      uNoiseAmount: { value: NOISE_AMOUNT },
      uDiskColor: { value: new THREE.Color(DISK_COLOR) },
      uArmColor: { value: new THREE.Color(ARM_COLOR) },
      uBarColor: { value: new THREE.Color(BAR_COLOR) },
      uBulgeColor: { value: new THREE.Color(BULGE_COLOR).multiplyScalar(BULGE_BRIGHTNESS) },
      uCoreColor: { value: new THREE.Color(CORE_COLOR).multiplyScalar(CORE_BRIGHTNESS) },
      uFillColor: { value: new THREE.Color(FILL_COLOR).multiplyScalar(FILL_BRIGHTNESS) },
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

function lineOfSightUnit(raDeg, decDeg) {
  const p = raDecDistanceToXyz(raDeg, decDeg, 1);
  return new THREE.Vector3(p.x, p.y, p.z);
}

function computeDiskOrientation(raDeg, decDeg, positionAngleDeg, inclinationDeg, nearSideSign) {
  const losDir = lineOfSightUnit(raDeg, decDeg);
  const worldNorthPole = new THREE.Vector3(0, 1, 0);
  const east = new THREE.Vector3().crossVectors(worldNorthPole, losDir).normalize();
  const north = new THREE.Vector3().crossVectors(losDir, east).normalize();

  const pa = degreesToRad(positionAngleDeg);
  const majorAxisDir = north.clone().multiplyScalar(Math.cos(pa))
    .addScaledVector(east, Math.sin(pa))
    .normalize();
  const minorAxisDir = north.clone().multiplyScalar(-Math.sin(pa))
    .addScaledVector(east, Math.cos(pa))
    .normalize();

  const inc = degreesToRad(inclinationDeg);
  const pole = losDir.clone().multiplyScalar(Math.cos(inc))
    .addScaledVector(minorAxisDir, Math.sin(inc) * nearSideSign)
    .normalize();

  const xAxis = majorAxisDir;
  const zAxis = pole;
  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();

  const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  return new THREE.Quaternion().setFromRotationMatrix(basis);
}

export function buildAndromedaGroup() {
  const group = new THREE.Group();
  group.name = "andromeda";

  const mesh = buildGalaxyVolume();
  mesh.name = "Andromeda";
  mesh.text = "Spiral galaxy, Andromeda (M31).";
  group.add(mesh);
  group.userData.hoverTarget = mesh;

  const center = raDecDistanceToXyz(ANDROMEDA_RA_DEG, ANDROMEDA_DEC_DEG, ANDROMEDA_DISTANCE_LY);
  group.quaternion.copy(
    computeDiskOrientation(
      ANDROMEDA_RA_DEG,
      ANDROMEDA_DEC_DEG,
      ANDROMEDA_POSITION_ANGLE_DEG,
      ANDROMEDA_INCLINATION_DEG,
      ANDROMEDA_NEAR_SIDE_SIGN,
    ),
  );
  group.position.set(center.x, center.y, center.z);

  group.updateMatrixWorld(true);
  mesh.material.uniforms.uWorldToLocal.value.copy(mesh.matrixWorld).invert();

  return group;
}
