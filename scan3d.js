/* KEMOSH — the pretend room's shape, for the turn-on-the-spot demo.
 *
 * Turning on the spot can only see one surface per direction, so a room is
 * stored for that mode as one distance per direction. This ray-casts a room
 * with furniture in it into exactly that form, so the older demo draws a
 * measured room rather than a guessed box. Measuring a real room is now done
 * by walking (walk.js), which stores it as blocks in 3D instead.
 */
(function (global) {
  'use strict';

  var W, H, MAXD;
  var near = null, hits = null, out = null;

  function ensure() {
    if (near) return;
    W = VR.DEPTH_W; H = VR.DEPTH_H; MAXD = VR.DEPTH_MAX;
    near = new Float32Array(W * H);
    hits = new Uint16Array(W * H);
    out = new Uint8Array(W * H * 4);
  }

  function reset() {
    near.fill(0); hits.fill(0); out.fill(0);
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

  global.Scan3D = { synthetic: synthetic };
}(window));
