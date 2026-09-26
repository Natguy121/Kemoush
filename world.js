/* KEMOSH — the room as blocks you can walk through.
 *
 * The old room was one photograph per direction, taken from one spot. That is
 * why it fell apart the moment you took a step: everything in it was stored as
 * "what you see this way", not "what is over there". This stores the second
 * thing. Space is a lattice of blocks fixed to the room, and each one is solid
 * or empty and has a colour, wherever you happen to be standing.
 *
 * It fills from what an AR session hands over each frame: where the phone is,
 * how far away every part of the picture is, and (where the phone allows it)
 * what colour it is. A point at the end of a sight line is a vote for "solid
 * here"; the space the sight line passed through on the way is a vote for
 * "empty". So a person who stood in front of the wardrobe and then walked off
 * is removed as soon as you see the wardrobe through where they were — they
 * are never kept as part of the room.
 *
 * Y is up and distances are metres, the same as WebXR, so nothing between the
 * phone and this file has to swap axes.
 */
(function (global) {
  'use strict';

  var NX = 160, NY = 64, NZ = 160;
  var N = NX * NY * NZ;
  var SOLID = 3;          // score at which a block is drawn
  var MAX = 12;           // cap, so something that moves away can be unlearned
  var BELOW = 2.2;        // metres of room kept below where the scan started

  var s = 0.1, X0 = 0, Y0 = 0, Z0 = 0;
  var score = null, hitAt = null, missAt = null;
  var col = null, wt = null, born = null;
  var cand = null, inCand = null, nCand = 0;
  var frame = 0, dirty = false;
  var inst = null, instCol = null, nInst = 0, columns = null;
  var stats = { solid: 0, blocks: 0, area: 0 };

  function alloc() {
    if (score) return;
    score = new Int8Array(N);
    hitAt = new Uint32Array(N);
    missAt = new Uint32Array(N);
    col = new Uint8Array(N * 3);
    wt = new Uint8Array(N);
    born = new Float32Array(N);
    cand = new Uint32Array(1 << 20);
    inCand = new Uint8Array(N);
    columns = new Uint8Array(NX * NZ);
  }

  /* Start empty, with the lattice centred on where the phone is now. */
  function reset(size, eye) {
    alloc();
    s = size || 0.1;
    eye = eye || [0, 0, 0];
    X0 = eye[0] - NX * s / 2;
    Y0 = eye[1] - BELOW;
    Z0 = eye[2] - NZ * s / 2;
    score.fill(0); hitAt.fill(0); missAt.fill(0);
    col.fill(0); wt.fill(0); born.fill(0); inCand.fill(0);
    nCand = 0; frame = 0; dirty = true; nInst = 0;
    stats = { solid: 0, blocks: 0, area: 0 };
  }

  function index(x, y, z) {
    var ix = Math.floor((x - X0) / s), iy = Math.floor((y - Y0) / s), iz = Math.floor((z - Z0) / s);
    if (ix < 0 || iy < 0 || iz < 0 || ix >= NX || iy >= NY || iz >= NZ) return -1;
    return (iy * NZ + iz) * NX + ix;
  }

  function remember(i) {
    if (inCand[i]) return;
    if (nCand >= cand.length) compact();
    if (nCand >= cand.length) return;
    inCand[i] = 1;
    cand[nCand++] = i;
  }

  /* Drop blocks that have gone back to nothing from the working list. */
  function compact() {
    var j = 0, i, k;
    for (i = 0; i < nCand; i++) {
      k = cand[i];
      if (score[k] > 0) cand[j++] = k; else inCand[k] = 0;
    }
    nCand = j;
  }

  /* One sight line: from the eye to a surface, with the surface's colour if
     the camera gave one. */
  function hit(x, y, z, r, g, b, now) {
    var i = index(x, y, z);
    if (i < 0) return;
    if (hitAt[i] !== frame) {
      hitAt[i] = frame;
      var was = score[i];
      score[i] = Math.min(MAX, was + 2);
      if (was < SOLID && score[i] >= SOLID) { born[i] = now; dirty = true; }
      remember(i);
    }
    if (r >= 0) {
      var w = Math.min(12, wt[i] + 1), k = i * 3;
      wt[i] = w;
      col[k] += Math.round((r - col[k]) / w);
      col[k + 1] += Math.round((g - col[k + 1]) / w);
      col[k + 2] += Math.round((b - col[k + 2]) / w);
      if (score[i] >= SOLID) dirty = true;
    }
  }

  /* Everything a sight line passed through on its way is empty. Walks the
     lattice block by block, stopping short of the surface so a wall is not
     worn away by the sight lines that land on it at a glancing angle. */
  function carve(ox, oy, oz, px, py, pz) {
    var gx = (ox - X0) / s, gy = (oy - Y0) / s, gz = (oz - Z0) / s;
    var dx = (px - X0) / s - gx, dy = (py - Y0) / s - gy, dz = (pz - Z0) / s - gz;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    var stop = len - 2;
    if (stop <= 0) return;
    dx /= len; dy /= len; dz /= len;
    var ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
    var sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    var tdx = dx ? Math.abs(1 / dx) : Infinity, tdy = dy ? Math.abs(1 / dy) : Infinity, tdz = dz ? Math.abs(1 / dz) : Infinity;
    var tx = dx ? (dx > 0 ? ix + 1 - gx : gx - ix) * tdx : Infinity;
    var ty = dy ? (dy > 0 ? iy + 1 - gy : gy - iy) * tdy : Infinity;
    var tz = dz ? (dz > 0 ? iz + 1 - gz : gz - iz) * tdz : Infinity;
    var t = 0, n = 0, i, was;
    while (t < stop && n++ < 400) {
      if (ix >= 0 && iy >= 0 && iz >= 0 && ix < NX && iy < NY && iz < NZ) {
        i = (iy * NZ + iz) * NX + ix;
        if (score[i] > 0 && hitAt[i] !== frame && missAt[i] !== frame) {
          missAt[i] = frame;
          was = score[i];
          score[i] = was - 1;
          if (was >= SOLID && score[i] < SOLID) { born[i] = 0; dirty = true; }
        }
      }
      if (tx < ty && tx < tz) { t = tx; tx += tdx; ix += sx; }
      else if (ty < tz) { t = ty; ty += tdy; iy += sy; }
      else { t = tz; tz += tdz; iz += sz; }
    }
  }

  /* A frame's worth of sight lines. pts is x,y,z per point; rgb is r,g,b per
     point, or null when this phone gives shape but no colour. */
  function ingest(eye, pts, rgb, count, now) {
    frame++;
    var i, k;
    for (i = 0; i < count; i++) {
      k = i * 3;
      if (rgb) hit(pts[k], pts[k + 1], pts[k + 2], rgb[k], rgb[k + 1], rgb[k + 2], now);
      else hit(pts[k], pts[k + 1], pts[k + 2], -1, 0, 0, now);
    }
    /* Carving is the expensive half; a third of the sight lines is plenty to
       clear someone out within a second of looking past them. */
    for (i = frame % 3; i < count; i += 3) {
      k = i * 3;
      carve(eye[0], eye[1], eye[2], pts[k], pts[k + 1], pts[k + 2]);
    }
  }

  function solidAt(ix, iy, iz) {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= NX || iy >= NY || iz >= NZ) return false;
    return score[(iy * NZ + iz) * NX + ix] >= SOLID;
  }

  /* The blocks worth drawing: solid, with at least one open face. Buried ones
     can never be seen, and skipping them keeps a big room cheap. */
  function build() {
    if (!dirty) return false;
    dirty = false;
    if (nCand > cand.length * 0.75) compact();
    var cap = nCand;
    if (!inst || inst.length < cap * 4) {
      inst = new Float32Array(Math.max(4096, cap * 4 + 4096));
      instCol = new Uint8Array(inst.length);
    }
    columns.fill(0);
    var solid = 0, area = 0, m = 0, j, i, ix, iy, iz, rest;
    for (j = 0; j < nCand; j++) {
      i = cand[j];
      if (score[i] < SOLID) continue;
      solid++;
      ix = i % NX; rest = (i - ix) / NX; iz = rest % NZ; iy = (rest - iz) / NZ;
      if (!columns[iz * NX + ix]) { columns[iz * NX + ix] = 1; area++; }
      if (solidAt(ix + 1, iy, iz) && solidAt(ix - 1, iy, iz) && solidAt(ix, iy + 1, iz) &&
          solidAt(ix, iy - 1, iz) && solidAt(ix, iy, iz + 1) && solidAt(ix, iy, iz - 1)) continue;
      inst[m * 4] = X0 + ix * s;
      inst[m * 4 + 1] = Y0 + iy * s;
      inst[m * 4 + 2] = Z0 + iz * s;
      inst[m * 4 + 3] = born[i];
      if (wt[i]) {
        instCol[m * 4] = col[i * 3]; instCol[m * 4 + 1] = col[i * 3 + 1]; instCol[m * 4 + 2] = col[i * 3 + 2];
        instCol[m * 4 + 3] = 255;
      } else {
        instCol[m * 4] = instCol[m * 4 + 1] = instCol[m * 4 + 2] = 236;
        instCol[m * 4 + 3] = 0;
      }
      m++;
    }
    nInst = m;
    stats = { solid: solid, blocks: m, area: area * s * s };
    return true;
  }

  global.World = {
    reset: reset,
    ingest: ingest,
    build: build,
    size: function () { return s; },
    instances: function () { return { pos: inst, col: instCol, count: nInst }; },
    stats: function () { return stats; },
    solidAt: function (x, y, z) {
      var i = index(x, y, z);
      return i >= 0 && score[i] >= SOLID;
    },
    colourAt: function (x, y, z) {
      var i = index(x, y, z);
      return i < 0 ? null : [col[i * 3], col[i * 3 + 1], col[i * 3 + 2], wt[i]];
    }
  };
}(typeof window !== 'undefined' ? window : globalThis));
