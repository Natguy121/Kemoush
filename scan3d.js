/* KEMOSH — measuring the room instead of guessing it.
 *
 * Turning on the spot tells you which way you are pointing and nothing else.
 * Every photograph is taken from the same point, so there is no parallax in
 * them and no depth to recover: that is why a guessed box was all the rest of
 * this could offer, and why a bed came out as a bright patch of wall rather
 * than as a bed.
 *
 * An AR session on Android knows where the phone *is* as well as which way it
 * faces, and ARCore will hand over a depth map with it. Angle, location, and
 * what the camera sees — which between them put every pixel at a place in the
 * room. Those places are collected here into one distance per direction,
 * measured out from where you started, which is exactly the shape the renderer
 * already knows how to draw.
 *
 * One standing point can only ever see one surface per direction, so that is
 * all this keeps. Nothing is behind anything else from where you stood, so
 * nothing is lost.
 */
(function (global) {
  'use strict';

  var W, H, UNIT, MAXD;
  var near = null;      // nearest distance seen per direction, room units
  var hits = null;      // how many samples agreed
  var out = null;       // packed RGBA for the renderer
  var session = null, stopping = false;

  function ensure() {
    if (near) return;
    W = VR.DEPTH_W; H = VR.DEPTH_H; UNIT = VR.DEPTH_UNIT; MAXD = VR.DEPTH_MAX;
    near = new Float32Array(W * H);
    hits = new Uint16Array(W * H);
    out = new Uint8Array(W * H * 4);
    reset();
  }

  function reset() {
    near.fill(0); hits.fill(0); out.fill(0);
  }

  /* ---------- small 4x4 helpers (column-major, as WebXR hands them over) --- */

  function mulVec4(m, v) {
    return [
      m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12] * v[3],
      m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13] * v[3],
      m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14] * v[3],
      m[3] * v[0] + m[7] * v[1] + m[11] * v[2] + m[15] * v[3]
    ];
  }

  function invert(m) {
    var i, inv = new Float32Array(16), det;
    inv[0] = m[5]*m[10]*m[15] - m[5]*m[11]*m[14] - m[9]*m[6]*m[15] + m[9]*m[7]*m[14] + m[13]*m[6]*m[11] - m[13]*m[7]*m[10];
    inv[4] = -m[4]*m[10]*m[15] + m[4]*m[11]*m[14] + m[8]*m[6]*m[15] - m[8]*m[7]*m[14] - m[12]*m[6]*m[11] + m[12]*m[7]*m[10];
    inv[8] = m[4]*m[9]*m[15] - m[4]*m[11]*m[13] - m[8]*m[5]*m[15] + m[8]*m[7]*m[13] + m[12]*m[5]*m[11] - m[12]*m[7]*m[9];
    inv[12] = -m[4]*m[9]*m[14] + m[4]*m[10]*m[13] + m[8]*m[5]*m[14] - m[8]*m[6]*m[13] - m[12]*m[5]*m[10] + m[12]*m[6]*m[9];
    inv[1] = -m[1]*m[10]*m[15] + m[1]*m[11]*m[14] + m[9]*m[2]*m[15] - m[9]*m[3]*m[14] - m[13]*m[2]*m[11] + m[13]*m[3]*m[10];
    inv[5] = m[0]*m[10]*m[15] - m[0]*m[11]*m[14] - m[8]*m[2]*m[15] + m[8]*m[3]*m[14] + m[12]*m[2]*m[11] - m[12]*m[3]*m[10];
    inv[9] = -m[0]*m[9]*m[15] + m[0]*m[11]*m[13] + m[8]*m[1]*m[15] - m[8]*m[3]*m[13] - m[12]*m[1]*m[11] + m[12]*m[3]*m[9];
    inv[13] = m[0]*m[9]*m[14] - m[0]*m[10]*m[13] - m[8]*m[1]*m[14] + m[8]*m[2]*m[13] + m[12]*m[1]*m[10] - m[12]*m[2]*m[9];
    inv[2] = m[1]*m[6]*m[15] - m[1]*m[7]*m[14] - m[5]*m[2]*m[15] + m[5]*m[3]*m[14] + m[13]*m[2]*m[7] - m[13]*m[3]*m[6];
    inv[6] = -m[0]*m[6]*m[15] + m[0]*m[7]*m[14] + m[4]*m[2]*m[15] - m[4]*m[3]*m[14] - m[12]*m[2]*m[7] + m[12]*m[3]*m[6];
    inv[10] = m[0]*m[5]*m[15] - m[0]*m[7]*m[13] - m[4]*m[1]*m[15] + m[4]*m[3]*m[13] + m[12]*m[1]*m[7] - m[12]*m[3]*m[5];
    inv[14] = -m[0]*m[5]*m[14] + m[0]*m[6]*m[13] + m[4]*m[1]*m[14] - m[4]*m[2]*m[13] - m[12]*m[1]*m[6] + m[12]*m[2]*m[5];
    inv[3] = -m[1]*m[6]*m[11] + m[1]*m[7]*m[10] + m[5]*m[2]*m[11] - m[5]*m[3]*m[10] - m[9]*m[2]*m[7] + m[9]*m[3]*m[6];
    inv[7] = m[0]*m[6]*m[11] - m[0]*m[7]*m[10] - m[4]*m[2]*m[11] + m[4]*m[3]*m[10] + m[8]*m[2]*m[7] - m[8]*m[3]*m[6];
    inv[11] = -m[0]*m[5]*m[11] + m[0]*m[7]*m[9] + m[4]*m[1]*m[11] - m[4]*m[3]*m[9] - m[8]*m[1]*m[7] + m[8]*m[3]*m[5];
    inv[15] = m[0]*m[5]*m[10] - m[0]*m[6]*m[9] - m[4]*m[1]*m[10] + m[4]*m[2]*m[9] + m[8]*m[1]*m[6] - m[8]*m[2]*m[5];
    det = m[0]*inv[0] + m[1]*inv[4] + m[2]*inv[8] + m[3]*inv[12];
    if (!det) return null;
    det = 1.0 / det;
    for (i = 0; i < 16; i++) inv[i] *= det;
    return inv;
  }

  /* ---------- collecting ---------- */

  /* A point in the room, in room units, folded into the direction it lies in.
     Nearest wins: a chair in front of a wall is the thing you can see. */
  function add(x, y, z) {
    var r = Math.sqrt(x*x + y*y + z*z);
    if (r < 0.03 || r > MAXD) return false;
    var u = Math.atan2(y, x) / (Math.PI * 2) + 0.5;
    var v = Math.asin(Math.max(-1, Math.min(1, z / r))) / Math.PI + 0.5;
    var px = Math.min(W - 1, Math.max(0, Math.floor(u * W)));
    var py = Math.min(H - 1, Math.max(0, Math.floor(v * H)));
    var i = py * W + px;
    if (hits[i] === 0 || r < near[i]) near[i] = r;
    if (hits[i] < 60000) hits[i]++;
    return true;
  }

  /* Pack for the renderer, and spread a little sideways: a depth map read off a
     phone is coarser than the panorama it lands in, so untouched directions
     between two measured ones are filled from their neighbours rather than
     left as holes for the guessed box to show through. */
  function pack() {
    var i, x, y, n, d, best, bestD, dx, dy, j;
    for (i = 0; i < W * H; i++) {
      n = hits[i];
      out[i * 4] = n ? Math.max(1, Math.min(255, Math.round(near[i] / MAXD * 255))) : 0;
      out[i * 4 + 1] = 0;
      out[i * 4 + 2] = 0;
      out[i * 4 + 3] = n ? Math.min(255, Math.round(Math.min(1, n / 4) * 255)) : 0;
    }
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        i = y * W + x;
        if (hits[i]) continue;
        best = 0; bestD = 0;
        for (dy = -1; dy <= 1; dy++) {
          for (dx = -1; dx <= 1; dx++) {
            var nx = x + dx, ny = y + dy;
            if (ny < 0 || ny >= H) continue;
            nx = (nx + W) % W;
            j = ny * W + nx;
            if (!hits[j]) continue;
            best++; bestD += near[j];
          }
        }
        if (best >= 4) {
          out[i * 4] = Math.max(1, Math.min(255, Math.round(bestD / best / MAXD * 255)));
          out[i * 4 + 3] = Math.round(0.6 * 255);
        }
      }
    }
    return out;
  }

  function covered() {
    var i, n = 0;
    for (i = 0; i < W * H; i++) if (hits[i]) n++;
    return n / (W * H);
  }

  /* ---------- the synthetic room, for checking the drawing without a phone --- */

  /* Ray-casts a room with furniture in it and stores the distances exactly as a
     real scan would, so everything downstream is exercised for real. */
  function synthetic() {
    ensure();
    reset();
    // axis-aligned boxes, in room units, eye at the origin: room, then things in it
    var things = [
      { min: [-1.0, -1.0, -0.62], max: [1.0, 1.0, 0.42], hollow: true },   // the room
      { min: [0.20, 0.10, -0.62], max: [0.95, 0.80, -0.28] },              // bed
      { min: [-0.95, -0.30, -0.62], max: [-0.60, 0.35, -0.30] },           // desk
      { min: [-0.30, -0.95, -0.62], max: [0.25, -0.60, -0.38] },           // table
      { min: [0.55, -0.90, -0.62], max: [0.90, -0.55, -0.10] }             // wardrobe
    ];
    var x, y, i, t;
    for (y = 0; y < H; y++) {
      for (x = 0; x < W; x++) {
        var lon = ((x + 0.5) / W - 0.5) * Math.PI * 2;
        var lat = ((y + 0.5) / H - 0.5) * Math.PI;
        var c = Math.cos(lat);
        var d = [c * Math.cos(lon), c * Math.sin(lon), Math.sin(lat)];
        var best = Infinity;
        for (i = 0; i < things.length; i++) {
          t = rayBox(d, things[i]);
          if (t > 0.02 && t < best) best = t;
        }
        if (best === Infinity) continue;
        var k = y * W + x;
        near[k] = best;
        hits[k] = 8;
      }
    }
    return pack();
  }

  /* Distance from the origin to a box along d: the far side if we are inside
     it (the room), the near side if we are outside it (the furniture). */
  function rayBox(d, box) {
    var lo = -Infinity, hi = Infinity, i, a, b, inv, t1, t2;
    for (i = 0; i < 3; i++) {
      if (Math.abs(d[i]) < 1e-6) {
        if (0 < box.min[i] || 0 > box.max[i]) return -1;
        continue;
      }
      inv = 1 / d[i];
      t1 = (box.min[i] - 0) * inv;
      t2 = (box.max[i] - 0) * inv;
      a = Math.min(t1, t2); b = Math.max(t1, t2);
      if (a > lo) lo = a;
      if (b < hi) hi = b;
      if (lo > hi) return -1;
    }
    return box.hollow ? hi : (lo > 0 ? lo : -1);
  }

  /* ---------- what this phone can actually do ---------- */

  async function probe() {
    var r = {
      secure: !!global.isSecureContext,
      webxr: !!(global.navigator && navigator.xr),
      ar: false, error: ''
    };
    if (!r.webxr) {
      r.error = 'This browser has no WebXR at all. On iPhone that is expected — Safari has never shipped it.';
      return r;
    }
    try {
      r.ar = await navigator.xr.isSessionSupported('immersive-ar');
    } catch (e) { r.error = String(e && e.message || e); }
    if (!r.ar && !r.error) r.error = 'This phone reports no AR support. On Android that usually means Google Play Services for AR is missing.';
    return r;
  }

  /* ---------- the scan itself ---------- */

  async function run(gl, overlayEl, onUpdate) {
    ensure();
    reset();
    stopping = false;

    var init = {
      requiredFeatures: ['depth-sensing'],
      optionalFeatures: ['dom-overlay', 'local-floor'],
      depthSensing: {
        usagePreference: ['cpu-optimized'],
        dataFormatPreference: ['luminance-alpha', 'unsigned-short', 'float32']
      }
    };
    if (overlayEl) init.domOverlay = { root: overlayEl };

    try {
      session = await navigator.xr.requestSession('immersive-ar', init);
    } catch (e) {
      /* Depth is the whole point, so say so rather than starting a session
         that cannot measure anything. */
      throw new Error('Could not start a depth-sensing AR session: ' +
        (e && e.message || e) + '. The phone may not offer the depth feature.');
    }

    try { await gl.makeXRCompatible(); } catch (e) {}
    session.updateRenderState({ baseLayer: new global.XRWebGLLayer(session, gl) });
    var space = await session.requestReferenceSpace('local');

    var frames = 0, points = 0, lastPush = 0, ended = false;
    var report = {
      format: session.depthDataFormat || '?',
      usage: session.depthUsage || '?',
      depthFrames: 0, points: 0, covered: 0, note: ''
    };

    return new Promise(function (resolve) {
      function finish() {
        if (ended) return;
        ended = true;
        report.points = points;
        report.covered = covered();
        resolve(report);
      }
      session.addEventListener('end', finish);

      session.requestAnimationFrame(function loop(time, frame) {
        if (stopping) { try { session.end(); } catch (e) {} return; }
        session.requestAnimationFrame(loop);
        frames++;

        var pose = frame.getViewerPose(space);
        if (!pose) { report.note = 'waiting for tracking'; return; }

        var got = 0;
        for (var vi = 0; vi < pose.views.length; vi++) {
          var view = pose.views[vi];
          var info = null;
          try { info = frame.getDepthInformation(view); } catch (e) { report.note = String(e && e.message || e); }
          if (!info) continue;
          got++;
          points += sampleView(view, info);
        }
        if (got) report.depthFrames++;
        else if (!report.note) report.note = 'no depth on this frame';

        if (time - lastPush > 250) {
          lastPush = time;
          VR.uploadDepth(pack());
          report.points = points;
          report.covered = covered();
          if (onUpdate) onUpdate(report);
        }
      });
    });
  }

  /* One view's depth map, turned into places in the room.

     WebXR is Y-up with -Z forward; the room this feeds is Z-up. The swap is
     done once, here, rather than left for everything downstream to remember. */
  var STEP = 3;   // every third depth texel is plenty and keeps a frame cheap

  function sampleView(view, info) {
    var invP = invert(view.projectionMatrix);
    if (!invP) return 0;
    var m = view.transform.matrix;          // camera -> reference space
    var w = info.width, h = info.height, n = 0;
    for (var iy = 0; iy < h; iy += STEP) {
      for (var ix = 0; ix < w; ix += STEP) {
        var u = (ix + 0.5) / w, v = (iy + 0.5) / h;
        var dist;
        try { dist = info.getDepthInMeters(u, v); } catch (e) { continue; }
        if (!(dist > 0.15) || dist > 8) continue;

        var q = mulVec4(invP, [u * 2 - 1, v * 2 - 1, -1, 1]);
        if (!q[3]) continue;
        var rx = q[0] / q[3], ry = q[1] / q[3], rz = q[2] / q[3];
        var rl = Math.sqrt(rx*rx + ry*ry + rz*rz);
        if (!rl || rz >= 0) continue;
        rx /= rl; ry /= rl; rz /= rl;
        // walk that ray until it is `dist` metres ahead of the view plane
        var t = -dist / rz;
        var p = mulVec4(m, [rx * t, ry * t, rz * t, 1]);
        // XR (x right, y up, -z forward) -> room (x, y, z up), and into units
        if (add(p[0] / UNIT, -p[2] / UNIT, p[1] / UNIT)) n++;
      }
    }
    return n;
  }

  function stop() { stopping = true; try { if (session) session.end(); } catch (e) {} }

  global.Scan3D = {
    probe: probe,
    run: run,
    stop: stop,
    synthetic: synthetic,
    reset: function () { ensure(); reset(); },
    covered: function () { ensure(); return covered(); },
    packed: function () { ensure(); return pack(); }
  };
}(window));
