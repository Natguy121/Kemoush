/* KEMOSH — the seeing.
 *
 * Camera passthrough in stereo, with one rule: whatever you look at straight on
 * stops being there.
 *
 * How the erasing works, in one paragraph. The phone paints what it sees into a
 * panorama that is locked to the world, not to the screen, so turning your head
 * moves the view across a plate that stays put. Anything in the live frame that
 * disagrees with the plate is something that wasn't there when the room was
 * scanned — a person. Where that disagreement lands near the middle of your
 * vision, the pixels are taken from the plate instead of the camera, and the
 * person is simply not rendered. Look away and the camera comes back.
 */
(function (global) {
  'use strict';

  var PANO_W = 1024, PANO_H = 512;
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

  /* Same thing for a mouse or a thumb, so the game is playable without a phone. */
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
    '  o.a = min(1.0, prev.a + rate*0.8);',
    '}'
  ].join('\n');

  /* Disagreement between the live frame and the plate. Written in camera space
     so the game can read blobs straight off it. */
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
    '  m *= smoothstep(0.22, 0.65, b.a);',
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
    'uniform sampler2D uCam, uPano, uMask, uHud;',
    'uniform mat3 uR, uRinv;',
    'uniform mat2 uCamM;',
    'uniform vec2 uMaskTan, uEyeTan, uLens;',
    'uniform float uK1, uK2, uErase, uGazeIn, uGazeOut, uTime, uShake, uFade;',
    'uniform float uReticle, uHudOn;',
    'uniform vec4 uMarks[8];',
    'uniform int uMarkN;',
    'void main(){',
    '  vec2 p = (vUv*2.0-1.0) - uLens;',
    '  float r2 = dot(p,p);',
    /* Pre-shrink the frame so the Cardboard lens pulls it back to straight. */
    '  vec2 pd = p * (1.0 + uK1*r2 + uK2*r2*r2);',
    '  pd += vec2(sin(uTime*37.0), cos(uTime*31.0)) * uShake;',
    '  vec2 t = pd * uEyeTan;',
    '  vec3 ds = normalize(vec3(t, -1.0));',
    '  vec3 d = uR * ds;',
    '  vec4 plate = texture(uPano, panoFromDir(d));',
    '  vec2 cuv = (uCamM * t) * 0.5 + 0.5;',
    '  bool inCam = cuv.x > 0.0 && cuv.x < 1.0 && cuv.y > 0.0 && cuv.y < 1.0;',
    '  vec3 live = texture(uCam, cuv).rgb;',
    '  vec3 empty = mix(vec3(0.015,0.016,0.02), plate.rgb, plate.a);',
    '  vec3 base = inCam ? live : empty;',
    '  vec2 ms = (t / uMaskTan)*0.5+0.5;',
    '  float m = (ms.x>0.0&&ms.x<1.0&&ms.y>0.0&&ms.y<1.0) ? texture(uMask, ms).r : 0.0;',
    /* Firm the mask up: solid through the body, feathered only at the outline,
       or the silhouette survives as a dark outline of itself. */
    '  m = smoothstep(0.10, 0.45, m);',
    '  float ang = length(t);',
    /* Markers, and how much each phantom is being looked at. Drawn per eye so
       they sit where the lens puts them. */
    '  vec3 ringCol = vec3(0.0);',
    '  float whole = 0.0;',
    '  for (int i=0; i<8; i++){',
    '    if (i >= uMarkN) break;',
    '    vec3 md = uRinv * uMarks[i].xyz;',
    '    if (md.z > -0.08) continue;',
    '    vec2 mt = md.xy / -md.z;',
    '    vec2 v = t - mt;',
    '    float dist = length(v);',
    /* A person goes as a person. Gate on where the phantom is, not where this
       pixel is, or looking at someone punches a hole and leaves the rest. */
    '    if (dist < 0.42) whole = max(whole, 1.0 - smoothstep(uGazeOut*0.55, uGazeOut, length(mt)));',
    '    float ch = uMarks[i].w;',
    '    float R = 0.085 + 0.012*sin(uTime*4.0);',
    '    float ring = smoothstep(0.012, 0.0, abs(dist - R));',
    '    float a = atan(v.x, v.y)/TAU + 0.5;',
    '    float arc = (a < abs(ch)) ? smoothstep(0.02, 0.0, abs(dist - R*0.78)) : 0.0;',
    '    vec3 tint = ch < 0.0 ? vec3(1.0,0.32,0.28) : mix(vec3(0.45,0.85,1.0), vec3(0.6,1.0,0.7), abs(ch));',
    '    ringCol += tint * (ring*0.55 + arc*0.9);',
    '  }',
    /* Anything not yet tracked still fades where you stare, so the effect never
       waits on the tracker to catch up. */
    '  float gaze = max(whole, 1.0 - smoothstep(uGazeIn, uGazeOut, ang));',
    '  float erase = clamp(m * gaze * uErase, 0.0, 1.0);',
    /* Dissolve rather than cut: a hard swap between two images reads as a glitch,
       a noisy wipe reads as something being taken away. */
    '  float n = hash21(floor(cuv*vec2(220.0,124.0)) + floor(uTime*14.0)*7.13);',
    '  float e = clamp(erase*1.7 - n*0.45 - 0.05, 0.0, 1.0);',
    '  e = smoothstep(0.0, 0.5, e);',
    '  vec3 col = mix(base, empty, e);',
    '  col += vec3(0.25,0.75,0.95) * e*(1.0-e) * 2.2 * m;',
    '  col += ringCol;',
    /* Centre mark: where looking becomes erasing. */
    '  float gr = smoothstep(0.005, 0.0, abs(ang - uGazeOut));',
    '  col += vec3(0.9,0.35,0.35) * gr * 0.16 * uReticle;',
    '  float dot0 = smoothstep(0.010, 0.0, ang);',
    '  col += vec3(1.0) * dot0 * 0.55 * uReticle;',
    /* The bar is placed in screen units, not world angles, so it stays on the
       glass whatever the camera's field of view turns out to be. */
    '  if (uHudOn > 0.5) {',
    '    vec2 h = (pd - vec2(0.0,-0.70)) / vec2(0.80,0.16);',
    '    if (abs(h.x) < 1.0 && abs(h.y) < 1.0) {',
    '      vec4 hud = texture(uHud, h*0.5+0.5);',
    '      col = mix(col, hud.rgb, hud.a);',
    '    }',
    '  }',
    '  float vig = 1.0 - smoothstep(0.55, 1.25, length(p));',
    '  col *= mix(0.25, 1.0, vig);',
    '  o = vec4(col * uFade, 1.0);',
    '}'
  ].join('\n');

  /* A room made of arithmetic, for playing without a camera. */
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

      updateCamGeom(65, 16, 9, 0);
      this.forget();
      return null;
    },

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

    /* Throw the plate away — used before a fresh scan. */
    forget: function () {
      var i;
      for (i = 0; i < 2; i++) {
        target(fbo.pano[i], PANO_W, PANO_H);
        gl.clearColor(0.05, 0.05, 0.06, 0.0);
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
    renderSim: function (R, time, phantoms, visible) {
      var i, arr = new Float32Array(32), n = Math.min(8, phantoms.length);
      for (i = 0; i < n; i++) {
        arr[i * 4] = phantoms[i].dir[0];
        arr[i * 4 + 1] = phantoms[i].dir[1];
        arr[i * 4 + 2] = phantoms[i].dir[2];
        arr[i * 4 + 3] = phantoms[i].size;
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
      var arr = new Float32Array(32), i, n = Math.min(8, o.marks.length);
      for (i = 0; i < n; i++) {
        arr[i * 4] = o.marks[i].dir[0];
        arr[i * 4 + 1] = o.marks[i].dir[1];
        arr[i * 4 + 2] = o.marks[i].dir[2];
        arr[i * 4 + 3] = o.marks[i].charge;
      }
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.useProgram(prog.view.p);
      bind(0, simOn ? tex.sim : tex.cam, prog.view.u.uCam);
      bind(1, tex.pano[panoIdx], prog.view.u.uPano);
      bind(2, tex.maskC, prog.view.u.uMask);
      bind(3, tex.hud, prog.view.u.uHud);
      gl.uniformMatrix3fv(prog.view.u.uR, false, R);
      gl.uniformMatrix3fv(prog.view.u.uRinv, false, Rinv);
      gl.uniformMatrix2fv(prog.view.u.uCamM, false, camGeom.camM);
      gl.uniform2fv(prog.view.u.uMaskTan, camGeom.maskTan);
      gl.uniform2f(prog.view.u.uEyeTan, et[0], et[1]);
      gl.uniform1f(prog.view.u.uK1, o.stereo ? o.k1 : 0);
      gl.uniform1f(prog.view.u.uK2, o.stereo ? o.k2 : 0);
      gl.uniform1f(prog.view.u.uErase, o.erase);
      gl.uniform1f(prog.view.u.uGazeIn, o.gazeIn);
      gl.uniform1f(prog.view.u.uGazeOut, o.gazeOut);
      gl.uniform1f(prog.view.u.uTime, o.time);
      gl.uniform1f(prog.view.u.uShake, o.shake || 0);
      gl.uniform1f(prog.view.u.uFade, o.fade == null ? 1 : o.fade);
      gl.uniform1f(prog.view.u.uReticle, o.reticle == null ? 1 : o.reticle);
      gl.uniform1f(prog.view.u.uHudOn, o.hud ? 1 : 0);
      gl.uniform4fv(prog.view.u.uMarks, arr);
      gl.uniform1i(prog.view.u.uMarkN, n);
      for (i = 0; i < eyes; i++) {
        gl.viewport(i * vpW, 0, vpW, H);
        /* Nudge each eye's lens centre outward to match the barrel it looks through. */
        gl.uniform2f(prog.view.u.uLens, o.stereo ? (i === 0 ? o.lens : -o.lens) : 0, 0);
        draw();
      }
    },

    readMask: function () {
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.maskC);
      gl.readPixels(0, 0, MASK_W, MASK_H, gl.RGBA, gl.UNSIGNED_BYTE, maskBuf);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      return maskBuf;
    },

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
      var sum = 0, wsum = 0, x, y, w, row;
      for (y = 0; y < COV_H; y++) {
        w = Math.cos((y + 0.5) / COV_H * Math.PI - Math.PI / 2);
        row = 0;
        for (x = 0; x < COV_W; x++) row += covBuf[(y * COV_W + x) * 4 + 3] / 255;
        sum += (row / COV_W) * w;
        wsum += w;
      }
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
