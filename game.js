/* KEMOSH — the game on top of the seeing.
 *
 * The rule the renderer enforces is that looking at someone removes them. The
 * game is built out of that rule rather than around it: you hunt things you are
 * not allowed to look at. Hold a phantom at the edge of your vision and the lock
 * fills. Turn to face it — the natural thing to do — and you unmake it, the lock
 * empties, and the streak dies.
 */
(function () {
  'use strict';

  var $ = function (s) { return document.querySelector(s); };

  /* ---------- settings ---------- */

  var DEF = {
    fov: 65,        // how wide the camera sees, degrees across the frame
    rot: 0,         // camera rotation vs the screen
    lens: 'light',  // cardboard lens correction
    ipd: 0.06,      // lens centre offset per eye
    sens: 1.0,      // how readily it calls something a person
    erase: 1.0,     // how completely they go
    stereo: true
  };
  var S = Object.assign({}, DEF);
  try {
    var saved = JSON.parse(localStorage.getItem('kemosh') || '{}');
    Object.keys(DEF).forEach(function (k) { if (saved[k] !== undefined) S[k] = saved[k]; });
  } catch (e) { /* first run, or storage is off; defaults are fine */ }
  function save() { try { localStorage.setItem('kemosh', JSON.stringify(S)); } catch (e) {} }

  var LENS = { off: [0, 0], light: [0.16, 0.10], strong: [0.34, 0.24] };

  /* ---------- state ---------- */

  var canvas, video = null, stream = null;
  var mode = 'idle';            // idle | scan | play | over
  var simMode = false;
  var R = null, yaw = 0, pitch = 0;
  var orientOk = false, orient = null, screenAngle = 0;
  var t0 = performance.now(), last = t0, frame = 0;
  var coverage = 0, shake = 0, fade = 1;
  var score = 0, combo = 1, best = 0, timeLeft = 0, banished = 0, level = 0;
  var flash = '', flashUntil = 0;
  var tracks = [], nextId = 1;
  var scanStart = 0;
  var hudCv, hudCtx, hudAt = 0;
  var phantoms = [];
  var primeLeft = 0;
  var lit = 0, stale = 0, trust = 1;

  function litFraction(buf) {
    var n = 0, i;
    for (i = 0; i < buf.length; i += 4) if (buf[i] > 96) n++;
    return n / (buf.length / 4);
  }

  try { best = parseInt(localStorage.getItem('kemosh.best') || '0', 10) || 0; } catch (e) {}

  /* Angles are kept as tangents throughout — same units the shader uses, so
     "is it in the middle of the view" means the same thing in both places. */
  function tanOf(deg) { return Math.tan(deg * Math.PI / 180); }
  var SCAN_TARGET = 0.30;   // share of the sphere worth having before playing
  var MIN_AREA = 0.006;     // smaller than this is speckle, not somebody
  var GAZE_IN = tanOf(3);
  var BAND_OUT = tanOf(40);
  function gazeOut() { return tanOf(14 + Math.min(7, level * 0.5)); }
  function holdTime() { return 1.9 + Math.min(1.4, level * 0.12); }

  /* ---------- the pretend room's occupants ---------- */

  function spawnPhantom() {
    var y = Math.random() * Math.PI * 2;
    return {
      yaw: y, pitch: (Math.random() - 0.5) * 0.28,
      vy: (Math.random() < 0.5 ? -1 : 1) * (0.22 + Math.random() * 0.30),
      size: 0.085 + Math.random() * 0.045,
      turn: 1 + Math.random() * 3,
      dir: [1, 0, 0]
    };
  }
  function stepPhantoms(dt, t) {
    var i, p;
    while (phantoms.length < 4) phantoms.push(spawnPhantom());
    for (i = 0; i < phantoms.length; i++) {
      p = phantoms[i];
      p.turn -= dt;
      if (p.turn <= 0) { p.vy = -p.vy * (0.7 + Math.random() * 0.6); p.turn = 1.5 + Math.random() * 3.5; }
      p.yaw += p.vy * dt;
      p.pitch = Math.sin(t * 0.8 + i) * 0.05 - 0.02;
      var c = Math.cos(p.pitch);
      p.dir = [c * Math.cos(p.yaw), c * Math.sin(p.yaw), Math.sin(p.pitch)];
    }
  }

  /* ---------- finding bodies in the mask ---------- */

  var DW = VR.MASK_W >> 1, DH = VR.MASK_H >> 1;
  var cells = new Uint8Array(DW * DH);
  var labels = new Int32Array(DW * DH);
  var parent = new Int32Array(DW * DH + 1);

  function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
  function union(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }

  function findBlobs(buf, thresh) {
    var W = VR.MASK_W, x, y, i, v;
    for (y = 0; y < DH; y++) {
      for (x = 0; x < DW; x++) {
        i = ((y * 2) * W + x * 2) * 4;
        v = Math.max(buf[i], buf[i + 4], buf[i + W * 4], buf[i + W * 4 + 4]);
        cells[y * DW + x] = v > thresh ? 1 : 0;
        labels[y * DW + x] = 0;
      }
    }
    var next = 1, up, lf, k;
    for (y = 0; y < DH; y++) {
      for (x = 0; x < DW; x++) {
        k = y * DW + x;
        if (!cells[k]) continue;
        /* Eight neighbours, not four: a neck is one cell wide at this
           resolution and four-way connectivity snaps heads off bodies. */
        up = y > 0 ? labels[k - DW] : 0;
        lf = x > 0 ? labels[k - 1] : 0;
        var ul = (y > 0 && x > 0) ? labels[k - DW - 1] : 0;
        var ur = (y > 0 && x < DW - 1) ? labels[k - DW + 1] : 0;
        var lo = 0;
        if (up) lo = lo ? Math.min(lo, up) : up;
        if (lf) lo = lo ? Math.min(lo, lf) : lf;
        if (ul) lo = lo ? Math.min(lo, ul) : ul;
        if (ur) lo = lo ? Math.min(lo, ur) : ur;
        if (!lo) { labels[k] = next; parent[next] = next; next++; }
        else {
          labels[k] = lo;
          if (up) union(lo, up);
          if (lf) union(lo, lf);
          if (ul) union(lo, ul);
          if (ur) union(lo, ur);
        }
      }
    }
    var acc = {}, root, b, out = [];
    for (y = 0; y < DH; y++) {
      for (x = 0; x < DW; x++) {
        k = y * DW + x;
        if (!labels[k]) continue;
        root = find(labels[k]);
        b = acc[root];
        if (!b) { b = acc[root] = { n: 0, sx: 0, sy: 0, x0: x, x1: x, y0: y, y1: y }; }
        b.n++; b.sx += x; b.sy += y;
        if (x < b.x0) b.x0 = x; if (x > b.x1) b.x1 = x;
        if (y < b.y0) b.y0 = y; if (y > b.y1) b.y1 = y;
      }
    }
    Object.keys(acc).forEach(function (key) {
      b = acc[key];
      if (b.n < 7) return;
      var w = (b.x1 - b.x0 + 1) / DW, h = (b.y1 - b.y0 + 1) / DH;
      /* A person is taller than wide and reasonably solid. A stripe of
         mis-registered wall is neither, and this is what throws it out. */
      if (w > 0.62 || h > 0.95) return;
      if (b.n / ((b.x1 - b.x0 + 1) * (b.y1 - b.y0 + 1)) < 0.28) return;
      out.push({
        u: (b.sx / b.n + 0.5) / DW, v: (b.sy / b.n + 0.5) / DH,
        area: b.n / (DW * DH), w: w, h: h,
        x0: b.x0 / DW, x1: (b.x1 + 1) / DW, y0: b.y0 / DH, y1: (b.y1 + 1) / DH
      });
    });
    /* Re-apply the shape test after merging: two pieces that joined into
       something the size of a wall were never a person. */
    return mergeStacked(out).filter(function (o) { return o.w <= 0.62 && o.h <= 0.95; });
  }

  /* One body can still arrive as two pieces — head above, torso below, with a
     gap where an arm or a shadow broke the outline. Two rings on one person
     would be two targets, so put anything stacked and overlapping back
     together. */
  function mergeStacked(bs) {
    var i, j, a, b, merged = true;
    while (merged && bs.length > 1) {
      merged = false;
      for (i = 0; i < bs.length && !merged; i++) {
        for (j = i + 1; j < bs.length; j++) {
          a = bs[i]; b = bs[j];
          var overlapX = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
          var gapY = Math.max(a.y0, b.y0) - Math.min(a.y1, b.y1);
          if (overlapX > 0.3 * Math.min(a.x1 - a.x0, b.x1 - b.x0) && gapY < 0.10) {
            var n = a.area + b.area;
            bs[i] = {
              u: (a.u * a.area + b.u * b.area) / n,
              v: (a.v * a.area + b.v * b.area) / n,
              area: n,
              x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1),
              y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1)
            };
            bs[i].w = bs[i].x1 - bs[i].x0;
            bs[i].h = bs[i].y1 - bs[i].y0;
            bs.splice(j, 1);
            merged = true;
            break;
          }
        }
      }
    }
    return bs;
  }

  var MT = [0.64, 0.36];   // half-angles of the mask, in tangents

  function dirFromUv(u, v) {
    var t = [(u * 2 - 1) * MT[0], (v * 2 - 1) * MT[1]];
    var n = Math.hypot(t[0], t[1], 1);
    return VR.mat3MulVec(R, [t[0] / n, t[1] / n, -1 / n]);
  }

  function tanFromDir(d) {
    var s = VR.mat3MulVec(VR.mat3T(R), d);
    if (s[2] > -0.05) return null;
    return [s[0] / -s[2], s[1] / -s[2]];
  }

  /* ---------- tracking ---------- */

  function updateTracks(blobs, dt) {
    var i, j, tr, b, bestJ, bestD, d;
    for (i = 0; i < tracks.length; i++) tracks[i].matched = false;
    var used = new Array(blobs.length);

    for (i = 0; i < tracks.length; i++) {
      tr = tracks[i];
      bestJ = -1; bestD = 0.17;
      for (j = 0; j < blobs.length; j++) {
        if (used[j]) continue;
        d = Math.hypot(blobs[j].u - tr.u, blobs[j].v - tr.v);
        if (d < bestD) { bestD = d; bestJ = j; }
      }
      if (bestJ >= 0) {
        b = blobs[bestJ]; used[bestJ] = true;
        tr.u += (b.u - tr.u) * 0.5;
        tr.v += (b.v - tr.v) * 0.5;
        tr.area = tr.area * 0.7 + b.area * 0.3;
        tr.matched = true; tr.miss = 0; tr.age += dt;
      } else {
        tr.miss += dt;
      }
    }
    for (j = 0; j < blobs.length; j++) {
      if (used[j]) continue;
      tracks.push({ id: nextId++, u: blobs[j].u, v: blobs[j].v, area: blobs[j].area, age: 0, miss: 0, charge: 0, matched: true, gone: 0 });
    }
    tracks = tracks.filter(function (t) { return t.miss < 0.8 && t.gone <= 0; });
    if (tracks.length > 8) {
      tracks.sort(function (a, b2) { return b2.area - a.area; });
      tracks.length = 8;
    }
    /* Where each one is, in the world, so it stays put while the head turns. */
    for (i = 0; i < tracks.length; i++) {
      if (tracks[i].matched) tracks[i].dir = dirFromUv(tracks[i].u, tracks[i].v);
    }
  }

  function say(msg) { flash = msg; flashUntil = performance.now() + 1400; }

  function scoreTracks(dt) {
    var i, tr, t, mag, go = gazeOut(), rate = 1 / holdTime(), w;
    for (i = 0; i < tracks.length; i++) {
      tr = tracks[i];
      if (!tr.dir || tr.age < 0.25 || tr.area < MIN_AREA) continue;
      t = tanFromDir(tr.dir);
      mag = t ? Math.hypot(t[0], t[1]) : 99;
      if (!tr.matched) {
        tr.charge = Math.max(0, tr.charge - 0.22 * dt);
        tr.look = 0;
      } else if (mag < go) {
        /* You looked. It is being taken apart, and so is the lock. */
        if (tr.charge > 0.12) { say('BLINKED'); combo = 1; }
        tr.charge = Math.max(0, tr.charge - 1.1 * dt);
        tr.look = -1;
        shake = Math.min(0.012, shake + dt * 0.02);
      } else if (mag < BAND_OUT) {
        w = Math.min(1, (mag - go) / (go * 0.7)) * (1 - Math.max(0, (mag - BAND_OUT * 0.62) / (BAND_OUT * 0.38)));
        tr.charge = Math.min(1, tr.charge + Math.max(0.15, w) * rate * dt);
        tr.look = 1;
        if (tr.charge >= 1) {
          banished++; level++;
          score += Math.round(100 * combo);
          timeLeft = Math.min(120, timeLeft + 4);
          say('BANISHED  ×' + combo);
          combo = Math.min(9, combo + 1);
          tr.gone = 1;
        }
      } else {
        tr.charge = Math.max(0, tr.charge - 0.12 * dt);
        tr.look = 0;
      }
    }
  }

  /* ---------- the bar you read through the lenses ---------- */

  function drawHud(now) {
    if (now - hudAt < 160) return;
    hudAt = now;
    var c = hudCtx, W = hudCv.width, H = hudCv.height;
    c.clearRect(0, 0, W, H);
    c.fillStyle = 'rgba(4,6,10,0.62)';
    c.beginPath();
    var r = 26;
    c.moveTo(r, 4); c.arcTo(W - 4, 4, W - 4, H - 4, r); c.arcTo(W - 4, H - 4, 4, H - 4, r);
    c.arcTo(4, H - 4, 4, 4, r); c.arcTo(4, 4, W - 4, 4, r); c.closePath(); c.fill();
    c.textBaseline = 'middle';
    if (mode === 'scan') {
      c.fillStyle = '#dfe9f5';
      c.font = '600 27px ui-sans-serif, system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText('Turn slowly. Nobody in front of you.', W / 2, 44);
      c.fillStyle = 'rgba(255,255,255,0.14)';
      c.fillRect(90, 82, W - 180, 14);
      c.fillStyle = '#5ad1ff';
      c.fillRect(90, 82, (W - 180) * Math.min(1, coverage / 0.42), 14);
    } else if (mode === 'play') {
      c.textAlign = 'left';
      c.fillStyle = '#9fb3c8';
      c.font = '600 22px ui-sans-serif, system-ui, sans-serif';
      c.fillText('SCORE', 30, 26);
      c.fillStyle = '#ffffff';
      c.font = '700 46px ui-sans-serif, system-ui, sans-serif';
      c.fillText(String(score), 30, 66);
      c.textAlign = 'right';
      c.fillStyle = '#9fb3c8';
      c.font = '600 22px ui-sans-serif, system-ui, sans-serif';
      c.fillText('TIME', W - 30, 26);
      c.fillStyle = timeLeft < 10 ? '#ff6b5e' : '#ffffff';
      c.font = '700 46px ui-sans-serif, system-ui, sans-serif';
      c.fillText(timeLeft.toFixed(0) + 's', W - 30, 66);
      c.textAlign = 'center';
      if (stale > 1.5) {
        c.fillStyle = '#ffc46b';
        c.font = '600 25px ui-sans-serif, system-ui, sans-serif';
        c.fillText('the room changed — relearning it', W / 2, 56);
      } else if (now < flashUntil) {
        c.fillStyle = flash.indexOf('BLINK') === 0 ? '#ff6b5e' : '#7dffb0';
        c.font = '700 34px ui-sans-serif, system-ui, sans-serif';
        c.fillText(flash, W / 2, 56);
      } else {
        c.fillStyle = '#93a7bb';
        c.font = '500 25px ui-sans-serif, system-ui, sans-serif';
        c.fillText(combo > 1 ? '×' + combo + ' streak' : 'keep them at the edge', W / 2, 56);
      }
      c.fillStyle = '#5f7488';
      c.font = '500 21px ui-sans-serif, system-ui, sans-serif';
      c.fillText(banished + ' banished', W / 2, 104);
    } else if (mode === 'over') {
      c.textAlign = 'center';
      c.fillStyle = '#ffffff';
      c.font = '700 40px ui-sans-serif, system-ui, sans-serif';
      c.fillText(score + ' · ' + banished + ' banished', W / 2, 46);
      c.fillStyle = '#9fb3c8';
      c.font = '500 25px ui-sans-serif, system-ui, sans-serif';
      c.fillText('best ' + best + '  —  double-tap to play again', W / 2, 92);
    }
    VR.uploadHud(hudCv);
  }

  /* ---------- loop ---------- */

  function computeR() {
    if (orientOk && orient) {
      return VR.matFromDeviceOrientation(orient.alpha || 0, orient.beta || 0, orient.gamma || 0, screenAngle);
    }
    return VR.matFromYawPitch(yaw, pitch);
  }

  function tick(now) {
    requestAnimationFrame(tick);
    var dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    var t = (now - t0) / 1000;
    frame++;

    VR.resize();
    R = computeR();

    var scanning = (mode === 'scan' || primeLeft > 0);

    if (simMode) {
      stepPhantoms(scanning ? 0 : dt, t);
      VR.renderSim(R, t, phantoms, mode === 'play' || mode === 'over');
    }

    VR.sense(R, {
      t0: 0.055 / S.sens,
      t1: 0.20 / S.sens,
      smooth: scanning ? 0.5 : 0.35,
      /* A stale plate is repainted briskly; a good one drifts slowly so a
         person standing still does not fade into the wallpaper. */
      slow: scanning ? 0.16 : (stale > 1.5 ? 0.14 : 0.018),
      fast: 0.55
    });

    if (frame % 12 === 0) coverage = VR.coverage();

    if (mode !== 'idle' && frame % 2 === 0) {
      var buf = VR.readMask();
      lit = lit * 0.7 + litFraction(buf) * 0.3;
      if (mode === 'play') {
        if (trust < 0.35) tracks = [];
        else updateTracks(findBlobs(buf, 96), dt * 2);
      }
    }
    /* Nobody takes up half the room. When the mask says they do, the plate has
       stopped matching what the camera sees — the lights changed, or the phone
       was carried to a different spot — and erasing on it would wipe out the
       whole view. Stop erasing, and let the plate relearn instead. */
    stale = lit > 0.30 ? stale + dt : Math.max(0, stale - dt * 2);
    trust = 1 - Math.min(1, Math.max(0, (lit - 0.22) / 0.20));
    if (mode === 'play') {
      scoreTracks(dt);
      timeLeft -= dt;
      if (timeLeft <= 0) endRound();
    }

    if (mode === 'scan') {
      /* Nobody sweeps the ceiling and the floor, so full coverage is never
         coming. Enough of the band around the horizon is enough — and a room
         too dark or too blank to ever reach it must not trap the player. */
      if ((coverage >= SCAN_TARGET && now - scanStart > 6000) || now - scanStart > 25000) startPlay();
      $('#scanPct').textContent = Math.round(Math.min(1, coverage / SCAN_TARGET) * 100) + '%';
    }
    if (primeLeft > 0) primeLeft -= dt;

    shake = Math.max(0, shake - dt * 0.03);
    fade += ((mode === 'over' ? 0.55 : 1) - fade) * Math.min(1, dt * 4);

    var marks = [];
    if (mode === 'play') {
      tracks.forEach(function (tr) {
        if (!tr.dir || tr.age < 0.25 || tr.area < MIN_AREA) return;
        marks.push({ dir: tr.dir, charge: tr.look < 0 ? -Math.max(0.12, tr.charge) : tr.charge });
      });
    }

    var lens = LENS[S.lens] || LENS.light;
    VR.present(R, {
      stereo: S.stereo && mode !== 'idle',
      k1: lens[0], k2: lens[1], lens: S.ipd,
      erase: mode === 'scan' ? 0 : S.erase * trust,
      gazeIn: GAZE_IN, gazeOut: gazeOut(),
      time: t, shake: shake, fade: fade,
      reticle: mode === 'idle' ? 0 : 1,
      hud: mode !== 'idle',
      marks: marks
    });

    drawHud(now);
    if (frame % 15 === 0) updateDom();
  }

  function updateDom() {
    $('#mScore').textContent = score;
    $('#mTime').textContent = mode === 'play' ? timeLeft.toFixed(0) + 's' : '—';
    $('#mSeen').textContent = tracks.filter(function (t) { return t.matched && t.age > 0.25; }).length;
    $('#mCov').textContent = Math.round(coverage * 100) + '%';
  }

  /* ---------- phases ---------- */

  function startScan() {
    mode = 'scan';
    scanStart = performance.now();
    VR.forget();
    tracks = [];
    document.body.dataset.phase = 'scan';
    if (simMode) {
      /* Sweep the pretend room so the plate is built the same way a real one is. */
      primeSweep();
    }
  }

  function primeSweep() {
    var steps = 150, i = 0;
    primeLeft = 0.1;
    (function step() {
      if (i >= steps) { primeLeft = 0; return; }
      var f = i / steps;
      yaw = f * Math.PI * 2 * 1.5;
      pitch = Math.sin(f * Math.PI * 4) * 0.5;
      var Rp = VR.matFromYawPitch(yaw, pitch);
      VR.renderSim(Rp, 0, phantoms, false);
      VR.sense(Rp, { t0: 0.06, t1: 0.2, smooth: 0.5, slow: 0.35, fast: 0.7 });
      i++;
      if (i % 25 === 0) { coverage = VR.coverage(); setTimeout(step, 0); } else step();
    }());
    coverage = VR.coverage();
  }

  function startPlay() {
    mode = 'play';
    score = 0; combo = 1; banished = 0; level = 0; timeLeft = 60;
    tracks = []; flash = ''; fade = 1;
    document.body.dataset.phase = 'play';
    say('GO');
  }

  function endRound() {
    mode = 'over';
    if (score > best) { best = score; try { localStorage.setItem('kemosh.best', String(best)); } catch (e) {} }
    document.body.dataset.phase = 'over';
    $('#overScore').textContent = score;
    $('#overSub').textContent = banished + ' banished · best ' + best;
  }

  function quit() {
    mode = 'idle';
    document.body.dataset.phase = 'idle';
    if (stream) { stream.getTracks().forEach(function (tk) { tk.stop(); }); stream = null; }
    if (document.fullscreenElement) document.exitFullscreen().catch(function () {});
  }

  /* ---------- getting in ---------- */

  function note(msg) {
    var el = $('#note');
    el.textContent = msg || '';
    el.hidden = !msg;
  }

  async function askOrientation() {
    var D = window.DeviceOrientationEvent;
    if (!D) return false;
    if (typeof D.requestPermission === 'function') {
      try {
        if (await D.requestPermission() !== 'granted') return false;
      } catch (e) { return false; }
    }
    window.addEventListener('deviceorientation', function (e) {
      if (e.alpha === null && e.beta === null) return;
      orient = e; orientOk = true;
    });
    return true;
  }

  function readScreenAngle() {
    screenAngle = (screen.orientation && screen.orientation.angle) || window.orientation || 0;
  }

  async function goImmersive() {
    readScreenAngle();
    try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen(); } catch (e) {}
    try { if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape'); } catch (e) {}
    try { if (navigator.wakeLock) await navigator.wakeLock.request('screen'); } catch (e) {}
    setTimeout(readScreenAngle, 400);
  }

  async function startCamera() {
    note('');
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      note('This browser won’t hand over a camera. Open the page over https, or play the room instead.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
    } catch (e) {
      note(e && e.name === 'NotAllowedError'
        ? 'The camera was refused. Allow it in the browser’s site settings, or play the room instead.'
        : 'No camera came back (' + ((e && e.name) || 'unknown') + '). You can still play the room.');
      return;
    }
    video.srcObject = stream;
    try { await video.play(); } catch (e) {}
    await new Promise(function (res) {
      if (video.videoWidth) return res();
      video.onloadedmetadata = res;
      setTimeout(res, 3000);
    });
    simMode = false;
    VR.useCamera(video, S.fov, S.rot);
    MT = maskTanOf();
    await askOrientation();
    await goImmersive();
    startScan();
  }

  async function startRoom() {
    note('');
    simMode = true;
    VR.useSim(68);
    MT = maskTanOf();
    await askOrientation();
    if (S.stereo) await goImmersive();
    startScan();
  }

  /* Mirror of the renderer's framing maths, so blob positions land in the same
     place on screen as the pixels they came from. */
  function maskTanOf() {
    var vw = simMode ? 512 : (video && video.videoWidth) || 1280;
    var vh = simMode ? 288 : (video && video.videoHeight) || 720;
    var fov = simMode ? 68 : S.fov;
    var rot = simMode ? 0 : S.rot;
    var tvx = Math.tan(fov * Math.PI / 360), tvy = tvx * (vh / vw);
    return (rot === 90 || rot === 270) ? [tvy, tvx] : [tvx, tvy];
  }

  /* ---------- input ---------- */

  function bindLook() {
    var down = false, lx = 0, ly = 0;
    function start(x, y) { down = true; lx = x; ly = y; }
    function move(x, y) {
      if (!down || orientOk) return;
      yaw -= (x - lx) * 0.004;
      pitch = Math.max(-1.3, Math.min(1.3, pitch + (y - ly) * 0.004));
      lx = x; ly = y;
    }
    canvas.addEventListener('pointerdown', function (e) { start(e.clientX, e.clientY); });
    window.addEventListener('pointermove', function (e) { move(e.clientX, e.clientY); });
    window.addEventListener('pointerup', function () { down = false; });
    window.addEventListener('keydown', function (e) {
      var k = e.key;
      if (k === 'ArrowLeft') yaw += 0.06;
      else if (k === 'ArrowRight') yaw -= 0.06;
      else if (k === 'ArrowUp') pitch = Math.min(1.3, pitch + 0.05);
      else if (k === 'ArrowDown') pitch = Math.max(-1.3, pitch - 0.05);
      else if (k === 'Escape' && mode !== 'idle') quit();
      else return;
      e.preventDefault();
    });
    /* Two taps is the only control that works with a phone inside a box. */
    var lastTap = 0;
    canvas.addEventListener('pointerup', function () {
      var n = performance.now();
      if (n - lastTap < 380) {
        if (mode === 'over') startScan();
        else if (mode === 'play') endRound();
        lastTap = 0;
      } else lastTap = n;
    });
  }

  /* ---------- boot ---------- */

  function boot() {
    canvas = $('#view');
    video = $('#cam');
    hudCv = document.createElement('canvas');
    hudCv.width = 640; hudCv.height = 128;   /* 5:1, matching the bar in the view */
    hudCtx = hudCv.getContext('2d');

    var err = VR.init(canvas);
    if (err) {
      $('#gate').innerHTML = '<div class="card"><h1>KEMOSH</h1><p class="bad">' + err + '</p></div>';
      return;
    }
    VR.useSim(68);
    MT = maskTanOf();

    $('#btnCam').addEventListener('click', startCamera);
    $('#btnRoom').addEventListener('click', startRoom);
    $('#btnQuit').addEventListener('click', quit);
    $('#btnRescan').addEventListener('click', startScan);
    $('#btnSkip').addEventListener('click', function () { if (mode === 'scan') startPlay(); });
    $('#btnAgain').addEventListener('click', startScan);
    $('#btnMenu').addEventListener('click', quit);
    $('#btnHow').addEventListener('click', function () {
      var h = $('#how'); h.hidden = !h.hidden;
    });

    function opt(id, key, cast) {
      var el = $(id);
      if (!el) return;
      el.value = String(S[key]);
      if (el.type === 'checkbox') el.checked = !!S[key];
      el.addEventListener('input', function () {
        S[key] = el.type === 'checkbox' ? el.checked : cast(el.value);
        save();
        if (key === 'fov' || key === 'rot') { VR.setFov(S.fov, S.rot); MT = maskTanOf(); }
        var out = document.querySelector('[data-for="' + id.slice(1) + '"]');
        if (out) out.textContent = el.type === 'checkbox' ? '' : el.value;
      });
      var out = document.querySelector('[data-for="' + id.slice(1) + '"]');
      if (out && el.type !== 'checkbox') out.textContent = el.value;
    }
    opt('#optFov', 'fov', Number);
    opt('#optRot', 'rot', Number);
    opt('#optLens', 'lens', String);
    opt('#optIpd', 'ipd', Number);
    opt('#optSens', 'sens', Number);
    opt('#optErase', 'erase', Number);
    $('#optStereo').checked = S.stereo;
    $('#optStereo').addEventListener('change', function () { S.stereo = $('#optStereo').checked; save(); });

    $('#bestLine').textContent = best ? 'best so far: ' + best : '';
    if (!window.isSecureContext) {
      note('This page isn’t on https, so the browser will not give it a camera. The room still plays.');
    }

    window.addEventListener('orientationchange', function () { setTimeout(readScreenAngle, 250); });
    if (screen.orientation) screen.orientation.addEventListener('change', readScreenAngle);
    readScreenAngle();
    bindLook();
    document.body.dataset.phase = 'idle';

    /* A small handle on the running game, for checking behaviour from the
       console on a real phone as much as from a test. */
    window.KEMOSH = {
      look: function (y, p) { yaw = y; pitch = p; },
      scan: startScan,
      play: startPlay,
      state: function () {
        return {
          mode: mode, sim: simMode, coverage: coverage, lit: lit, trust: trust, stale: stale,
          score: score, combo: combo,
          banished: banished, timeLeft: timeLeft, gazeOut: gazeOut(),
          phantoms: phantoms.map(function (p) { return { yaw: p.yaw, pitch: p.pitch, size: p.size }; }),
          tracks: tracks.map(function (t) {
            return { id: t.id, u: t.u, v: t.v, area: t.area, age: t.age, charge: t.charge, look: t.look || 0 };
          })
        };
      }
    };

    requestAnimationFrame(tick);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
