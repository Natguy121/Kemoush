/* KEMOSH — walking.
 *
 * An AR session on Android knows where the phone is, not only which way it
 * faces, and hands over a depth map with every frame. That is everything
 * needed to put what the camera sees at real places in the room, which is
 * what World stores. From there the room is drawn from wherever you are
 * standing, so you can walk through it and see it from any side.
 *
 * Two ways to look:
 *   blocks  — the room as you scanned it, and nothing else. People who walk
 *             in were never part of it, so they are never drawn.
 *   camera  — the live picture, except where the depth map says something is
 *             standing in front of a part of the room you scanned. There the
 *             scanned room is drawn instead, so the person is replaced by what
 *             is behind them.
 *
 * "Try it on this screen" runs the same thing against a pretend room: a
 * pretend camera produces the same depth and colour a phone would, and it all
 * goes down the same path.
 */
(function () {
  'use strict';

  var $ = function (q) { return document.querySelector(q); };

  /* ---------- small matrix kit (column-major, like WebGL and WebXR) ---------- */

  function mul(a, b) {
    var o = new Float32Array(16), i, j;
    for (i = 0; i < 4; i++) for (j = 0; j < 4; j++) {
      o[j * 4 + i] = a[i] * b[j * 4] + a[4 + i] * b[j * 4 + 1] + a[8 + i] * b[j * 4 + 2] + a[12 + i] * b[j * 4 + 3];
    }
    return o;
  }
  function rigidInverse(m) {
    var o = new Float32Array(16);
    o[0] = m[0]; o[1] = m[4]; o[2] = m[8];
    o[4] = m[1]; o[5] = m[5]; o[6] = m[9];
    o[8] = m[2]; o[9] = m[6]; o[10] = m[10];
    o[12] = -(m[0] * m[12] + m[1] * m[13] + m[2] * m[14]);
    o[13] = -(m[4] * m[12] + m[5] * m[13] + m[6] * m[14]);
    o[14] = -(m[8] * m[12] + m[9] * m[13] + m[10] * m[14]);
    o[15] = 1;
    return o;
  }
  function perspective(fovY, aspect, n, f) {
    var t = 1 / Math.tan(fovY / 2);
    return new Float32Array([t / aspect, 0, 0, 0, 0, t, 0, 0, 0, 0, (f + n) / (n - f), -1, 0, 0, 2 * f * n / (n - f), 0]);
  }
  /* Where a camera at p, turned by yaw and tilted by pitch, sits in the room. */
  function poseMatrix(p, yaw, pitch) {
    var cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch);
    return new Float32Array([cy, 0, -sy, 0, sy * sp, cp, cy * sp, 0, sy * cp, -sp, cy * cp, 0, p[0], p[1], p[2], 1]);
  }
  function translate(x) {
    return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, 0, 0, 1]);
  }

  /* ---------- settings (shared with the rest of the page) ---------- */

  function S() { return (window.KEMOSH && window.KEMOSH.settings) ? window.KEMOSH.settings() : {}; }
  var LENS = { off: [0, 0], light: [0.16, 0.10], strong: [0.34, 0.24] };
  /* The block-size choice was cubes-across-a-room; walking needs a real size. */
  function blockSize() { return ({ 48: 0.15, 80: 0.1, 120: 0.06 })[S().grid] || 0.1; }

  /* ---------- GL ---------- */

  var canvas, gl, prog = {}, vao = {}, buf = {};
  var VOID = [0.965, 0.97, 0.975];

  var CUBE_VS = [
    '#version 300 es',
    'layout(location=0) in vec3 aPos;',
    'layout(location=1) in vec3 aNrm;',
    'layout(location=2) in vec4 aInst;',
    'layout(location=3) in vec4 aCol;',
    'layout(location=4) in vec3 aSize;',
    'uniform mat4 uView, uProj;',
    'uniform float uTime, uGrow;',
    'out vec3 vN; out vec3 vLocal; out vec4 vCol; out float vAge; out float vDist; out float vDepth;',
    'void main() {',
    '  float age = aInst.w > 0.0 ? clamp((uTime - aInst.w) / 0.9, 0.0, 1.0) : 1.0;',
    '  float k = mix(1.0, 0.5 + 0.5 * age, uGrow);',
    '  vec3 w = aInst.xyz + aSize * 0.5 + (aPos - 0.5) * aSize * k;',
    '  vec4 v = uView * vec4(w, 1.0);',
    '  gl_Position = uProj * v;',
    '  vN = aNrm; vLocal = aPos; vCol = aCol; vAge = age;',
    '  vDist = length(v.xyz); vDepth = -v.z;',
    '}'
  ].join('\n');

  var CUBE_FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec3 vN; in vec3 vLocal; in vec4 vCol; in float vAge; in float vDist; in float vDepth;',
    'uniform vec3 uVoid; uniform float uSeams; uniform float uFog; uniform float uDepthOut;',
    'out vec4 o;',
    'void main() {',
    /* Floor-side faces brightest, ceiling-side darkest, walls between: most of
       what says "cube" to the eye. */
    '  float shade = vN.y > 0.5 ? 1.0 : (vN.y < -0.5 ? 0.64 : (abs(vN.x) > 0.5 ? 0.87 : 0.77));',
    '  vec3 c = vCol.rgb * shade;',
    '  if (uSeams > 0.5) {',
    '    vec2 e = abs(vN.x) > 0.5 ? vLocal.yz : (abs(vN.y) > 0.5 ? vLocal.xz : vLocal.xy);',
    '    float d = min(min(e.x, 1.0 - e.x), min(e.y, 1.0 - e.y));',
    '    c *= mix(0.82, 1.0, smoothstep(0.0, 0.09, d));',
    '  }',
    /* A block arrives out of the white, over about a second. */
    '  c = mix(vec3(1.0), c, smoothstep(0.0, 1.0, vAge));',
    '  c = mix(c, uVoid, uFog * smoothstep(7.0, 16.0, vDist));',
    '  o = uDepthOut > 0.5 ? vec4(c, clamp(vDepth / 10.0, 0.0, 0.998)) : vec4(c, 1.0);',
    '}'
  ].join('\n');

  var QUAD_VS = [
    '#version 300 es',
    'const vec2 P[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));',
    'void main() { gl_Position = vec4(P[gl_VertexID], 0.0, 1.0); }'
  ].join('\n');

  var FILL_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform vec4 uColour;',
    'out vec4 o;',
    'void main() { o = uColour; }'
  ].join('\n');

  /* The camera picture, shrunk to a thumbnail the scanner can read colours
     from. Rows are laid out so that row 0 is the bottom of the picture. */
  var COPY_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D uTex; uniform vec2 uSize; uniform float uFlip;',
    'out vec4 o;',
    'void main() {',
    '  vec2 uv = gl_FragCoord.xy / uSize;',
    '  o = texture(uTex, vec2(uv.x, uFlip > 0.5 ? 1.0 - uv.y : uv.y));',
    '}'
  ].join('\n');

  /* Camera view. Where the live depth says something is nearer than the room
     you scanned, draw the scanned room there instead. Everything else stays
     transparent, so the camera shows through. */
  var SWAP_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D uModel, uLive;',
    'uniform mat4 uDepthM;',
    'uniform vec4 uVp;',
    'uniform float uMargin;',
    'out vec4 o;',
    'void main() {',
    '  vec2 uv = (gl_FragCoord.xy - uVp.xy) / uVp.zw;',
    '  vec4 m = texture(uModel, uv);',
    '  if (m.a > 0.997) discard;',
    '  vec2 du = (uDepthM * vec4(uv.x, 1.0 - uv.y, 0.0, 1.0)).xy;',
    '  if (du.x < 0.0 || du.y < 0.0 || du.x > 1.0 || du.y > 1.0) discard;',
    '  float live = texture(uLive, du).r;',
    '  if (live <= 0.0 || live > m.a * 10.0 - uMargin) discard;',
    '  o = vec4(m.rgb, 1.0);',
    '}'
  ].join('\n');

  /* Cardboard: each eye's picture bent so the lens bends it back straight. */
  var WARP_FS = [
    '#version 300 es',
    'precision highp float;',
    'uniform sampler2D uEye; uniform vec4 uVp; uniform vec2 uCentre; uniform float uK1, uK2, uAspect;',
    'out vec4 o;',
    'void main() {',
    '  vec2 uv = (gl_FragCoord.xy - uVp.xy) / uVp.zw;',
    '  vec2 p = (uv - uCentre) * vec2(uAspect, 1.0);',
    '  float r2 = dot(p, p);',
    '  vec2 q = p * (1.0 + uK1 * r2 + uK2 * r2 * r2);',
    '  vec2 s = uCentre + q / vec2(uAspect, 1.0);',
    '  if (s.x < 0.0 || s.y < 0.0 || s.x > 1.0 || s.y > 1.0) { o = vec4(0.0, 0.0, 0.0, 1.0); return; }',
    '  float vig = 1.0 - 0.35 * smoothstep(0.30, 0.62, length(p));',
    '  o = vec4(texture(uEye, s).rgb * vig, 1.0);',
    '}'
  ].join('\n');

  function compile(vs, fs) {
    function sh(type, src) {
      var s = gl.createShader(type);
      gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var p = gl.createProgram();
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    var u = {}, n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS), i, info;
    for (i = 0; i < n; i++) { info = gl.getActiveUniform(p, i); u[info.name] = gl.getUniformLocation(p, info.name); }
    return { p: p, u: u };
  }

  function cubeGeometry() {
    var faces = [
      [[1, 0, 0], [[1, 0, 0], [1, 1, 0], [1, 1, 1], [1, 0, 1]]],
      [[-1, 0, 0], [[0, 0, 1], [0, 1, 1], [0, 1, 0], [0, 0, 0]]],
      [[0, 1, 0], [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]]],
      [[0, -1, 0], [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]]],
      [[0, 0, 1], [[1, 0, 1], [1, 1, 1], [0, 1, 1], [0, 0, 1]]],
      [[0, 0, -1], [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]]]
    ];
    var out = [];
    faces.forEach(function (f) {
      var n = f[0], q = f[1];
      [0, 1, 2, 0, 2, 3].forEach(function (k) { out.push(q[k][0], q[k][1], q[k][2], n[0], n[1], n[2]); });
    });
    return new Float32Array(out);
  }

  function makeCubeVao(withSize) {
    var v = gl.createVertexArray();
    gl.bindVertexArray(v);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.cube);
    gl.enableVertexAttribArray(0); gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
    gl.enableVertexAttribArray(1); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    var inst = gl.createBuffer(), col = gl.createBuffer(), size = null;
    gl.bindBuffer(gl.ARRAY_BUFFER, inst);
    gl.enableVertexAttribArray(2); gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(2, 1);
    gl.bindBuffer(gl.ARRAY_BUFFER, col);
    gl.enableVertexAttribArray(3); gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 0, 0); gl.vertexAttribDivisor(3, 1);
    if (withSize) {
      size = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, size);
      gl.enableVertexAttribArray(4); gl.vertexAttribPointer(4, 3, gl.FLOAT, false, 0, 0); gl.vertexAttribDivisor(4, 1);
    } else {
      gl.disableVertexAttribArray(4);
    }
    gl.bindVertexArray(null);
    return { vao: v, inst: inst, col: col, size: size, count: 0 };
  }

  function makeTarget(w, h, depth) {
    var t = { w: w, h: h, tex: gl.createTexture(), fb: gl.createFramebuffer(), rb: null };
    gl.bindTexture(gl.TEXTURE_2D, t.tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t.tex, 0);
    if (depth) {
      t.rb = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, t.rb);
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, t.rb);
    }
    return t;
  }
  function dropTarget(t) {
    if (!t) return;
    gl.deleteTexture(t.tex); gl.deleteFramebuffer(t.fb);
    if (t.rb) gl.deleteRenderbuffer(t.rb);
  }
  var targets = {};
  function target(name, w, h, depth) {
    var t = targets[name];
    if (t && t.w === w && t.h === h) return t;
    dropTarget(t);
    return (targets[name] = makeTarget(w, h, depth));
  }

  function initGL() {
    canvas = $('#walk');
    gl = canvas.getContext('webgl2', { xrCompatible: true, alpha: true, antialias: true, preserveDrawingBuffer: true });
    if (!gl) return 'This browser has no WebGL2.';
    try {
      prog.cube = compile(CUBE_VS, CUBE_FS);
      prog.fill = compile(QUAD_VS, FILL_FS);
      prog.copy = compile(QUAD_VS, COPY_FS);
      prog.swap = compile(QUAD_VS, SWAP_FS);
      prog.warp = compile(QUAD_VS, WARP_FS);
    } catch (e) { return 'A walking shader failed to build: ' + e.message; }
    buf.cube = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf.cube);
    gl.bufferData(gl.ARRAY_BUFFER, cubeGeometry(), gl.STATIC_DRAW);
    vao.blocks = makeCubeVao(false);
    vao.scene = makeCubeVao(true);
    vao.empty = gl.createVertexArray();

    buf.live = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, buf.live);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, 1, 1, 0, gl.RED, gl.FLOAT, new Float32Array([0]));
    return null;
  }

  function uploadBlocks() {
    var d = World.instances();
    gl.bindBuffer(gl.ARRAY_BUFFER, vao.blocks.inst);
    gl.bufferData(gl.ARRAY_BUFFER, d.pos.subarray(0, d.count * 4), gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vao.blocks.col);
    gl.bufferData(gl.ARRAY_BUFFER, d.col.subarray(0, d.count * 4), gl.DYNAMIC_DRAW);
    vao.blocks.count = d.count;
  }

  /* The live depth map, in metres, for the camera view's swap. */
  var live = { ok: false, m: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]) };
  function uploadLive(data, w, h, matrix) {
    gl.bindTexture(gl.TEXTURE_2D, buf.live);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, w, h, 0, gl.RED, gl.FLOAT, data);
    if (matrix) live.m = matrix;
    live.ok = true;
  }

  /* ---------- drawing one eye ---------- */

  function drawCubes(v, viewM, projM, opts) {
    if (!v.count) return;
    var p = prog.cube;
    gl.useProgram(p.p);
    gl.uniformMatrix4fv(p.u.uView, false, viewM);
    gl.uniformMatrix4fv(p.u.uProj, false, projM);
    gl.uniform1f(p.u.uTime, now);
    gl.uniform1f(p.u.uGrow, opts.grow ? 1 : 0);
    gl.uniform3fv(p.u.uVoid, VOID);
    gl.uniform1f(p.u.uSeams, opts.seams ? 1 : 0);
    gl.uniform1f(p.u.uFog, opts.fog ? 1 : 0);
    gl.uniform1f(p.u.uDepthOut, opts.depthOut ? 1 : 0);
    gl.bindVertexArray(v.vao);
    if (opts.size) gl.vertexAttrib3f(4, opts.size, opts.size, opts.size);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, 36, v.count);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.DEPTH_TEST);
    gl.bindVertexArray(null);
  }

  function fill(r, g, b, a) {
    gl.useProgram(prog.fill.p);
    gl.uniform4f(prog.fill.u.uColour, r * a, g * a, b * a, a);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.ONE, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(vao.empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
  }

  /* One eye's picture into whatever framebuffer is bound, in viewport vp. */
  function drawEye(fb, vp, viewM, projM) {
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.viewport(vp[0], vp[1], vp[2], vp[3]);
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(vp[0], vp[1], vp[2], vp[3]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    /* On a phone the camera is already behind this, put there by the browser.
       The pretend room has to paint its own. */
    if (sim) drawCubes(vao.scene, viewM, projM, { seams: false });

    /* 'raw' is the camera with nothing swapped, kept for checking the swap. */
    var cameraView = phase === 'live' && (view === 'camera' || view === 'raw');
    if (!cameraView) {
      /* While scanning, the camera shows faintly through the white so you can
         see where you are walking before the blocks have caught up. */
      fill(VOID[0], VOID[1], VOID[2], phase === 'scan' ? 0.86 : 1.0);
      gl.clear(gl.DEPTH_BUFFER_BIT);
      drawCubes(vao.blocks, viewM, projM, { seams: true, grow: true, fog: true, size: World.size() });
    } else if (view === 'camera' && live.ok && vao.blocks.count) {
      var t = target('model', vp[2], vp[3], true);
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
      gl.viewport(0, 0, t.w, t.h);
      gl.disable(gl.SCISSOR_TEST);
      gl.clearColor(VOID[0], VOID[1], VOID[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      drawCubes(vao.blocks, viewM, projM, { seams: true, depthOut: true, size: World.size() });

      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      gl.viewport(vp[0], vp[1], vp[2], vp[3]);
      gl.enable(gl.SCISSOR_TEST);
      var p = prog.swap;
      gl.useProgram(p.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, buf.live);
      gl.uniform1i(p.u.uModel, 0); gl.uniform1i(p.u.uLive, 1);
      gl.uniformMatrix4fv(p.u.uDepthM, false, live.m);
      gl.uniform4f(p.u.uVp, vp[0], vp[1], vp[2], vp[3]);
      gl.uniform1f(p.u.uMargin, 0.15);
      gl.bindVertexArray(vao.empty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.activeTexture(gl.TEXTURE0);
    }
    gl.disable(gl.SCISSOR_TEST);
  }

  /* The whole frame: one picture, or two bent ones for Cardboard. camM is
     where the camera is in the room, projM is how it sees. */
  function drawFrame(fb, vp, camM, projM) {
    var stereo = !!S().walkStereo && !(phase === 'live' && view === 'camera');
    if (!stereo) { drawEye(fb, vp, rigidInverse(camM), projM); return; }

    var halfW = Math.floor(vp[2] / 2), h = vp[3];
    var eyeProj = perspective(80 * Math.PI / 180, halfW / h, 0.05, 40);
    var lens = LENS[S().lens] || LENS.light;
    var ipd = S().ipd || 0.06;
    for (var e = 0; e < 2; e++) {
      var side = e === 0 ? -1 : 1;
      var eyeM = mul(camM, translate(side * 0.032));
      var t = target('eye' + e, halfW, h, true);
      drawEye(t.fb, [0, 0, halfW, h], rigidInverse(eyeM), eyeProj);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      var evp = [vp[0] + e * halfW, vp[1], halfW, h];
      gl.viewport(evp[0], evp[1], evp[2], evp[3]);
      var p = prog.warp;
      gl.useProgram(p.p);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, t.tex);
      gl.uniform1i(p.u.uEye, 0);
      gl.uniform4f(p.u.uVp, evp[0], evp[1], evp[2], evp[3]);
      gl.uniform2f(p.u.uCentre, 0.5 - side * ipd, 0.5);
      gl.uniform1f(p.u.uK1, lens[0]); gl.uniform1f(p.u.uK2, lens[1]);
      gl.uniform1f(p.u.uAspect, halfW / h);
      gl.bindVertexArray(vao.empty);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  /* ---------- session state ---------- */

  var phase = 'off';        // off | scan | live
  var view = 'blocks';      // blocks | camera
  var sim = false;
  var now = 0, frames = 0, lastBuild = 0, colour = false;
  var eyePos = [0, 0, 0];
  var session = null, refSpace = null, binding = null, started = false;
  var PTS = new Float32Array(160 * 160 * 3), RGB = new Uint8Array(160 * 160 * 3);

  function setPhase(p) {
    phase = p;
    document.body.dataset.phase = p === 'off' ? 'idle' : 'walk-' + p;
    document.body.dataset.sim = sim ? '1' : '';
    status();
  }

  function status() {
    var st = World.stats(), el = $('#wStat');
    if (!el) return;
    if (phase === 'scan') {
      el.textContent = st.blocks.toLocaleString() + ' blocks · ' + st.area.toFixed(1) + ' m² mapped' +
        (colour || sim ? '' : ' · shape only, this phone gives no colour');
    } else if (phase === 'live') {
      el.textContent = view === 'blocks' ? 'walk around — people aren’t part of this'
        : 'camera — people are swapped for the room behind them';
    }
    $('#wView').textContent = view === 'blocks' ? 'show camera' : 'show blocks';
  }

  function rebuild(force) {
    if (!force && now - lastBuild < 0.15) return;
    lastBuild = now;
    if (World.build()) { uploadBlocks(); if (frames % 4 === 0 || force) status(); }
  }

  function done() {
    if (phase !== 'scan') return;
    rebuild(true);
    setPhase('live');
  }
  function rescan() {
    World.reset(blockSize(), eyePos);
    vao.blocks.count = 0;
    live.ok = false;
    setPhase('scan');
  }
  function toggleView() {
    view = view === 'blocks' ? 'camera' : 'blocks';
    status();
  }
  function quit() {
    if (session) { try { session.end(); } catch (e) {} return; }
    stopSim();
  }
  function note(msg) {
    var el = $('#note');
    if (!el) return;
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  /* ---------- the real thing: an AR session ---------- */

  async function probe() {
    var ua = (navigator && navigator.userAgent) || '';
    if (!navigator.xr) {
      return { ok: false, why: /iPhone|iPad/i.test(ua)
        ? 'This is an iPhone. Even the LiDAR scanner on Pro models can’t help here — every browser on iPhone (Safari, Chrome, all of them) runs on the same engine, and none of them let a web page reach LiDAR or ARKit depth data. Walking needs Android with ARCore; turning on the spot works here.'
        : 'This browser has no WebXR, so it can’t track you walking. Turning on the spot still works.' };
    }
    try {
      if (await navigator.xr.isSessionSupported('immersive-ar')) return { ok: true };
    } catch (e) { return { ok: false, why: String(e && e.message || e) }; }
    return { ok: false, why: 'This phone reports no AR. On Android that usually means Google Play Services for AR is missing or out of date.' };
  }

  async function startXR() {
    note('');
    var r = await probe();
    if (!r.ok) { note(r.why); return; }
    try {
      session = await navigator.xr.requestSession('immersive-ar', {
        requiredFeatures: ['depth-sensing'],
        optionalFeatures: ['camera-access', 'dom-overlay'],
        domOverlay: { root: $('#walkUi') },
        depthSensing: {
          usagePreference: ['cpu-optimized'],
          dataFormatPreference: ['luminance-alpha', 'float32']
        }
      });
    } catch (e) {
      note('Could not start walking: ' + (e && e.message || e) +
        '. This phone may not offer depth sensing — turning on the spot still works.');
      return;
    }
    sim = false;
    try { await gl.makeXRCompatible(); } catch (e) {}
    session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });
    refSpace = await session.requestReferenceSpace('local');
    binding = null;
    try { if (window.XRWebGLBinding) binding = new XRWebGLBinding(session, gl); } catch (e) {}
    colour = false;
    started = false;
    view = S().view === 'camera' ? 'camera' : 'blocks';
    live.ok = false;
    session.addEventListener('end', function () {
      session = null;
      setPhase('off');
    });
    session.addEventListener('select', onSelect);
    setPhase('scan');
    session.requestAnimationFrame(xrFrame);
  }

  /* With a phone in a headset, the only control left is tapping the screen.
     Two taps: Done while scanning, swap views after. */
  var lastSelect = 0;
  function onSelect() {
    var t = performance.now();
    if (t - lastSelect < 450) { lastSelect = 0; if (phase === 'scan') done(); else toggleView(); }
    else lastSelect = t;
  }

  var CW = 96, CH = 72, camPix = new Uint8Array(CW * CH * 4);
  function readCamera(v) {
    var tex = null;
    try { tex = binding.getCameraImage(v.camera); } catch (e) { return null; }
    if (!tex) return null;
    var t = target('cam', CW, CH, false);
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fb);
    gl.viewport(0, 0, CW, CH);
    var p = prog.copy;
    gl.useProgram(p.p);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(p.u.uTex, 0);
    gl.uniform2f(p.u.uSize, CW, CH);
    gl.uniform1f(p.u.uFlip, S().camFlip ? 1 : 0);
    gl.bindVertexArray(vao.empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, CW, CH, gl.RGBA, gl.UNSIGNED_BYTE, camPix);
    gl.bindTexture(gl.TEXTURE_2D, null);
    return camPix;
  }

  /* A depth map, turned into places in the room. getDepthInMeters takes a
     spot on the screen (top-left is 0,0) and gives its distance from the
     phone's own plane; the projection turns that into a point in front of
     the phone, and the phone's pose puts that point in the room. */
  function sampleXR(v, info, pix) {
    var P = v.projectionMatrix, M = v.transform.matrix;
    var land = info.width >= info.height;
    var SU = land ? 64 : 40, SV = land ? 40 : 64, n = 0, i, j, u, w, d, x, y, z, k, c;
    for (j = 0; j < SV; j++) {
      for (i = 0; i < SU; i++) {
        u = (i + 0.5) / SU; w = (j + 0.5) / SV;
        try { d = info.getDepthInMeters(u, w); } catch (e) { continue; }
        if (!(d > 0.2 && d < 5.5)) continue;
        x = d * ((2 * u - 1) + P[8]) / P[0];
        y = d * ((1 - 2 * w) + P[9]) / P[5];
        z = -d;
        k = n * 3;
        PTS[k] = M[0] * x + M[4] * y + M[8] * z + M[12];
        PTS[k + 1] = M[1] * x + M[5] * y + M[9] * z + M[13];
        PTS[k + 2] = M[2] * x + M[6] * y + M[10] * z + M[14];
        if (pix) {
          c = (Math.min(CH - 1, Math.floor((1 - w) * CH)) * CW + Math.min(CW - 1, Math.floor(u * CW))) * 4;
          RGB[k] = pix[c]; RGB[k + 1] = pix[c + 1]; RGB[k + 2] = pix[c + 2];
        }
        n++;
      }
    }
    World.ingest(eyePos, PTS, pix ? RGB : null, n, now);
  }

  var liveBuf = null;
  function liveFromXR(info) {
    var n = info.width * info.height, i, src;
    if (!liveBuf || liveBuf.length !== n) liveBuf = new Float32Array(n);
    src = info.data instanceof ArrayBuffer
      ? (session.depthDataFormat === 'float32' ? new Float32Array(info.data) : new Uint16Array(info.data))
      : null;
    if (!src) return;
    var k = info.rawValueToMeters;
    for (i = 0; i < n; i++) liveBuf[i] = src[i] * k;
    uploadLive(liveBuf, info.width, info.height, info.normDepthBufferFromNormView.matrix);
  }

  function xrFrame(time, frame) {
    if (!session) return;
    session.requestAnimationFrame(xrFrame);
    now = time / 1000; frames++;
    var layer = session.renderState.baseLayer;
    var pose = frame.getViewerPose(refSpace);
    if (!pose) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      $('#wStat').textContent = 'finding your feet — move the phone slowly';
      return;
    }
    var p = pose.transform.position;
    eyePos = [p.x, p.y, p.z];
    if (!started) { World.reset(blockSize(), eyePos); vao.blocks.count = 0; started = true; }

    var v = pose.views[0];
    var info = null;
    try { info = frame.getDepthInformation(v); } catch (e) {}
    if (info && phase === 'scan') {
      var pix = null;
      if (binding && v.camera && frames % 2 === 0) { pix = readCamera(v); if (pix) colour = true; }
      sampleXR(v, info, pix);
    }
    if (info && phase === 'live' && view === 'camera') liveFromXR(info);
    rebuild(false);

    var vp = layer.getViewport(v);
    drawFrame(layer.framebuffer, [vp.x, vp.y, vp.width, vp.height], v.transform.matrix, v.projectionMatrix);
  }

  /* ---------- the pretend room ---------- */

  function box(a, b, c) { return { min: a, max: b, c: c }; }
  var ROOM = [
    box([-2.6, -0.1, -3.1], [2.6, 0, 3.1], [196, 168, 128]),      // floor
    box([-2.6, 2.6, -3.1], [2.6, 2.7, 3.1], [242, 242, 238]),     // ceiling
    box([-2.7, 0, -3.1], [-2.6, 2.6, 3.1], [228, 233, 238]),      // walls
    box([2.6, 0, -3.1], [2.7, 2.6, 3.1], [238, 231, 216]),
    box([-2.6, 0, -3.2], [2.6, 2.6, -3.1], [231, 237, 231]),
    box([-2.6, 0, 3.1], [2.6, 2.6, 3.2], [237, 227, 229]),
    box([0.9, 0, -3.1], [2.6, 0.5, -1.1], [122, 152, 204]),       // bed
    box([1.1, 0.5, -3.0], [2.4, 0.66, -2.6], [246, 246, 246]),    // pillow
    box([0.9, 0, -3.1], [2.6, 1.1, -2.96], [112, 80, 58]),        // headboard
    box([-2.6, 0, -1.2], [-1.9, 0.78, 0.4], [152, 110, 70]),      // desk
    box([-1.8, 0, -0.6], [-1.35, 0.48, -0.15], [60, 62, 74]),     // chair
    box([-1.42, 0.48, -0.6], [-1.35, 1.0, -0.15], [60, 62, 74]),
    box([1.9, 0, 1.3], [2.6, 2.1, 3.1], [92, 64, 46]),            // wardrobe
    box([-0.6, 0, 1.4], [0.6, 0.72, 2.2], [202, 160, 112]),       // table
    box([-1.5, 1.2, -3.1], [-0.5, 1.9, -3.08], [222, 92, 72]),    // poster
    box([-1.2, 0, -0.9], [0.7, 0.02, 0.7], [172, 72, 84])         // rug
  ];
  var person = box([0, 0, 0], [0, 0, 0], [38, 88, 178]);
  var scene = ROOM.concat([person]);
  var simPose = { p: [0, 1.5, 0.3], yaw: 0, pitch: -0.15 };
  var keys = {}, simRaf = 0, simLast = 0;

  function movePerson(t) {
    var x = -0.3 + Math.sin(t * 0.45) * 1.1, z = -1.7 + Math.cos(t * 0.3) * 0.25;
    person.min = [x - 0.22, 0, z - 0.14];
    person.max = [x + 0.22, 1.74, z + 0.14];
  }

  function uploadScene() {
    var n = scene.length, pos = new Float32Array(n * 4), col = new Uint8Array(n * 4), size = new Float32Array(n * 3);
    scene.forEach(function (b, i) {
      pos.set([b.min[0], b.min[1], b.min[2], 0], i * 4);
      col.set([b.c[0], b.c[1], b.c[2], 255], i * 4);
      size.set([b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]], i * 3);
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, vao.scene.inst); gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vao.scene.col); gl.bufferData(gl.ARRAY_BUFFER, col, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, vao.scene.size); gl.bufferData(gl.ARRAY_BUFFER, size, gl.DYNAMIC_DRAW);
    vao.scene.count = n;
  }

  /* Nearest box along a ray, as a multiple of d (so an unnormalised d gives
     distance from the camera's plane, exactly what a phone's depth map holds). */
  function cast(o, d) {
    var best = Infinity, hitBox = null, i, b, lo, hi, a, t1, t2, inv, ax;
    for (i = 0; i < scene.length; i++) {
      b = scene[i]; lo = -Infinity; hi = Infinity;
      for (ax = 0; ax < 3; ax++) {
        if (Math.abs(d[ax]) < 1e-9) { if (o[ax] < b.min[ax] || o[ax] > b.max[ax]) { lo = Infinity; break; } continue; }
        inv = 1 / d[ax];
        t1 = (b.min[ax] - o[ax]) * inv; t2 = (b.max[ax] - o[ax]) * inv;
        a = Math.min(t1, t2); t2 = Math.max(t1, t2);
        if (a > lo) lo = a;
        if (t2 < hi) hi = t2;
        if (lo > hi) break;
      }
      if (lo <= hi && lo > 0.01 && lo < best) { best = lo; hitBox = b; }
    }
    return hitBox ? { t: best, b: hitBox } : null;
  }

  var SIM_FOV = 62 * Math.PI / 180;
  var simLive = null;
  /* What a phone would report from here: a depth map and the colours. */
  function simSense(camM, aspect) {
    var SU = 96, SV = Math.max(24, Math.round(96 / aspect));
    var ty = Math.tan(SIM_FOV / 2), tx = ty * aspect;
    if (!simLive || simLive.length !== SU * SV) simLive = new Float32Array(SU * SV);
    var o = [camM[12], camM[13], camM[14]], n = 0, i, j, cx, cy, d, h, k;
    for (j = 0; j < SV; j++) {
      for (i = 0; i < SU; i++) {
        cx = ((i + 0.5) / SU * 2 - 1) * tx;
        cy = (1 - (j + 0.5) / SV * 2) * ty;
        d = [camM[0] * cx + camM[4] * cy - camM[8], camM[1] * cx + camM[5] * cy - camM[9], camM[2] * cx + camM[6] * cy - camM[10]];
        h = cast(o, d);
        simLive[j * SU + i] = h && h.t < 5.5 ? h.t : 0;
        if (!h || h.t > 5.5 || phase !== 'scan') continue;
        k = n * 3;
        PTS[k] = o[0] + d[0] * h.t; PTS[k + 1] = o[1] + d[1] * h.t; PTS[k + 2] = o[2] + d[2] * h.t;
        RGB[k] = h.b.c[0]; RGB[k + 1] = h.b.c[1]; RGB[k + 2] = h.b.c[2];
        n++;
      }
    }
    if (phase === 'scan') World.ingest(o, PTS, RGB, n, now);
    if (phase === 'live' && view === 'camera') uploadLive(simLive, SU, SV, null);
  }

  function simFrame(t) {
    if (!sim) return;
    simRaf = requestAnimationFrame(simFrame);
    var dt = Math.min(0.05, (t - simLast) / 1000 || 0);
    simLast = t;
    now = t / 1000; frames++;

    var f = (keys.w || keys.arrowup || keys.fwd ? 1 : 0) - (keys.s || keys.arrowdown || keys.back ? 1 : 0);
    var st = (keys.d ? 1 : 0) - (keys.a ? 1 : 0);
    var turn = (keys.arrowleft || keys.left ? 1 : 0) - (keys.arrowright || keys.right ? 1 : 0);
    simPose.yaw += turn * 1.6 * dt;
    var sy = Math.sin(simPose.yaw), cy = Math.cos(simPose.yaw);
    simPose.p[0] = Math.max(-2.3, Math.min(2.3, simPose.p[0] + (-sy * f + cy * st) * 1.3 * dt));
    simPose.p[2] = Math.max(-2.8, Math.min(2.8, simPose.p[2] + (-cy * f - sy * st) * 1.3 * dt));

    movePerson(now);
    uploadScene();
    resize();
    var aspect = canvas.width / canvas.height;
    var camM = poseMatrix(simPose.p, simPose.yaw, simPose.pitch);
    eyePos = simPose.p.slice();
    simSense(camM, aspect);
    rebuild(false);
    drawFrame(null, [0, 0, canvas.width, canvas.height], camM, perspective(SIM_FOV, aspect, 0.05, 40));
  }

  function resize() {
    var d = Math.min(2, window.devicePixelRatio || 1);
    var w = Math.round(canvas.clientWidth * d), h = Math.round(canvas.clientHeight * d);
    if (w && h && (canvas.width !== w || canvas.height !== h)) { canvas.width = w; canvas.height = h; }
  }

  function startSim() {
    note('');
    sim = true;
    simPose = { p: [0, 1.5, 0.3], yaw: 0, pitch: -0.15 };
    view = S().view === 'camera' ? 'camera' : 'blocks';
    colour = true;
    live.ok = false;
    World.reset(blockSize(), simPose.p);
    vao.blocks.count = 0;
    setPhase('scan');
    simLast = performance.now();
    cancelAnimationFrame(simRaf);
    simRaf = requestAnimationFrame(simFrame);
  }
  function stopSim() {
    sim = false;
    cancelAnimationFrame(simRaf);
    keys = {};
    setPhase('off');
  }

  function bindSimInput() {
    window.addEventListener('keydown', function (e) {
      if (!sim) return;
      var k = e.key.toLowerCase();
      if (k === 'escape') { quit(); return; }
      if (k === 'enter') { if (phase === 'scan') done(); else toggleView(); return; }
      keys[k] = true;
      if (k.indexOf('arrow') === 0) e.preventDefault();
    });
    window.addEventListener('keyup', function (e) { keys[e.key.toLowerCase()] = false; });
    var down = false, lx = 0, ly = 0, lastTap = 0;
    canvas.addEventListener('pointerdown', function (e) {
      down = true; lx = e.clientX; ly = e.clientY;
      var t = performance.now();
      if (sim && t - lastTap < 380) { lastTap = 0; if (phase === 'scan') done(); else toggleView(); }
      else lastTap = t;
    });
    window.addEventListener('pointermove', function (e) {
      if (!down || !sim) return;
      simPose.yaw -= (e.clientX - lx) * 0.005;
      simPose.pitch = Math.max(-1.3, Math.min(1.3, simPose.pitch - (e.clientY - ly) * 0.005));
      lx = e.clientX; ly = e.clientY;
    });
    window.addEventListener('pointerup', function () { down = false; });
    document.querySelectorAll('[data-pad]').forEach(function (b) {
      var k = b.dataset.pad;
      function on(e) { keys[k] = true; e.preventDefault(); }
      function off() { keys[k] = false; }
      b.addEventListener('pointerdown', on);
      b.addEventListener('pointerup', off);
      b.addEventListener('pointerleave', off);
      b.addEventListener('pointercancel', off);
    });
  }

  /* ---------- boot ---------- */

  async function boot() {
    var err = initGL();
    if (err) { note(err); $('#btnWalk').disabled = true; $('#btnWalkSim').disabled = true; return; }
    World.reset(blockSize(), [0, 0, 0]);

    $('#btnWalk').addEventListener('click', startXR);
    $('#btnWalkSim').addEventListener('click', startSim);
    $('#wDone').addEventListener('click', done);
    $('#wView').addEventListener('click', toggleView);
    $('#wRescan').addEventListener('click', rescan);
    $('#wQuit').addEventListener('click', quit);
    /* Taps on the buttons are button presses, not "two taps on the screen". */
    $('#walkUi').querySelectorAll('button').forEach(function (b) {
      b.addEventListener('beforexrselect', function (e) { e.preventDefault(); });
    });
    bindSimInput();

    var r = await probe();
    $('#xrNote').textContent = r.ok ? 'This phone can track you walking.' : r.why;
    $('#btnWalk').disabled = !r.ok;

    window.WALK = {
      state: function () {
        return {
          phase: phase, view: view, sim: sim, frames: frames, colour: colour,
          stats: World.stats(), drawn: vao.blocks.count, live: live.ok,
          pose: { p: simPose.p.slice(), yaw: simPose.yaw, pitch: simPose.pitch }
        };
      },
      pose: function (x, z, yaw, pitch) {
        simPose.p[0] = x; simPose.p[2] = z;
        if (yaw !== undefined) simPose.yaw = yaw;
        if (pitch !== undefined) simPose.pitch = pitch;
      },
      person: function () { return { min: person.min.slice(), max: person.max.slice() }; },
      freezePerson: function (x, z) {
        movePerson = function () {
          person.min = [x - 0.22, 0, z - 0.14];
          person.max = [x + 0.22, 1.74, z + 0.14];
        };
      },
      start: startSim, done: done, rescan: rescan, quit: quit,
      setView: function (v) { view = v; status(); }
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
