import * as THREE from 'three';

let nebulaMesh = null;

const VERT = `
varying vec3 vLocalPos;
void main() {
  vLocalPos = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = `
precision highp float;
uniform vec3  uCamLocal;
uniform float uDensity;
uniform float uBrightness;
uniform float uBlueIntensity;
uniform float uYellowIntensity;
uniform float uNoise;
uniform float uSquish;
uniform float uRagged;
uniform float uRaggedInner;
uniform float uRaggedMid;
uniform float uOrangeIntensity;
uniform vec3  uAxis;
uniform vec3  uAxisInner;
varying vec3 vLocalPos;
#define STEPS 80
#define BOX_R 0.80

float nbHash(vec3 p) {
  p = fract(p * vec3(0.1031, 0.1030, 0.0973));
  p += dot(p, p.yxz + 33.33);
  return fract((p.x + p.y) * p.z);
}
float nbNoise(vec3 p) {
  vec3 i = floor(p); vec3 f = fract(p);
  vec3 u = f*f*(3.0-2.0*f);
  float v000=nbHash(i),           v100=nbHash(i+vec3(1.,0.,0.));
  float v010=nbHash(i+vec3(0.,1.,0.)), v110=nbHash(i+vec3(1.,1.,0.));
  float v001=nbHash(i+vec3(0.,0.,1.)), v101=nbHash(i+vec3(1.,0.,1.));
  float v011=nbHash(i+vec3(0.,1.,1.)), v111=nbHash(i+vec3(1.,1.,1.));
  return mix(mix(mix(v000,v100,u.x),mix(v010,v110,u.x),u.y),
             mix(mix(v001,v101,u.x),mix(v011,v111,u.x),u.y), u.z);
}
float nbFbm(vec3 p) {
  return nbNoise(p)*0.500 + nbNoise(p*2.0)*0.250 + nbNoise(p*4.0)*0.125;
}

bool rayBox(vec3 o, vec3 d, out float t0, out float t1) {
  vec3 inv = 1.0 / d;
  vec3 ta = (-BOX_R - o) * inv;
  vec3 tb = ( BOX_R - o) * inv;
  vec3 tl = min(ta, tb);
  vec3 th = max(ta, tb);
  t0 = max(max(tl.x, tl.y), tl.z);
  t1 = min(min(th.x, th.y), th.z);
  return t1 >= max(t0, 0.0);
}

vec4 nbSample(vec3 p) {
  float nbN  = mix(1.0, max(0.0, nbFbm(p * 8.0) * 2.286), uNoise);
  vec3  axN  = normalize(uAxis);
  float axC  = dot(p, axN);
  float rEll = length(p + axN  * (axC  * (1.0/uSquish - 1.0)));
  vec3  axN2  = normalize(uAxisInner);
  float axC2  = dot(p, axN2);
  float squishI = min(1.0, uSquish * 1.2);
  float rEll2 = length(p + axN2 * (axC2 * (1.0/squishI - 1.0)));
  float warpI  = (nbFbm(p * 4.0) * 2.286 - 1.0) * uRaggedInner * 0.06;
  float rEll2I = rEll2 + warpI;
  float d1 = rEll2I - 0.105;
  float d2 = rEll2I - 0.168;
  float d3 = rEll2I - 0.238;
  float warpM = (nbFbm(p * 3.0) * 2.286 - 1.0) * uRaggedMid * 0.09;
  float dMid = length(p) + warpM - 0.136;
  float warp  = (nbFbm(p * 2.5) * 2.286 - 1.0) * uRagged * 0.12;
  float rEllO = rEll + warp;
  float d4 = rEllO - 0.44;
  float d5 = rEllO - 0.56;
  float rho1 = exp(-d1*d1 * 1200.0) * 0.7 * uBlueIntensity   * nbN;
  float rho2 = exp(-d2*d2 * 600.0)  * 1.8 * uBlueIntensity   * nbN;
  float rho3 = exp(-d3*d3 * 380.0)  * 1.2 * uYellowIntensity  * nbN;
  float rhoM = exp(-dMid*dMid * 180.0) * 1.0 * uOrangeIntensity * nbN;
  float rho4 = exp(-d4*d4 * 100.0)  * 1.4 * uYellowIntensity  * nbN;
  float rho5 = exp(-d5*d5 *  55.0)  * 0.6                    * nbN;
  vec3 c1 = vec3(0.10, 0.15, 1.00);
  vec3 c2 = vec3(0.05, 0.60, 0.95);
  vec3 c3 = vec3(0.90, 0.70, 0.20);
  vec3 cM = vec3(0.98, 0.80, 0.05);
  vec3 c4 = vec3(0.92, 0.32, 0.08);
  vec3 c5 = vec3(0.70, 0.12, 0.04);
  float rho = rho1 + rho2 + rho3 + rhoM + rho4 + rho5;
  if (rho < 0.001) return vec4(0.0);
  vec3 col = (rho1*c1 + rho2*c2 + rho3*c3 + rhoM*cM + rho4*c4 + rho5*c5) / rho;
  return vec4(col, rho);
}

