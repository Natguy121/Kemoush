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
 * Blocks are a few centimetres across, so a whole room's worth of lattice would
 * not fit in a phone. Almost all of a room is air, though, and air is never
 * stored: the lattice is cut into chunks of 16×16×16 blocks, and a chunk only
 * comes into being when something is measured inside it.
 *
 * Y is up and distances are metres, the same as WebXR, so nothing between the
 * phone and this file has to swap axes.
 */
(function (global) {
  'use strict';

  var C = 16, C3 = C * C * C;           // blocks along a chunk's edge, and in one
  var SOLID = 3;                        // score at which a block is drawn
  var MAX = 12;                         // cap, so something that moves away can be unlearned
  var SPAN = 14, HEIGHT = 5, BELOW = 2.2; // metres of room kept around the start
  var MAX_CHUNKS = 3000;

  var s = 0.03, X0 = 0, Y0 = 0, Z0 = 0, T0 = 0;
  var NX, NY, NZ, CX, CY, CZ;
  var table = null;                     // chunk slot per chunk position, -1 = air
  var chunks = [];
  var colCount = null;                  // solid blocks per (x, z) column, for area
  var frame = 0, full = false;
  var dirty = [];                       // chunk slots whose faces need redoing
  var solid = 0, columns = 0;
  var out = { pos: new Float32Array(0), col: new Uint8Array(0), count: 0 };

  function Chunk(cx, cy, cz) {
    this.cx = cx; this.cy = cy; this.cz = cz;
    this.score = new Int8Array(C3);
    this.stamp = new Uint8Array(C3);    // which frame last touched it, and how
    this.col = new Uint8Array(C3 * 3);
    this.wt = new Uint8Array(C3);
    this.born = new Uint16Array(C3);    // tenths of a second into the scan
    this.dirty = false;
    this.faces = 0;
    this.fpos = null;
    this.fcol = null;
  }

  /* Start empty, with the lattice centred on where the phone is now. */
  function reset(size, eye, now) {
    s = size || 0.03;
    eye = eye || [0, 0, 0];
    NX = NZ = Math.ceil(SPAN / s / C) * C;
    NY = Math.ceil(HEIGHT / s / C) * C;
    CX = NX / C; CY = NY / C; CZ = NZ / C;
    X0 = eye[0] - NX * s / 2;
    Y0 = eye[1] - BELOW;
    Z0 = eye[2] - NZ * s / 2;
    T0 = now || 0;
    table = new Int32Array(CX * CY * CZ).fill(-1);
    colCount = new Uint16Array(NX * NZ);
    chunks = []; dirty = [];
    frame = 0; full = false; solid = 0; columns = 0;
    out.count = 0;
  }

  function slotOf(ix, iy, iz, make) {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= NX || iy >= NY || iz >= NZ) return -1;
    var t = ((iy >> 4) * CZ + (iz >> 4)) * CX + (ix >> 4);
    var k = table[t];
    if (k >= 0 || !make) return k;
    if (chunks.length >= MAX_CHUNKS) { full = true; return -1; }
    k = chunks.length;
    chunks.push(new Chunk(ix >> 4, iy >> 4, iz >> 4));
    table[t] = k;
    return k;
  }

  function markDirty(k) {
    var ch = chunks[k];
    if (!ch.dirty) { ch.dirty = true; dirty.push(k); }
  }

  /* A block's faces depend on its neighbours, so a change on a chunk's edge
     changes the chunk next door as well. */
  function touched(k, ix, iy, iz) {
    markDirty(k);
    var lx = ix & 15, ly = iy & 15, lz = iz & 15, n;
    if (lx === 0 && (n = slotOf(ix - 1, iy, iz, false)) >= 0) markDirty(n);
    if (lx === 15 && (n = slotOf(ix + 1, iy, iz, false)) >= 0) markDirty(n);
    if (ly === 0 && (n = slotOf(ix, iy - 1, iz, false)) >= 0) markDirty(n);
    if (ly === 15 && (n = slotOf(ix, iy + 1, iz, false)) >= 0) markDirty(n);
    if (lz === 0 && (n = slotOf(ix, iy, iz - 1, false)) >= 0) markDirty(n);
    if (lz === 15 && (n = slotOf(ix, iy, iz + 1, false)) >= 0) markDirty(n);
  }

  function becameSolid(ix, iz) {
    solid++;
    if (colCount[iz * NX + ix]++ === 0) columns++;
  }
  function stoppedSolid(ix, iz) {
    solid--;
    if (--colCount[iz * NX + ix] === 0) columns--;
  }

  /* Frame stamps: which frame (mod 127) last touched a block, times two, plus
     one if that touch was a hit. One byte instead of two arrays. */
  var fs = 1;

  /* One sight line: from the eye to a surface, with the surface's colour if
     the camera gave one. */
  function hit(x, y, z, r, g, b, now) {
    var ix = Math.floor((x - X0) / s), iy = Math.floor((y - Y0) / s), iz = Math.floor((z - Z0) / s);
    var k = slotOf(ix, iy, iz, true);
    if (k < 0) return;
    var ch = chunks[k], i = ((iy & 15) * C + (iz & 15)) * C + (ix & 15);
    var changed = false;
    if ((ch.stamp[i] >> 1) !== fs) {
      ch.stamp[i] = fs * 2 + 1;
      var was = ch.score[i];
      ch.score[i] = Math.min(MAX, was + 2);
      if (was < SOLID && ch.score[i] >= SOLID) {
        ch.born[i] = Math.max(1, Math.min(65535, Math.round((now - T0) * 10)));
        becameSolid(ix, iz);
        changed = true;
      }
    }
    if (r >= 0) {
      var w = Math.min(12, ch.wt[i] + 1), c = i * 3;
      ch.wt[i] = w;
      ch.col[c] += Math.round((r - ch.col[c]) / w);
      ch.col[c + 1] += Math.round((g - ch.col[c + 1]) / w);
      ch.col[c + 2] += Math.round((b - ch.col[c + 2]) / w);
      if (ch.score[i] >= SOLID && !ch.dirty) markDirty(k);
    }
    if (changed) touched(k, ix, iy, iz);
  }

  /* Everything a sight line passed through on its way is empty. Walks the
     lattice block by block, stopping short of the surface so a wall is not
     worn away by the sight lines that land on it at a glancing angle. Whole
     chunks of air are skipped at once. */
  function carve(ox, oy, oz, px, py, pz) {
    var gx = (ox - X0) / s, gy = (oy - Y0) / s, gz = (oz - Z0) / s;
    var dx = (px - X0) / s - gx, dy = (py - Y0) / s - gy, dz = (pz - Z0) / s - gz;
    var len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    var stop = len - 1.5;
    if (stop <= 0) return;
    dx /= len; dy /= len; dz /= len;
    var ix = Math.floor(gx), iy = Math.floor(gy), iz = Math.floor(gz);
    var sx = dx > 0 ? 1 : -1, sy = dy > 0 ? 1 : -1, sz = dz > 0 ? 1 : -1;
    var tdx = dx ? Math.abs(1 / dx) : Infinity, tdy = dy ? Math.abs(1 / dy) : Infinity, tdz = dz ? Math.abs(1 / dz) : Infinity;
    var tx = dx ? (dx > 0 ? ix + 1 - gx : gx - ix) * tdx : Infinity;
    var ty = dy ? (dy > 0 ? iy + 1 - gy : gy - iy) * tdy : Infinity;
    var tz = dz ? (dz > 0 ? iz + 1 - gz : gz - iz) * tdz : Infinity;
    var t = 0, n = 0, k, ch, i, was, st;
    while (t < stop && n++ < 1200) {
      k = slotOf(ix, iy, iz, false);
      if (k >= 0) {
        ch = chunks[k];
        i = ((iy & 15) * C + (iz & 15)) * C + (ix & 15);
        st = ch.stamp[i];
        if (ch.score[i] > 0 && (st >> 1) !== fs) {
          ch.stamp[i] = fs * 2;
          was = ch.score[i];
          ch.score[i] = was - 1;
          if (was >= SOLID && ch.score[i] < SOLID) {
            ch.born[i] = 0;
            stoppedSolid(ix, iz);
            touched(k, ix, iy, iz);
          }
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
    fs = frame % 127 + 1;
    var i, k;
    for (i = 0; i < count; i++) {
      k = i * 3;
      if (rgb) hit(pts[k], pts[k + 1], pts[k + 2], rgb[k], rgb[k + 1], rgb[k + 2], now);
      else hit(pts[k], pts[k + 1], pts[k + 2], -1, 0, 0, now);
    }
    /* Carving is the expensive half; a quarter of the sight lines is plenty to
       clear someone out within a second of looking past them. */
    for (i = frame % 4; i < count; i += 4) {
      k = i * 3;
      carve(eye[0], eye[1], eye[2], pts[k], pts[k + 1], pts[k + 2]);
    }
  }

  function solidIdx(ix, iy, iz) {
    var k = slotOf(ix, iy, iz, false);
    if (k < 0) return false;
    return chunks[k].score[((iy & 15) * C + (iz & 15)) * C + (ix & 15)] >= SOLID;
  }

  /* Face directions, in the order the renderer knows them. */
  var DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  /* Each direction's face as a corner and two edges, in block units. Their
     cross product points out of the block, which is the side that is drawn. */
  var FACES = [
    [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [[0, 0, 0], [0, 0, 1], [0, 1, 0]],
    [[0, 1, 0], [0, 0, 1], [1, 0, 0]], [[0, 0, 0], [1, 0, 0], [0, 0, 1]],
    [[0, 0, 1], [1, 0, 0], [0, 1, 0]], [[0, 0, 0], [0, 1, 0], [1, 0, 0]]
  ];
  var CORNER = [];   // per face, the four corners as bits x | y<<1 | z<<2
  FACES.forEach(function (fc) {
    var o = fc[0], u = fc[1], v = fc[2], out4 = [];
    [[0, 0], [1, 0], [1, 1], [0, 1]].forEach(function (q) {
      var x = o[0] + u[0] * q[0] + v[0] * q[1], y = o[1] + u[1] * q[0] + v[1] * q[1], z = o[2] + u[2] * q[0] + v[2] * q[1];
      out4.push(x | (y << 1) | (z << 2));
    });
    CORNER.push(out4);
  });
  var scratchPos = new Float32Array(C3 * 6 * 16), scratchCol = new Uint8Array(C3 * 6 * 16);

  /* One chunk's visible faces, as four corners each, ready to draw: every
     side of a solid block that faces air. Every corner carries its block's
     position, when it appeared and its colour; which face and which corner it
     is rides in the colour's spare byte. A block with air on all six sides is
     a speck of depth noise, not part of the room, and is left out. */
  function faceChunk(ch) {
    var bx = ch.cx * C, by = ch.cy * C, bz = ch.cz * C;
    var m = 0, lx, ly, lz, i, f, d, open, nOpen, c, r, g, b, painted, bt, x, y, z, k, q, cr;
    var sc = ch.score, P = scratchPos, K = scratchCol;
    for (ly = 0; ly < C; ly++) for (lz = 0; lz < C; lz++) for (lx = 0; lx < C; lx++) {
      i = (ly * C + lz) * C + lx;
      if (sc[i] < SOLID) continue;
      open = 0; nOpen = 0;
      for (f = 0; f < 6; f++) {
        d = DIRS[f];
        var nx = lx + d[0], ny = ly + d[1], nz = lz + d[2], sol;
        if (nx >= 0 && ny >= 0 && nz >= 0 && nx < C && ny < C && nz < C) sol = sc[(ny * C + nz) * C + nx] >= SOLID;
        else sol = solidIdx(bx + nx, by + ny, bz + nz);
        if (!sol) { open |= 1 << f; nOpen++; }
      }
      if (nOpen === 0 || nOpen === 6) continue;
      c = i * 3; painted = ch.wt[i] > 0;
      r = painted ? ch.col[c] : 236; g = painted ? ch.col[c + 1] : 236; b = painted ? ch.col[c + 2] : 236;
      bt = ch.born[i] ? T0 + ch.born[i] / 10 : 0;
      x = X0 + (bx + lx) * s; y = Y0 + (by + ly) * s; z = Z0 + (bz + lz) * s;
      for (f = 0; f < 6; f++) {
        if (!(open & (1 << f))) continue;
        cr = CORNER[f];
        for (q = 0; q < 4; q++) {
          k = (m * 4 + q) * 4;
          P[k] = x; P[k + 1] = y; P[k + 2] = z; P[k + 3] = bt;
          K[k] = r; K[k + 1] = g; K[k + 2] = b; K[k + 3] = f * 8 + cr[q];
        }
        m++;
      }
    }
    ch.faces = m;
    ch.fpos = P.slice(0, m * 16);
    ch.fcol = K.slice(0, m * 16);
    ch.dirty = false;
  }

  /* Redo the faces of the chunks that changed, then lay every chunk's faces
     end to end for the renderer. Returns whether anything changed. */
  function build() {
    if (!dirty.length) return false;
    var i, total = 0, ch, p = 0;
    for (i = 0; i < dirty.length; i++) faceChunk(chunks[dirty[i]]);
    dirty = [];
    for (i = 0; i < chunks.length; i++) total += chunks[i].faces;
    if (out.pos.length < total * 16) {
      out.pos = new Float32Array(Math.ceil(total * 1.5) * 16 + 16384);
      out.col = new Uint8Array(out.pos.length);
    }
    for (i = 0; i < chunks.length; i++) {
      ch = chunks[i];
      if (!ch.faces) continue;
      out.pos.set(ch.fpos, p * 16);
      out.col.set(ch.fcol, p * 16);
      p += ch.faces;
    }
    out.count = p;
    return true;
  }

  function at(x, y, z) {
    var ix = Math.floor((x - X0) / s), iy = Math.floor((y - Y0) / s), iz = Math.floor((z - Z0) / s);
    var k = slotOf(ix, iy, iz, false);
    return k < 0 ? null : { ch: chunks[k], i: ((iy & 15) * C + (iz & 15)) * C + (ix & 15) };
  }

  global.World = {
    reset: reset,
    ingest: ingest,
    build: build,
    size: function () { return s; },
    /* Faces, not blocks: four corners each. Per corner, x, y, z of the block
       and when it appeared; r, g, b, and face * 8 + corner bits. count is
       faces. */
    instances: function () { return out; },
    stats: function () {
      return { solid: solid, faces: out.count, area: columns * s * s, chunks: chunks.length, full: full };
    },
    solidAt: function (x, y, z) {
      var a = at(x, y, z);
      return !!a && a.ch.score[a.i] >= SOLID;
    },
    colourAt: function (x, y, z) {
      var a = at(x, y, z);
      return a ? [a.ch.col[a.i * 3], a.ch.col[a.i * 3 + 1], a.ch.col[a.i * 3 + 2], a.ch.wt[a.i]] : null;
    }
  };
}(typeof window !== 'undefined' ? window : globalThis));
