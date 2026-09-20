/* KEMOSH — the seeing.
 *
 * Camera passthrough in stereo. Scan the empty room once, and from then on
 * anyone who walks into it is simply not rendered.
 *
 * How the erasing works, in one paragraph. The phone paints what it sees into a
 * panorama that is locked to the world, not to the screen, so turning your head
 * moves the view across a plate that stays put. Anything in the live frame that
 * disagrees with the plate is something that wasn't there when the room was
 * scanned — a person. Those pixels are drawn from the plate instead of the
 * camera, so the person is simply gone. A settings toggle can narrow that to
 * only what you happen to be looking at, but "wherever they stand" is the
 * default and the point of scanning in the first place.
 */
(function (global) {
  'use strict';

  var PANO_W = 1024, PANO_H = 512;
  var DEPTH_W = 512, DEPTH_H = 256;
  var MASK_W = 128, MASK_H = 72;
  var COV_W = 32, COV_H = 16;
  var SIM_W = 512, SIM_H = 288;

  var gl = null, canvas = null, quad = null;
  var prog = {};
  var tex = {};
  var fbo = {};
  var panoIdx = 0, maskIdx = 0;
  var camSource = null;          // HTMLVideoElement, or null in sim mode
  var simOn = false;
  var hasDepth = false;          // has anything actually measured the room?
  var maskBuf = new Uint8Array(MASK_W * MASK_H * 4);
  var covBuf = new Uint8Array(COV_W * COV_H * 4);

  /* ---------- small matrix helpers (column-major, like GL wants) ---------- */

  function mat3Mul(a, b) {
    var r = new Float32Array(9), c, row;
    for (c = 0; c < 3; c++) {
      for (row = 0; row < 3; row++) {
        r[c * 3 + row] = a[row] * b[c * 3] + a[3 + row] * b[c * 3 + 1] + a[6 + row] * b[c * 3 + 2];
      }
    }
    return r;
  }
  function mat3T(m) {
    return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
  }
  function mat3MulVec(m, v) {
    return [
      m[0] * v[0] + m[3] * v[1] + m[6] * v[2],
      m[1] * v[0] + m[4] * v[1] + m[7] * v[2],
      m[2] * v[0] + m[5] * v[1] + m[8] * v[2]
    ];
  }

  /* Rotation from the phone's own orientation report, plus the screen twist.
     Result maps screen space (x right, y up, z out of the screen) into the
     world (z up). The camera looks down screen -z. */
  function matFromDeviceOrientation(alpha, beta, gamma, screenAngle) {
    var d = Math.PI / 180;
    var x = beta * d, y = gamma * d, z = alpha * d;
    var cX = Math.cos(x), cY = Math.cos(y), cZ = Math.cos(z);
    var sX = Math.sin(x), sY = Math.sin(y), sZ = Math.sin(z);
    var m11 = cZ * cY - sZ * sX * sY, m12 = -cX * sZ, m13 = cY * sZ * sX + cZ * sY;
    var m21 = cY * sZ + cZ * sX * sY, m22 = cZ * cX, m23 = sZ * sY - cZ * cY * sX;
    var m31 = -cX * sY, m32 = sX, m33 = cX * cY;
    var M = new Float32Array([m11, m21, m31, m12, m22, m32, m13, m23, m33]);
    var a = -(screenAngle || 0) * d, ca = Math.cos(a), sa = Math.sin(a);
    var Rz = new Float32Array([ca, sa, 0, -sa, ca, 0, 0, 0, 1]);
    return mat3Mul(M, Rz);
  }

  /* Same thing for a mouse or a thumb, so it's usable without a phone. */
  function matFromYawPitch(yaw, pitch) {
    var cp = Math.cos(pitch), sp = Math.sin(pitch);
    var f = [cp * Math.cos(yaw), cp * Math.sin(yaw), sp];
    var r = [f[1] * 1 - f[2] * 0, f[2] * 0 - f[0] * 1, 0];
    var rl = Math.hypot(r[0], r[1], r[2]) || 1;
    r = [r[0] / rl, r[1] / rl, r[2] / rl];
    var u = [r[1] * f[2] - r[2] * f[1], r[2] * f[0] - r[0] * f[2], r[0] * f[1] - r[1] * f[0]];
    return new Float32Array([r[0], r[1], r[2], u[0], u[1], u[2], -f[0], -f[1], -f[2]]);
  }

  /* ---------- shaders ---------- */

  var VS = [
    '#version 300 es',
    'in vec2 aPos;',
    'out vec2 vUv;',
    'void main(){ vUv = aPos*0.5+0.5; gl_Position = vec4(aPos,0.0,1.0); }'
  ].join('\n');

  var LIB = [
    'const float PI = 3.14159265;',
    'const float TAU = 6.28318531;',
    'vec3 dirFromPano(vec2 uv){',
    '  float lon = (uv.x-0.5)*TAU, lat = (uv.y-0.5)*PI;',
    '  float c = cos(lat);',
    '  return vec3(c*cos(lon), c*sin(lon), sin(lat));',
    '}',
    'vec2 panoFromDir(vec3 d){',
    '  return vec2(atan(d.y,d.x)/TAU + 0.5, asin(clamp(d.z,-1.0,1.0))/PI + 0.5);',
    '}',
    'float hash21(vec2 p){',
    '  p = fract(p*vec2(123.34,456.21));',
    '  p += dot(p, p+45.32);',
    '  return fract(p.x*p.y);',
    '}'
  ].join('\n');

  /* Paint the live frame into the world-locked plate. Pixels the mask calls
     "person" are left alone, so nobody gets baked into the empty room. */
  var FS_PAINT = [
    '#version 300 es',
    'precision highp float;',
    LIB,
    'in vec2 vUv; out vec4 o;',
    'uniform sampler2D uPrev, uCam, uMask;',
    'uniform mat3 uRinv;',
    'uniform mat2 uCamM;',
    'uniform vec2 uMaskTan;',
    'uniform float uSlow, uFast;',
    'void main(){',
    '  vec4 prev = texture(uPrev, vUv);',
    '  o = prev;',
    '  vec3 ds = uRinv * dirFromPano(vUv);',
    '  if (ds.z > -0.05) return;',
    '  vec2 t = ds.xy / -ds.z;',
    '  vec2 ms = t / uMaskTan;',
    '  if (abs(ms.x) > 1.0 || abs(ms.y) > 1.0) return;',
    '  vec2 cuv = (uCamM * t) * 0.5 + 0.5;',
    '  if (cuv.x < 0.0 || cuv.x > 1.0 || cuv.y < 0.0 || cuv.y > 1.0) return;',
    '  vec3 c = texture(uCam, cuv).rgb;',
    '  float m = texture(uMask, ms*0.5+0.5).r;',
    '  float edge = 1.0 - smoothstep(0.78, 1.0, max(abs(ms.x), abs(ms.y)));',
    '  float rate = mix(uSlow, uFast, 1.0 - prev.a) * edge * (1.0 - m);',
    '  o.rgb = mix(prev.rgb, c, rate);',
    /* Confidence has to converge on exactly the same curve the colour does.
       Adding a fixed step per frame instead let alpha reach "certain" while the
       colour was still half way there — which showed up as the room building
       up darker than it finally settles. Read it as: how much of what is really
       there has made it into this texel. */
    '  o.a = 1.0 - (1.0 - prev.a) * (1.0 - rate);',
    '}'
  ].join('\n');

  /* Disagreement between the live frame and the plate. Written in camera space
     so blobs (people) can be read straight off it. */
  var FS_MASK = [
    '#version 300 es',
    'precision highp float;',
    LIB,
    'in vec2 vUv; out vec4 o;',
    'uniform sampler2D uCam, uPano, uPrev;',
    'uniform mat3 uR;',
    'uniform mat2 uCamM;',
    'uniform vec2 uMaskTan;',
    'uniform float uT0, uT1, uSmooth;',
    'void main(){',
    '  vec2 t = (vUv*2.0-1.0) * uMaskTan;',
    '  vec3 d = uR * normalize(vec3(t, -1.0));',
    '  vec4 b = texture(uPano, panoFromDir(d));',
    '  vec2 cuv = (uCamM * t) * 0.5 + 0.5;',
    '  vec3 c = texture(uCam, cuv).rgb;',
    '  float lc = dot(c, vec3(0.299,0.587,0.114));',
    '  float lb = dot(b.rgb, vec3(0.299,0.587,0.114));',
    /* Compare brightness and colour separately: a phone's auto-exposure shifts
       the whole frame, and colour survives that better than brightness does. */
    '  float dl = abs(lc-lb);',
    '  float dc = length((c-lc) - (b.rgb-lb));',
    '  float diff = max(dl*0.85, dc*1.7);',
    '  float m = smoothstep(uT0, uT1, diff);',
    /* Nothing can be called a person until the wall behind them is actually
       known. A plate only part of the way to the truth disagrees with the
       camera everywhere, and taking that for a person would stop the paint
       pass filling it in — the fill would stall half done, waiting on a plate
       that is waiting on the fill. */
    '  m *= smoothstep(0.55, 0.92, b.a);',
    '  bool inFrame = cuv.x > 0.001 && cuv.x < 0.999 && cuv.y > 0.001 && cuv.y < 0.999;',
    '  if (!inFrame) m = 0.0;',
    '  float prev = texture(uPrev, vUv).r;',
    '  o = vec4(mix(prev, m, uSmooth), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  /* Spread and firm up the mask so edges do not flicker. */
  var FS_CLEAN = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv; out vec4 o;',
    'uniform sampler2D uSrc;',
    'uniform vec2 uTexel;',
    'void main(){',
    '  float s = 0.0, mx = 0.0, n = 0.0;',
    '  for (int y=-3; y<=3; y++){',
    '    for (int x=-3; x<=3; x++){',
    '      float v = texture(uSrc, vUv + vec2(float(x),float(y))*uTexel).r;',
    '      mx = max(mx, v);',
    '      if (abs(float(x)) <= 2.0 && abs(float(y)) <= 2.0) { s += v; n += 1.0; }',
    '    }',
    '  }',
    '  float avg = s/n;',
    /* A lone bright pixel is noise; a bright pixel among bright neighbours is a
       body. Requiring both kills the speckle. The wider max then grows the
       result back past the silhouette's edge, so erasing covers the outline
       instead of leaving a person-shaped rim behind. */
    '  o = vec4(clamp(mx * smoothstep(0.06, 0.30, avg), 0.0, 1.0), 0.0, 0.0, 1.0);',
    '}'
  ].join('\n');

  var FS_COV = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 vUv; out vec4 o;',
    'uniform sampler2D uSrc;',
    'uniform vec2 uStep;',
    'void main(){',
    '  float s = 0.0;',
    '  for (int y=0; y<4; y++) for (int x=0; x<4; x++)',
    '    s += texture(uSrc, vUv + (vec2(float(x),float(y))-1.5)*uStep).a;',
    '  o = vec4(s/16.0);',
    '}'
  ].join('\n');

  /* The view itself: one draw per eye. */
  var FS_VIEW = [
    '#version 300 es',
    'precision highp float;',
    LIB,
    'in vec2 vUv; out vec4 o;',
    'uniform sampler2D uCam, uPano, uMask, uHud, uDepth;',
    'uniform float uHasDepth;',
    'uniform mat3 uR, uRinv;',
    'uniform mat2 uCamM;',
    'uniform vec2 uMaskTan, uEyeTan, uLens;',
    'uniform float uK1, uK2, uErase, uGazeIn, uGazeOut, uTime, uShake, uFade, uAlways;',
    'uniform float uReticle, uHudOn, uBlocks, uCell, uVig, uRelief, uReliefGrid;',
    /* Each tracked person: direction in xyz, their own erase radius in w. */
    'uniform vec4 uMarks[8];',
    'uniform int uMarkN;',

    /* ---------- the room, rebuilt out of cubes ----------
       Where the surface lies in a given direction is either measured or, if
       nothing has measured it, guessed. The guess is a box with the viewer in
       the middle of it: right for the walls, and the corners it produces — two
       walls and a floor meeting — keep it reading as a place rather than as
       wallpaper, but it cannot know a bed from the wall behind the bed.

       The measurement comes from a 3D scan, and is kept the same way: a
       distance per direction, in uDepth. That is all a room needs, because from
       one standing point nothing is behind anything else, and it is what turns
       the furniture into furniture.

       The saving grace of a headset is that the viewer only ever turns, never
       walks. So the whole block world is a function of direction alone, and a
       ray need not be marched from the eye: it can start just short of the
       surface and walk a handful of cells. That is what keeps this affordable
       on a phone, measured or guessed. */
    'const vec3 RMIN = vec3(-1.0,-1.0,-0.62);',
    'const vec3 RMAX = vec3( 1.0, 1.0, 0.42);',
    /* Distances are kept as a fraction of this, so one byte carries a room. */
    'const float DEPTH_MAX = 4.0;',

    /* A fixed shade per facing rather than a lamp somewhere. Indoors, a lamp
       leaves whole walls in the dark; a flat value per axis keeps every face
       readable and still tells the three directions apart at a glance, which is
       what makes a heap of cubes look like cubes. */
    'float faceShade(vec3 n){',
    '  if (n.z > 0.5) return 1.0;',
    '  if (n.z < -0.5) return 0.68;',
    '  return abs(n.x) > 0.5 ? 0.93 : 0.80;',
    '}',

    /* Fewer, flatter tones — but taken out of brightness alone, so a beige wall
       stays beige. Rounding the three channels separately drags near-greys off
       towards red or olive, which looked like a fault in the camera. */
    'vec3 blocky(vec3 c){',
    '  float l = max(dot(c, vec3(0.299,0.587,0.114)), 1e-3);',
    '  return c * (floor(l * 11.0 + 0.5) / 11.0) / l;',
    '}',

    /* How far the guessed box is, along d. */
    'float boxDist(vec3 d){',
    '  vec3 sd = max(abs(d), vec3(1e-5)) * (step(vec3(0.0), d)*2.0 - 1.0);',
    '  vec3 s = mix(RMIN, RMAX, step(vec3(0.0), d));',
    '  vec3 tv = s / sd;',
    '  return min(tv.x, min(tv.y, tv.z));',
    '}',

    /* How far the surface actually is, along d: what was measured where
       something was, the box everywhere else, and a blend across the join so a
       half-scanned edge does not come out as a cliff. */
    'float roomDist(vec3 d){',
    '  float box = boxDist(d);',
    '  if (uHasDepth < 0.5) return box;',
    '  vec4 m = texture(uDepth, panoFromDir(d));',
    '  return mix(box, m.r * DEPTH_MAX, smoothstep(0.12, 0.45, m.a));',
    '}',

    /* How many cells this column of the room stands proud of the flat wall.
       Whole numbers only — a smooth height would give a lumpy surface, and
       stacked cubes are the entire point. Unscanned columns stand at zero, so
       the room starts out a flat white box and gains its relief as it is
       learned. Counted in cells but set in real depth (uRelief cells' worth),
       so shrinking the cubes makes the relief finer rather than shallower. */
    'float cellPull(vec4 pl){',
    '  float a = smoothstep(0.05, 0.55, pl.a);',
    '  float l = dot(pl.rgb, vec3(0.299,0.587,0.114));',
    '  return floor(clamp((l - 0.16) * 2.0, 0.0, 1.0) * a * (uRelief + 0.999));',
    '}',

    'vec3 blockRoom(vec3 d){',
    '  float cs = uCell;',
    '  float wall = roomDist(d);',
    /* Start just in front of this direction's own surface, not in front of the
       deepest relief anywhere in the room. With small cubes the worst case is
       many cells back, and marching from there would spend a texture read per
       cell on every flat stretch of wall. Two cells of slack is enough to catch
       a taller neighbour standing in the way. Never nearer than part-way in
       either, so cell centres stay away from the origin where normalize() gives
       up. */
    '  float here = cellPull(texture(uPano, panoFromDir(d)));',
    '  float t0 = max(wall * 0.40, wall - (here + 3.0)*cs);',
    '  ivec3 c = ivec3(floor(d * t0 / cs));',
    '  bvec3 tiny = lessThan(abs(d), vec3(1e-5));',
    '  vec3 dsf = mix(d, vec3(1.0), vec3(tiny));',
    '  vec3 sgn = step(vec3(0.0), d)*2.0 - 1.0;',
    '  vec3 tMax = mix((vec3(c) + step(vec3(0.0), d)) * cs / dsf, vec3(1e9), vec3(tiny));',
    '  vec3 tDelta = mix(cs / abs(dsf), vec3(1e9), vec3(tiny));',
    '  bool found = false;',
    /* Walk the lattice. A cell is solid once it lies at or beyond the surface
       of the column it belongs to, so corners and the join between walls come
       out right without any special case.

       How far that column stands proud is read off a coarser lattice than the
       cubes themselves — uReliefGrid cubes to a step. Taking a height per cube
       instead let the grain of the wall, and the camera's own speckle, flip
       single cubes in and out, which came out as static rather than as a room.
       Coarse heights and fine cubes give terraces: the shape stays
       architectural while the surface stays detailed. */
    '  for (int i = 0; i < 10; i++) {',
    '    vec3 centre = (vec3(c) + 0.5) * cs;',
    '    float rd = roomDist(normalize(centre));',
    '    vec3 step3 = (floor(vec3(c) / uReliefGrid) + 0.5) * uReliefGrid * cs;',
    '    float pull = cellPull(texture(uPano, panoFromDir(normalize(step3))));',
    '    if (length(centre) >= max(rd - pull*cs, rd*0.4)) { found = true; break; }',
    '    if (tMax.x < tMax.y && tMax.x < tMax.z) { c.x += int(sgn.x); tMax.x += tDelta.x; }',
    '    else if (tMax.y < tMax.z) { c.y += int(sgn.y); tMax.y += tDelta.y; }',
    '    else { c.z += int(sgn.z); tMax.z += tDelta.z; }',
    '  }',
    /* Colour comes from the cube's own direction, at full detail. */
    '  vec4 pl = texture(uPano, panoFromDir(normalize((vec3(c) + 0.5) * cs)));',
    /* Which face of that cube the ray came in through — the flat shading this
       gives is most of what says "cube" to the eye. */
    '  vec3 cmin = vec3(c) * cs;',
    '  vec3 tin = min(cmin / dsf, (cmin + cs) / dsf);',
    '  vec3 n = vec3(0.0);',
    '  if (tin.x >= tin.y && tin.x >= tin.z) n.x = -sgn.x;',
    '  else if (tin.y >= tin.z) n.y = -sgn.y;',
    '  else n.z = -sgn.z;',
    '  vec3 hp = d * max(max(tin.x, max(tin.y, tin.z)), 1e-4);',
    '  vec3 e = min(fract(hp / cs), 1.0 - fract(hp / cs));',
    '  vec3 w = abs(n);',
    '  float ed = min(min(mix(e.x,1.0,w.x), mix(e.y,1.0,w.y)), mix(e.z,1.0,w.z));',
    '  float seam = smoothstep(0.0, 0.05, ed);',
    /* How much of this column is actually known yet. */
    '  float conf = smoothstep(0.03, 0.8, pl.a);',
    /* The colour needs no fade of its own: the plate starts white and walks to
       the truth. A gentle lift, because a room read back off a phone camera is
       dimmer than the room was and cube shading takes another bite out of it. */
    '  vec3 albedo = pow(blocky(pl.rgb), vec3(0.78));',
    /* Shading, seams and relief are the part that has to be held back — they
       would be inventing structure for a wall nothing is known about yet. */
    '  float lam = mix(1.0, faceShade(n), conf);',
    '  return albedo * lam * (1.0 - mix(0.04, 0.26, conf) * (1.0 - seam));',
    '}',

    'void main(){',
    '  vec2 p = (vUv*2.0-1.0) - uLens;',
    '  float r2 = dot(p,p);',
    /* Pre-shrink the frame so the Cardboard lens pulls it back to straight. */
    '  vec2 pd = p * (1.0 + uK1*r2 + uK2*r2*r2);',
    '  pd += vec2(sin(uTime*37.0), cos(uTime*31.0)) * uShake;',
    '  vec2 t = pd * uEyeTan;',
    '  vec3 ds = normalize(vec3(t, -1.0));',
    '  vec3 d = uR * ds;',
    '  float ang = length(t);',
    '  vec3 col;',
    '  if (uBlocks > 0.5) {',
    /* Nothing live is drawn at all here: the room comes from what was scanned,
       so anyone standing in it is absent by construction rather than by being
       painted over. */
    '    col = blockRoom(d);',
    '  } else {',
    '    vec4 plate = texture(uPano, panoFromDir(d));',
    '    vec2 cuv = (uCamM * t) * 0.5 + 0.5;',
    '    bool inCam = cuv.x > 0.0 && cuv.x < 1.0 && cuv.y > 0.0 && cuv.y < 1.0;',
    '    vec3 live = texture(uCam, cuv).rgb;',
    '    vec3 empty = mix(vec3(0.015,0.016,0.02), plate.rgb, plate.a);',
    '    vec3 base = inCam ? live : empty;',
    '    vec2 ms = (t / uMaskTan)*0.5+0.5;',
    '    float m = (ms.x>0.0&&ms.x<1.0&&ms.y>0.0&&ms.y<1.0) ? texture(uMask, ms).r : 0.0;',
    /* Firm the mask up: solid through the body, feathered only at the outline,
       or the silhouette survives as a dark outline of itself. */
    '    m = smoothstep(0.10, 0.45, m);',
    /* Where a tracked person's own silhouette reaches. Gate on the person's
       position, not this pixel's, or looking near someone punches a hole in
       them instead of taking the whole body. The reach is that person's own
       size, in uMarks[i].w, so someone standing beside them keeps their own
       fate rather than being taken along too. */
    '    float whole = 0.0;',
    '    for (int i=0; i<8; i++){',
    '      if (i >= uMarkN) break;',
    '      vec3 md = uRinv * uMarks[i].xyz;',
    '      if (md.z > -0.08) continue;',
    '      vec2 mt = md.xy / -md.z;',
    '      if (length(t - mt) < uMarks[i].w) {',
    '        whole = max(whole, 1.0 - smoothstep(uGazeOut*0.55, uGazeOut, length(mt)));',
    '      }',
    '    }',
    /* uAlways is the whole point of the scan: once the room is known, people are
       simply not drawn, wherever they stand. Dropped to zero it reverts to
       hiding only what you look at. Anything the tracker has not caught up with
       still fades where you stare, so the effect never waits on it. */
    '    float gaze = max(uAlways, max(whole, 1.0 - smoothstep(uGazeIn, uGazeOut, ang)));',
    '    float erase = clamp(m * gaze * uErase, 0.0, 1.0);',
    /* Dissolve rather than cut: a hard swap between two images reads as a glitch,
       a noisy wipe reads as something being taken away. */
    '    float nz = hash21(floor(cuv*vec2(220.0,124.0)) + floor(uTime*14.0)*7.13);',
    '    float e = clamp(erase*1.7 - nz*0.45 - 0.05, 0.0, 1.0);',
    '    e = smoothstep(0.0, 0.5, e);',
    '    col = mix(base, empty, e);',
    /* A rim where the dissolve is half-done sells the unmaking when you turn to
       face someone. When they are meant to be simply absent it would give their
       position away, so it drops to a whisper. */
    '    col += vec3(0.25,0.75,0.95) * e*(1.0-e) * mix(2.2, 0.3, uAlways) * m;',
    '  }',
    /* Centre mark: where looking becomes erasing, for the gaze-only mode. */
    '  float gr = smoothstep(0.005, 0.0, abs(ang - uGazeOut));',
    '  col += vec3(0.9,0.35,0.35) * gr * 0.16 * uReticle * (1.0 - uAlways);',
    '  float dot0 = smoothstep(0.010, 0.0, ang);',
    '  col += vec3(1.0) * dot0 * 0.55 * uReticle * (1.0 - uAlways);',
    /* The bar is placed in screen units, not world angles, so it stays on the
       glass whatever the camera's field of view turns out to be. */
    '  if (uHudOn > 0.5) {',
    '    vec2 h = (pd - vec2(0.0,-0.70)) / vec2(0.80,0.16);',
    '    if (abs(h.x) < 1.0 && abs(h.y) < 1.0) {',
    '      vec4 hud = texture(uHud, h*0.5+0.5);',
    '      col = mix(col, hud.rgb, hud.a);',
    '    }',
    '  }',
    /* The vignette is there to hide the rectangular edge of the screen behind a
       round lens. Without a headset there is no lens and nothing to hide, so it
       nearly goes away — it was turning a white room grey everywhere but the
       middle, which is the opposite of what an unscanned room should look
       like. */
    '  float vig = 1.0 - smoothstep(0.72, 1.32, length(p));',
    '  col *= mix(uVig, 1.0, vig);',
    '  o = vec4(col * uFade, 1.0);',
    '}'
  ].join('\n');

  /* A room made of arithmetic, for trying it without a camera. */
  var FS_SIM = [
    '#version 300 es',
    'precision highp float;',
    LIB,
    'in vec2 vUv; out vec4 o;',
    'uniform mat3 uR;',
    'uniform vec2 uMaskTan;',
    'uniform float uTime, uPhVis;',
    'uniform vec4 uPh[8];',
    'uniform int uPhN;',
    'vec3 room(vec3 d){',
    '  vec3 bmin = vec3(-3.0,-4.2,-1.2), bmax = vec3(3.0,4.2,1.7);',
    '  vec3 s = vec3(d.x>=0.0?bmax.x:bmin.x, d.y>=0.0?bmax.y:bmin.y, d.z>=0.0?bmax.z:bmin.z);',
    '  vec3 dd = max(abs(d), vec3(1e-4)) * (step(0.0, d)*2.0 - 1.0);',
    '  vec3 tv = s / dd;',
    '  float t = min(min(abs(tv.x), abs(tv.y)), abs(tv.z));',
    '  vec3 p = d*t;',
    '  vec3 c;',
    '  if (abs(tv.z) <= abs(tv.x) && abs(tv.z) <= abs(tv.y)) {',
    '    if (d.z < 0.0) {',
    '      vec2 g = fract(p.xy*1.1);',
    '      float line = smoothstep(0.045,0.0,min(min(g.x,g.y),min(1.0-g.x,1.0-g.y)));',
    '      c = mix(vec3(0.20,0.19,0.18), vec3(0.30,0.28,0.26), line);',
    '    } else {',
    '      float lamp = smoothstep(1.5, 0.35, length(p.xy - vec2(0.0,1.2)));',
    '      c = mix(vec3(0.46,0.46,0.48), vec3(0.95,0.93,0.86), lamp);',
    '    }',
    '  } else {',
    '    vec2 w = (abs(tv.x) < abs(tv.y)) ? vec2(p.y,p.z) : vec2(p.x,p.z);',
    '    float band = smoothstep(0.06,0.0,abs(w.y+0.15));',
    '    float stripe = 0.5+0.5*sin(w.x*5.4);',
    '    c = mix(vec3(0.40,0.36,0.31), vec3(0.47,0.43,0.37), stripe);',
    '    c = mix(c, vec3(0.24,0.22,0.20), band);',
    '    vec2 q = abs(vec2(mod(w.x+1.5,3.0)-1.5, w.y-0.45)) - vec2(0.42,0.30);',
    '    if (max(q.x,q.y) < 0.0) c = vec3(0.16,0.30,0.38) + 0.10*sin(w.x*11.0);',
    '  }',
    '  c *= 0.82 + 0.18*hash21(floor(p.xy*90.0)+floor(p.z*90.0));',
    '  return c;',
    '}',
    'float person(vec2 p, float s){',
    '  float d = length(p - vec2(0.0, s*0.78)) - s*0.20;',
    '  vec2 q = abs(p - vec2(0.0, s*0.14)) - vec2(s*0.17, s*0.35);',
    '  d = min(d, length(max(q,0.0)) + min(max(q.x,q.y),0.0) - s*0.10);',
    '  vec2 l = p - vec2(0.0, -s*0.56);',
    '  l.x = abs(l.x) - s*0.11;',
    '  vec2 r = abs(l) - vec2(s*0.05, s*0.30);',
    '  d = min(d, length(max(r,0.0)) + min(max(r.x,r.y),0.0) - s*0.05);',
    '  return d;',
    '}',
    'void main(){',
    '  vec2 t = (vUv*2.0-1.0) * uMaskTan;',
    '  vec3 d = uR * normalize(vec3(t, -1.0));',
    '  vec3 col = room(d);',
    '  if (uPhVis > 0.5) {',
    '    for (int i=0; i<8; i++){',
    '      if (i >= uPhN) break;',
    '      vec3 pd = uPh[i].xyz;',
    '      float align = dot(d, pd);',
    '      if (align < 0.90) continue;',
    '      vec3 up = normalize(vec3(0.0,0.0,1.0) - pd*pd.z);',
    '      vec3 rt = normalize(cross(up, pd));',
    '      vec3 rel = d - pd*align;',
    '      vec2 lp = vec2(dot(rel,rt), dot(rel,up));',
    '      float sd = person(lp, uPh[i].w);',
    '      float inside = 1.0 - smoothstep(-0.002, 0.004, sd);',
    '      vec3 body = vec3(0.14,0.15,0.19) + 0.09*vec3(hash21(vec2(float(i),1.0)), hash21(vec2(float(i),2.0)), hash21(vec2(float(i),3.0)));',
    '      col = mix(col, body, inside);',
    '    }',
    '  }',
    '  o = vec4(col, 1.0);',
    '}'
  ].join('\n');

  /* ---------- plumbing ---------- */

  function compile(src, type) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(s) + '\n' + src.split('\n').map(function (l, i) {
        return (i + 1) + ': ' + l;
      }).join('\n'));
    }
    return s;
  }

  function link(fs) {
    var p = gl.createProgram();
    gl.attachShader(p, compile(VS, gl.VERTEX_SHADER));
    gl.attachShader(p, compile(fs, gl.FRAGMENT_SHADER));
    gl.bindAttribLocation(p, 0, 'aPos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS), i, info;
    for (i = 0; i < n; i++) {
      info = gl.getActiveUniform(p, i);
      u[info.name.replace('[0]', '')] = gl.getUniformLocation(p, info.name);
    }
    return { p: p, u: u };
  }

  function makeTex(w, h, wrapX) {
    var t = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrapX ? gl.REPEAT : gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  function makeFbo(t) {
    var f = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    return f;
  }

  function bind(unit, t, loc) {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, t);
    if (loc) gl.uniform1i(loc, unit);
  }

  function draw() { gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4); }

  function target(f, w, h) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, f);
    gl.viewport(0, 0, w, h);
  }

  /* ---------- camera framing ----------
     Everything downstream works in tangent units: the (x,y) of a ray divided by
     its depth. These two build the maps from that space into the video frame and
     into the mask, which is the only fiddly part of wearing a phone sideways. */

  var camGeom = { tvx: 0.64, tvy: 0.36, rot: 0, maskTan: [0.64, 0.36], camM: new Float32Array([1, 0, 0, 1]) };

  function updateCamGeom(fovDeg, vw, vh, rot) {
    var tvx = Math.tan(fovDeg * Math.PI / 360);
    var tvy = tvx * (vh / Math.max(1, vw));
    camGeom.tvx = tvx; camGeom.tvy = tvy; camGeom.rot = rot;
    camGeom.maskTan = (rot === 90 || rot === 270) ? [tvy, tvx] : [tvx, tvy];
    var a = -rot * Math.PI / 180, ca = Math.cos(a), sa = Math.sin(a);
    /* rotate screen tangents into the video's own frame, then normalise by it */
    camGeom.camM = new Float32Array([ca / tvx, sa / tvy, -sa / tvx, ca / tvy]);
  }

  /* Fit the camera's field of view into one eye's viewport without letterboxing. */
  function eyeTan(vpW, vpH) {
    var mt = camGeom.maskTan, A = vpW / Math.max(1, vpH);
    return (A > mt[0] / mt[1]) ? [mt[0], mt[0] / A] : [mt[1] * A, mt[1]];
  }

  /* ---------- public ---------- */

  var VR = {
    MASK_W: MASK_W,
    MASK_H: MASK_H,
    mat3MulVec: mat3MulVec,
    mat3T: mat3T,
    matFromDeviceOrientation: matFromDeviceOrientation,
    matFromYawPitch: matFromYawPitch,

    init: function (cv) {
      canvas = cv;
      gl = cv.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false });
      if (!gl) return 'This phone’s browser doesn’t do WebGL2, which the view is built on.';
      try {
        prog.paint = link(FS_PAINT);
        prog.mask = link(FS_MASK);
        prog.clean = link(FS_CLEAN);
        prog.cov = link(FS_COV);
        prog.view = link(FS_VIEW);
        prog.sim = link(FS_SIM);
      } catch (e) {
        return 'The view failed to build: ' + e.message;
      }
      quad = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, quad);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      tex.pano = [makeTex(PANO_W, PANO_H, true), makeTex(PANO_W, PANO_H, true)];
      tex.mask = [makeTex(MASK_W, MASK_H), makeTex(MASK_W, MASK_H)];
      tex.maskC = makeTex(MASK_W, MASK_H);
      tex.cov = makeTex(COV_W, COV_H);
      tex.sim = makeTex(SIM_W, SIM_H);
      fbo.pano = [makeFbo(tex.pano[0]), makeFbo(tex.pano[1])];
      fbo.mask = [makeFbo(tex.mask[0]), makeFbo(tex.mask[1])];
      fbo.maskC = makeFbo(tex.maskC);
      fbo.cov = makeFbo(tex.cov);
      fbo.sim = makeFbo(tex.sim);

      tex.cam = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex.cam);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([20, 20, 24, 255]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      tex.hud = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex.hud);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 0]));
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

      /* Where the surface really is, one distance per direction, filled by a 3D
         scan. Wraps in longitude like the colour plate does. */
      tex.depth = makeTex(DEPTH_W, DEPTH_H, true);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);

      updateCamGeom(65, 16, 9, 0);
      this.forget();
      this.forgetDepth();
      return null;
    },

    DEPTH_W: DEPTH_W,
    DEPTH_H: DEPTH_H,
    /* One room unit is this many metres, so a scan in metres and a room drawn
       in units agree about how big a bed is. */
    DEPTH_UNIT: 3.2,
    DEPTH_MAX: 4.0,

    /* RGBA per direction: distance in r as a fraction of DEPTH_MAX, and how
       much it is believed in a. Nothing measured yet means nothing believed,
       and the drawing falls back to the guessed box. */
    uploadDepth: function (buf) {
      gl.bindTexture(gl.TEXTURE_2D, tex.depth);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, DEPTH_W, DEPTH_H, 0, gl.RGBA, gl.UNSIGNED_BYTE, buf);
      hasDepth = true;
    },

    forgetDepth: function () {
      gl.bindTexture(gl.TEXTURE_2D, tex.depth);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, DEPTH_W, DEPTH_H, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array(DEPTH_W * DEPTH_H * 4));
      hasDepth = false;
    },

    measured: function () { return hasDepth; },
    /* The scanner needs the same context, or its AR session and this renderer
       would be looking at two different GPUs' worth of state. */
    gl: function () { return gl; },

    useCamera: function (video, fovDeg, rot) {
      camSource = video; simOn = false;
      updateCamGeom(fovDeg, video.videoWidth || 1280, video.videoHeight || 720, rot || 0);
    },

    useSim: function (fovDeg) {
      camSource = null; simOn = true;
      updateCamGeom(fovDeg || 68, SIM_W, SIM_H, 0);
    },

    setFov: function (fovDeg, rot) {
      var vw = simOn ? SIM_W : (camSource && camSource.videoWidth) || 1280;
      var vh = simOn ? SIM_H : (camSource && camSource.videoHeight) || 720;
      updateCamGeom(fovDeg, vw, vh, simOn ? 0 : rot);
    },

    /* Throw the plate away — used before a fresh scan. Cleared to white with no
       confidence, so an unscanned direction is literally blank paper: the block
       view can hand the plate's own colour straight to the wall and get the
       white-to-room fade for free, on exactly the curve the plate converges. */
    forget: function () {
      var i;
      for (i = 0; i < 2; i++) {
        target(fbo.pano[i], PANO_W, PANO_H);
        gl.clearColor(1.0, 1.0, 1.0, 0.0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        target(fbo.mask[i], MASK_W, MASK_H);
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
      target(fbo.maskC, MASK_W, MASK_H);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      panoIdx = 0; maskIdx = 0;
    },

    uploadHud: function (cv) {
      gl.bindTexture(gl.TEXTURE_2D, tex.hud);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    },

    /* Draw the pretend room, standing in for the camera. */
    renderSim: function (R, time, people, visible) {
      var i, arr = new Float32Array(32), n = Math.min(8, people.length);
      for (i = 0; i < n; i++) {
        arr[i * 4] = people[i].dir[0];
        arr[i * 4 + 1] = people[i].dir[1];
        arr[i * 4 + 2] = people[i].dir[2];
        arr[i * 4 + 3] = people[i].size;
      }
      target(fbo.sim, SIM_W, SIM_H);
      gl.useProgram(prog.sim.p);
      gl.uniformMatrix3fv(prog.sim.u.uR, false, R);
      gl.uniform2fv(prog.sim.u.uMaskTan, camGeom.maskTan);
      gl.uniform1f(prog.sim.u.uTime, time);
      gl.uniform1f(prog.sim.u.uPhVis, visible ? 1 : 0);
      gl.uniform4fv(prog.sim.u.uPh, arr);
      gl.uniform1i(prog.sim.u.uPhN, n);
      draw();
    },

    /* One pass of: read the world, update the plate, work out who is there. */
    sense: function (R, opts) {
      var Rinv = mat3T(R), src;
      if (!simOn && camSource && camSource.readyState >= 2) {
        gl.bindTexture(gl.TEXTURE_2D, tex.cam);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, camSource);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      }
      src = simOn ? tex.sim : tex.cam;

      var next = 1 - maskIdx;
      target(fbo.mask[next], MASK_W, MASK_H);
      gl.useProgram(prog.mask.p);
      bind(0, src, prog.mask.u.uCam);
      bind(1, tex.pano[panoIdx], prog.mask.u.uPano);
      bind(2, tex.mask[maskIdx], prog.mask.u.uPrev);
      gl.uniformMatrix3fv(prog.mask.u.uR, false, R);
      gl.uniformMatrix2fv(prog.mask.u.uCamM, false, camGeom.camM);
      gl.uniform2fv(prog.mask.u.uMaskTan, camGeom.maskTan);
      gl.uniform1f(prog.mask.u.uT0, opts.t0);
      gl.uniform1f(prog.mask.u.uT1, opts.t1);
      gl.uniform1f(prog.mask.u.uSmooth, opts.smooth);
      draw();
      maskIdx = next;

      target(fbo.maskC, MASK_W, MASK_H);
      gl.useProgram(prog.clean.p);
      bind(0, tex.mask[maskIdx], prog.clean.u.uSrc);
      gl.uniform2f(prog.clean.u.uTexel, 1 / MASK_W, 1 / MASK_H);
      draw();

      /* Frozen: the room stands as it was scanned, so there is nothing to paint
         and the whole pass can be skipped. The mask still runs — it compares the
         camera against the plate, which is exactly as valid frozen as not. */
      if (opts.freeze) return;

      var pnext = 1 - panoIdx;
      target(fbo.pano[pnext], PANO_W, PANO_H);
      gl.useProgram(prog.paint.p);
      bind(0, tex.pano[panoIdx], prog.paint.u.uPrev);
      bind(1, src, prog.paint.u.uCam);
      bind(2, tex.maskC, prog.paint.u.uMask);
      gl.uniformMatrix3fv(prog.paint.u.uRinv, false, Rinv);
      gl.uniformMatrix2fv(prog.paint.u.uCamM, false, camGeom.camM);
      gl.uniform2fv(prog.paint.u.uMaskTan, camGeom.maskTan);
      gl.uniform1f(prog.paint.u.uSlow, opts.slow);
      gl.uniform1f(prog.paint.u.uFast, opts.fast);
      draw();
      panoIdx = pnext;
    },

    /* Put it on the screen. marks: [{dir:[x,y,z], charge:-1..1}] */
    present: function (R, o) {
      var Rinv = mat3T(R);
      var W = canvas.width, H = canvas.height;
      var eyes = o.stereo ? 2 : 1;
      var vpW = o.stereo ? Math.floor(W / 2) : W;
      var et = eyeTan(vpW, H);
      /* Callers need this: how far off centre a thing can be and still be on
         screen. In stereo each eye sees a narrow slice, and a rule written in
         degrees without knowing that ends up pointing outside the view. */
      this.lastEyeTan = et;
      /* Each mark is a tracked person: their world direction plus their own
         erase radius, packed as one vec4 (xyz dir, w radius) per person. */
      var arr = new Float32Array(32), i, n = Math.min(8, o.marks.length);
      for (i = 0; i < n; i++) {
        arr[i * 4] = o.marks[i].dir[0];
        arr[i * 4 + 1] = o.marks[i].dir[1];
        arr[i * 4 + 2] = o.marks[i].dir[2];
        arr[i * 4 + 3] = o.marks[i].r || 0.12;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(prog.view.p);
      bind(0, simOn ? tex.sim : tex.cam, prog.view.u.uCam);
      bind(1, tex.pano[panoIdx], prog.view.u.uPano);
      bind(2, tex.maskC, prog.view.u.uMask);
      bind(3, tex.hud, prog.view.u.uHud);
      bind(4, tex.depth, prog.view.u.uDepth);
      gl.uniform1f(prog.view.u.uHasDepth, hasDepth ? 1 : 0);
      gl.uniformMatrix3fv(prog.view.u.uR, false, R);
      gl.uniformMatrix3fv(prog.view.u.uRinv, false, Rinv);
      gl.uniformMatrix2fv(prog.view.u.uCamM, false, camGeom.camM);
      gl.uniform2fv(prog.view.u.uMaskTan, camGeom.maskTan);
      gl.uniform2f(prog.view.u.uEyeTan, et[0], et[1]);
      gl.uniform1f(prog.view.u.uK1, o.stereo ? o.k1 : 0);
      gl.uniform1f(prog.view.u.uK2, o.stereo ? o.k2 : 0);
      gl.uniform1f(prog.view.u.uErase, o.erase);
      gl.uniform1f(prog.view.u.uAlways, o.always || 0);
      gl.uniform1f(prog.view.u.uGazeIn, o.gazeIn);
      gl.uniform1f(prog.view.u.uGazeOut, o.gazeOut);
      gl.uniform1f(prog.view.u.uTime, o.time);
      gl.uniform1f(prog.view.u.uShake, o.shake || 0);
      gl.uniform1f(prog.view.u.uFade, o.fade == null ? 1 : o.fade);
      gl.uniform1f(prog.view.u.uReticle, o.reticle == null ? 1 : o.reticle);
      gl.uniform1f(prog.view.u.uHudOn, o.hud ? 1 : 0);
      gl.uniform1f(prog.view.u.uBlocks, o.blocks ? 1 : 0);
      /* Only a lens needs its edge hidden. */
      gl.uniform1f(prog.view.u.uVig, o.stereo ? 0.42 : 0.88);
      /* Cube edge, in units of the room box — which spans -1..1 across — and
         how many of those cubes deep the relief on the walls may stand. */
      gl.uniform1f(prog.view.u.uCell, o.cell || 0.1);
      gl.uniform1f(prog.view.u.uRelief, o.relief || 2);
      gl.uniform1f(prog.view.u.uReliefGrid, o.reliefGrid || 1);
      gl.uniform4fv(prog.view.u.uMarks, arr);
      gl.uniform1i(prog.view.u.uMarkN, n);
      for (i = 0; i < eyes; i++) {
        gl.viewport(i * vpW, 0, vpW, H);
        /* Nudge each eye's lens centre outward to match the barrel it looks through. */
        gl.uniform2f(prog.view.u.uLens, o.stereo ? (i === 0 ? o.lens : -o.lens) : 0, 0);
        draw();
      }
    },

    /* Where a world direction lands on the canvas, in pixels. The lens warp has
       to be undone to answer that, and the polynomial has no neat inverse, so
       it is walked back by repeated substitution — a handful of rounds is well
       inside a pixel at these strengths. */
    project: function (R, dir, eye, k1, k2, lensOff) {
      var W = canvas.width, H = canvas.height;
      var stereo = eye != null;
      var vpW = stereo ? Math.floor(W / 2) : W;
      var et = eyeTan(vpW, H);
      var ds = mat3MulVec(mat3T(R), dir);
      if (ds[2] > -0.05) return null;
      var pd = [ds[0] / -ds[2] / et[0], ds[1] / -ds[2] / et[1]];
      var p = [pd[0], pd[1]], i, r2, f;
      if (stereo && (k1 || k2)) {
        for (i = 0; i < 6; i++) {
          r2 = p[0] * p[0] + p[1] * p[1];
          f = 1 + k1 * r2 + k2 * r2 * r2;
          p = [pd[0] / f, pd[1] / f];
        }
      }
      var off = stereo ? (eye === 0 ? lensOff : -lensOff) : 0;
      return {
        x: (eye || 0) * vpW + ((p[0] + off) * 0.5 + 0.5) * vpW,
        y: (1 - ((p[1] * 0.5) + 0.5)) * H,   // canvas y grows downward
        glY: ((p[1] * 0.5) + 0.5) * H,
        inView: Math.abs(p[0] + off) < 1 && Math.abs(p[1]) < 1
      };
    },

    readMask: function () {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.maskC);
      gl.readPixels(0, 0, MASK_W, MASK_H, gl.RGBA, gl.UNSIGNED_BYTE, maskBuf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return maskBuf;
    },

    /* How well each slice of the compass has been painted, 0..1 per column,
       so the scan can say which way is still missing rather than only how far
       along it is. Filled in by coverage(). */
    yawCover: new Float32Array(COV_W),

    /* How much of the sphere has been painted, 0..1. */
    coverage: function () {
      target(fbo.cov, COV_W, COV_H);
      gl.useProgram(prog.cov.p);
      bind(0, tex.pano[panoIdx], prog.cov.u.uSrc);
      gl.uniform2f(prog.cov.u.uStep, 1 / PANO_W * 8, 1 / PANO_H * 8);
      draw();
      gl.readPixels(0, 0, COV_W, COV_H, gl.RGBA, gl.UNSIGNED_BYTE, covBuf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      /* Weight each row by how much sphere it covers, or the poles would
         flatter us: they are a lot of texels and hardly any room. */
      var sum = 0, wsum = 0, x, y, w, row, v;
      for (x = 0; x < COV_W; x++) this.yawCover[x] = 0;
      for (y = 0; y < COV_H; y++) {
        w = Math.cos((y + 0.5) / COV_H * Math.PI - Math.PI / 2);
        row = 0;
        for (x = 0; x < COV_W; x++) {
          v = covBuf[(y * COV_W + x) * 4 + 3] / 255;
          row += v;
          this.yawCover[x] += v * w;
        }
        sum += (row / COV_W) * w;
        wsum += w;
      }
      if (wsum) for (x = 0; x < COV_W; x++) this.yawCover[x] /= wsum;
      return wsum ? sum / wsum : 0;
    },

    resize: function () {
      var d = Math.min(global.devicePixelRatio || 1, 2);
      var w = Math.floor(canvas.clientWidth * d), h = Math.floor(canvas.clientHeight * d);
      if (w && h && (canvas.width !== w || canvas.height !== h)) {
        canvas.width = w; canvas.height = h;
      }
    }
  };

  global.VR = VR;
}(window));