void main() {
  vec3 ro = uCamLocal;
  vec3 rd = normalize(vLocalPos - uCamLocal);
  float t0, t1;
  if (!rayBox(ro, rd, t0, t1)) discard;
  t0 = max(t0, 0.001);
  float stepLen = (t1 - t0) / float(STEPS);
  vec3  color = vec3(0.0);
  float alpha = 0.0;
  for (int i = 0; i < STEPS; i++) {
    vec3 pos = ro + rd * (t0 + (float(i) + 0.5) * stepLen);
    vec4 s = nbSample(pos);
    float d = s.a * stepLen * uDensity;
    color += (1.0 - alpha) * s.rgb * uBrightness * d;
    alpha += (1.0 - alpha) * d;
    if (alpha > 0.98) break;
  }
  if (alpha < 0.003) discard;
  gl_FragColor = vec4(color, alpha);
}`;

export function createNebula(scene, starPositions) {
  const star = starPositions.find(function(s) { return s.name === 'NGC 7293'; });
  if (!star) return;

  const sunToStar = star.position.clone().normalize();
  const up = new THREE.Vector3(0, 1, 0);
  const dt = up.dot(sunToStar);
  const perpAxis = new THREE.Vector3(
    up.x - dt * sunToStar.x,
    up.y - dt * sunToStar.y,
    up.z - dt * sunToStar.z
  ).normalize();
  perpAxis.applyQuaternion(
    new THREE.Quaternion().setFromAxisAngle(sunToStar, -Math.PI / 12)
  );
  const innerAxis = new THREE.Vector3().crossVectors(perpAxis, sunToStar).normalize();

  const mat = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uCamLocal:        { value: new THREE.Vector3() },
      uDensity:         { value: 0.5 },
      uBrightness:      { value: 0.5 },
      uBlueIntensity:   { value: 24.0 },
      uYellowIntensity: { value: 3.0 },
      uNoise:           { value: 1.0 },
      uSquish:          { value: 0.5 },
      uRagged:          { value: 3.0 },
      uRaggedInner:     { value: 2.0 },
      uRaggedMid:       { value: 2.5 },
      uOrangeIntensity: { value: 12.0 },
      uAxis:            { value: perpAxis },
      uAxisInner:       { value: innerAxis },
    },
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    side: THREE.BackSide,
  });

  nebulaMesh = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 1.6), mat);
  nebulaMesh.position.copy(star.position);
  scene.add(nebulaMesh);
}

export function updateNebula(camera) {
  if (nebulaMesh) {
    nebulaMesh.material.uniforms.uCamLocal.value
      .copy(camera.position).sub(nebulaMesh.position);
  }
}
