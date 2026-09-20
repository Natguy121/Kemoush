/* KEMOSH — orientation, scanning, and the settings on top of the seeing.
 *
 * The rule the renderer enforces is simple: scan the empty room, press Done,
 * and from then on anyone who walks into it is not drawn. This file drives
 * that — reading the phone's orientation or a mouse drag, running the scan
 * and its compass, tracking roughly where people are so the renderer can
 * erase each one as a whole body rather than a hole punched through them,
 * and watching for the plate going stale so it never erases the whole view.
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
    hide: 'always', // 'always' — invisible wherever they stand; 'gaze' — only what you look at
    view: 'blocks', // 'blocks' — the scanned room rebuilt as cubes; 'camera' — live passthrough
    grid: 80,       // cubes across the room
    stereo: true
  };
  var S = Object.assign({}, DEF);
  try {
    var saved = JSON.parse(localStorage.getItem('kemosh') || '{}');
    Object.keys(DEF).forEach(function (k) { if (saved[k] !== undefined) S[k] = saved[k]; });
  } catch (e) { /* first run, or storage is off; defaults are fine */ }
  /* Someone who used this before has a cube size saved that no longer exists.
     Left alone it would both render a room of the wrong coarseness and leave
     the settings menu showing a blank. */
  var GRIDS = [48, 80, 120];
  if (GRIDS.indexOf(S.grid) < 0) S.grid = DEF.grid;
  function save() { try { localStorage.setItem('kemosh', JSON.stringify(S)); } catch (e) {} }

  var LENS = { off: [0, 0], light: [0.16, 0.10], strong: [0.34, 0.24] };

  /* ---------- state ---------- */

  var canvas, video = null, stream = null;
  var mode = 'idle';            // idle | scan | live
  var simMode = false;
  var R = null, yaw = 0, pitch = 0;
  var orientOk = false, orient = null, screenAngle = 0;
  var t0 = performance.now(), last = t0, frame = 0;
  var coverage = 0, fade = 1;
  var tracks = [], nextId = 1;
  var scanStart = 0;
  var hudCv, hudCtx, hudAt = 0;
  var people = [];              // the demo room's simulated people
  var lit = 0, stale = 0, trust = 1;

  function litFraction(buf) {
    var n = 0, i;
    for (i = 0; i < buf.length; i += 4) if (buf[i] > 96) n++;
    return n / (buf.length / 4);
  }

  /* Angles are kept as tangents throughout — same units the shader uses, so
     "is it in the middle of the view" means the same thing in both places. */
  function tanOf(deg) { return Math.tan(deg * Math.PI / 180); }
  var ANGLE_DONE = 0.96;    // share of compass directions before the scan counts as complete
  var MIN_AREA = 0.006;     // smaller than this is speckle, not somebody
  var GAZE_IN = tanOf(3);

  /* How far off centre something can be and still be on screen. In stereo each
     eye gets a slice barely 20° wide, so a cone measured in plain degrees would
     otherwise reach past the edge of what's actually visible. */
  function viewEdge() {
    var e = VR.lastEyeTan;
    return e ? Math.min(e[0], e[1]) : 0.37;
  }

  /* The cone used by "only where I look" mode: wide enough to feel deliberate,
     but never past most of the view. */
  function gazeOut() {
    return Math.min(tanOf(16), viewEdge() * 0.7);
  }

  /* ---------- the demo room's occupants (no camera needed) ---------- */

  function spawnPerson() {
    var y = Math.random() * Math.PI * 2;
    return {
      yaw: y, pitch: (Math.random() - 0.5) * 0.28,
      vy: (Math.random() < 0.5 ? -1 : 1) * (0.18 + Math.random() * 0.22),
      size: 0.085 + Math.random() * 0.045,
      turn: 1 + Math.random() * 3,
      dir: [1, 0, 0]
    };
  }
  function stepPeople(dt, t) {
    var i, p;
    while (people.length < 3) people.push(spawnPerson());
    for (i = 0; i < people.length; i++) {
      p = people[i];
      p.turn -= dt;
      if (p.turn <= 0) { p.vy = -p.vy * (0.7 + Math.random() * 0.6); p.turn = 1.5 + Math.random() * 3.5; }
      p.yaw += p.vy * dt;
      p.pitch = Math.sin(t * 0.8 + i) * 0.05 - 0.02;
      var c = Math.cos(p.pitch);
      p.dir = [c * Math.cos(p.yaw), c * Math.sin(p.yaw), Math.sin(p.pitch)];
    }
  }

  /* ---------- finding bodies in the mask ----------
     This exists so a hidden person's whole silhouette disappears together,
     rather than the renderer punching a hole only where you happen to be
     looking. It is a quality feature of the erasing, not a game mechanic. */

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
     gap where an arm or a shadow broke the outline. Put anything stacked and
     overlapping back together so it is treated as one person. */
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

  /* ---------- tracking ----------
     Keeps each spotted body's identity from frame to frame, purely so its
     erase radius doesn't jitter and so a person briefly missed by the mask
     doesn't flash back into view for a frame. */

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
        tr.w = tr.w * 0.7 + b.w * 0.3;
        tr.h = tr.h * 0.7 + b.h * 0.3;
        tr.matched = true; tr.miss = 0; tr.age += dt;
      } else {
        tr.miss += dt;
      }
    }
    for (j = 0; j < blobs.length; j++) {
      if (used[j]) continue;
      tracks.push({
        id: nextId++, u: blobs[j].u, v: blobs[j].v, area: blobs[j].area,
        w: blobs[j].w, h: blobs[j].h, age: 0, miss: 0, matched: true
      });
    }
    tracks = tracks.filter(function (t) { return t.miss < 0.8; });
    if (tracks.length > 8) {
      tracks.sort(function (a, b2) { return b2.area - a.area; });
      tracks.length = 8;
    }
    /* Where each one is, in the world, so it stays put while the head turns. */
    for (i = 0; i < tracks.length; i++) {
      if (tracks[i].matched) tracks[i].dir = dirFromUv(tracks[i].u, tracks[i].v);
    }
  }

  /* How far out from a tracked person's centre their own silhouette reaches,
     in the same tangent units the view works in. The renderer erases out to
     this and no further, so a person standing beside the one being erased
     keeps their own fate. A little slack covers the feathered mask edge. */
  function markRadius(tr) {
    var halfW = (tr.w || 0.12) * MT[0];
    var halfH = (tr.h || 0.2) * MT[1];
    return Math.min(0.30, Math.max(0.05, Math.max(halfW, halfH) * 1.25));
  }

  /* ---------- the bar you read through the lenses ---------- */

  /* What share of the compass is actually done. The plain coverage figure is an
     average over the whole sphere, so it can read high while a whole direction
     behind you is still dark — which is the one thing "scan every angle" is
     asking about. This counts directions instead. */
  function angleCoverage() {
    var c = VR.yawCover, n = c.length, k = 0, i;
    for (i = 0; i < n; i++) if (c[i] >= 0.30) k++;
    return n ? k / n : 0;
  }

  /* A ring of segments for the compass, rolled so the middle one is whatever
     you are facing. "Scan every angle" is then a thing you can see yourself
     doing: turn until no segment is dark. */
  function drawCompass(c, W, y) {
    var cover = VR.yawCover, n = cover.length;
    var f = [-R[6], -R[7], -R[8]];
    var here = Math.atan2(f[1], f[0]) / (Math.PI * 2) + 0.5;   // matches the plate's u
    var x0 = 58, w = (W - 116) / n, i, k, v;
    for (i = 0; i < n; i++) {
      k = (Math.round(here * n) + i - (n >> 1) + n * 2) % n;
      v = Math.min(1, cover[k] / 0.55);
      c.fillStyle = v > 0.6 ? '#5ad1ff' : v > 0.25 ? 'rgba(90,209,255,0.45)' : 'rgba(255,255,255,0.12)';
      c.fillRect(x0 + i * w + 1, y + (1 - v) * 9, w - 2, 4 + v * 14);
    }
    c.fillStyle = '#ffffff';
    c.fillRect(W / 2 - 1.5, y - 7, 3, 5);
  }

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
      var done = angleCoverage() >= ANGLE_DONE;
      c.fillStyle = '#dfe9f5';
      c.font = '600 25px ui-sans-serif, system-ui, sans-serif';
      c.textAlign = 'center';
      c.fillText('Turn right round. Room must be empty.', W / 2, 34);
      drawCompass(c, W, 62);
      c.fillStyle = done ? '#7dffb0' : '#93a7bb';
      c.font = '500 22px ui-sans-serif, system-ui, sans-serif';
      c.fillText(done ? 'every angle covered — press Done'
        : 'fill the dark gaps, then press Done', W / 2, 108);
    } else if (mode === 'live') {
      c.textAlign = 'center';
      if (stale > 1.5) {
        /* It no longer relearns by itself once Done has been pressed, so say
           what is actually true and what the way out of it is. */
        c.fillStyle = '#ffc46b';
        c.font = '600 25px ui-sans-serif, system-ui, sans-serif';
        c.fillText('the room has changed — press rescan', W / 2, 40);
      } else {
        c.fillStyle = '#93a7bb';
        c.font = '500 24px ui-sans-serif, system-ui, sans-serif';
        c.fillText(S.view === 'blocks' ? 'the room as you scanned it'
          : (S.hide === 'always' ? 'people are invisible' : 'look away to hide them'), W / 2, 40);
      }
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

    var scanning = (mode === 'scan');
    var blocks = S.view === 'blocks';

    if (simMode) {
      stepPeople(scanning ? 0 : dt, t);
      VR.renderSim(R, t, people, mode === 'live');
    }

    VR.sense(R, {
      t0: 0.055 / S.sens,
      t1: 0.20 / S.sens,
      smooth: scanning ? 0.5 : 0.35,
      /* Done means done: once the scan is over the room is left exactly as it
         was learned. It will not creep towards a room that has since changed,
         and a direction never scanned stays blank rather than quietly filling
         itself in later. Rescan is how you ask for a new one.

         While scanning, building the room out of blocks is the thing worth
         watching, so a direction seen for the first time arrives over about a
         second of dwelling — some sixty frames, sixty looks at it — rather than
         in three. A turn on the spot still leaves every direction well past the
         point of no return, because it holds each one in view for far longer
         than that. The camera view has nothing to watch, so it takes the plate
         as fast as it can get it. */
      freeze: mode === 'live',
      slow: blocks ? 0.05 : 0.16,
      fast: blocks ? 0.06 : 0.55
    });

    if (frame % 12 === 0) coverage = VR.coverage();

    if (mode !== 'idle' && frame % 2 === 0) {
      var buf = VR.readMask();
      lit = lit * 0.7 + litFraction(buf) * 0.3;
      if (mode === 'live') {
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

    if (mode === 'scan') {
      /* The scan ends when the player says it does, not on a timer. They are
         the ones who know whether they have turned all the way round, and
         whether the room was empty while they did it. */
      var ang = angleCoverage();
      $('#scanPct').textContent = Math.round(ang * 100) + '%';
      $('#scanHint').textContent = ang >= ANGLE_DONE
        ? 'every angle covered'
        : (now - scanStart > 9000 ? 'keep turning — some angles are still dark' : '');
      $('#btnDone').classList.toggle('primary', ang >= ANGLE_DONE);
    }

    fade += ((mode === 'idle' ? 0.55 : 1) - fade) * Math.min(1, dt * 4);

    var marks = [];
    if (mode === 'live') {
      tracks.forEach(function (tr) {
        if (!tr.dir || tr.age < 0.25 || tr.area < MIN_AREA) return;
        marks.push({ dir: tr.dir, r: markRadius(tr) });
      });
    }

    var lens = LENS[S.lens] || LENS.light;
    /* Never let a cube size the renderer can't use get through — a zero would
       divide the whole lattice by nothing and take the view with it. */
    var grid = GRIDS.indexOf(S.grid) >= 0 ? S.grid : DEF.grid;
    VR.present(R, {
      stereo: S.stereo && mode !== 'idle',
      k1: lens[0], k2: lens[1], lens: S.ipd,
      erase: mode === 'scan' ? 0 : S.erase * trust,
      always: (mode === 'scan' || S.hide !== 'always') ? 0 : 1,
      gazeIn: GAZE_IN, gazeOut: gazeOut(),
      time: t, fade: fade,
      /* The cone only means something when the camera is the thing being
         hidden; among blocks there is nothing live to erase. */
      reticle: (!blocks && mode === 'live') ? 1 : 0,
      hud: mode !== 'idle',
      blocks: blocks,
      cell: 2.0 / grid,
      /* Relief is set as a real depth and converted to cubes, so making the
         cubes smaller makes the detail finer instead of flattening the room.
         Its steps stay on a lattice of about twenty across however fine the
         cubes get, which keeps the room's shape steady while its surface
         gains detail. */
      relief: Math.min(8, Math.max(1, Math.round(0.16 * grid / 2.0))),
      reliefGrid: Math.max(1, Math.round(grid / 20)),
      marks: marks
    });

    drawHud(now);
    if (frame % 15 === 0) updateDom();
  }

  function updateDom() {
    $('#mCov').textContent = Math.round(coverage * 100) + '%';
  }

  /* ---------- phases ---------- */

  /* The demo used to be given a half-built plate so it had something to show
     straight away. Watching the room assemble itself is now the thing worth
     showing, so it starts as blank as a real camera does. */
  function startScan() {
    mode = 'scan';
    scanStart = performance.now();
    VR.forget();
    tracks = [];
    coverage = 0;
    document.body.dataset.phase = 'scan';
  }

  function startLive() {
    mode = 'live';
    tracks = []; fade = 1;
    document.body.dataset.phase = 'live';
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
      note('This browser won’t hand over a camera. Open the page over https, or try the room instead.');
      return;
    }
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false
      });
    } catch (e) {
      note(e && e.name === 'NotAllowedError'
        ? 'The camera was refused. Allow it in the browser’s site settings, or try the room instead.'
        : 'No camera came back (' + ((e && e.name) || 'unknown') + '). You can still try the room.');
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
    /* Two taps is a control that works with a phone inside a closed box: it
       ends the scan the same way the Done button does. */
    var lastTap = 0;
    canvas.addEventListener('pointerup', function () {
      var n = performance.now();
      if (n - lastTap < 380) {
        if (mode === 'scan') startLive();
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
    $('#btnDone').addEventListener('click', function () { if (mode === 'scan') startLive(); });
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
    opt('#optView', 'view', String);
    opt('#optGrid', 'grid', Number);
    opt('#optSens', 'sens', Number);
    opt('#optHide', 'hide', String);
    opt('#optErase', 'erase', Number);
    $('#optStereo').checked = S.stereo;
    $('#optStereo').addEventListener('change', function () { S.stereo = $('#optStereo').checked; save(); });

    if (!window.isSecureContext) {
      note('This page isn’t on https, so the browser will not give it a camera. The room still works.');
    }

    window.addEventListener('orientationchange', function () { setTimeout(readScreenAngle, 250); });
    if (screen.orientation) screen.orientation.addEventListener('change', readScreenAngle);
    readScreenAngle();
    bindLook();
    document.body.dataset.phase = 'idle';

    /* A small handle on the running page, for checking behaviour from the
       console on a real phone as much as from a test. */
    window.KEMOSH = {
      look: function (y, p) { yaw = y; pitch = p; },
      scan: startScan,
      live: startLive,
      /* A point in the mask, turned into the world direction it came from. */
      dirFromMaskUv: dirFromUv,
      /* Where a tracked person is on the glass right now — for lining an
         overlay up, or for checking that what is drawn there is what should
         be. */
      project: function (dir, eye) {
        var lens = LENS[S.lens] || LENS.light;
        var stereo = S.stereo && mode !== 'idle';
        return VR.project(R, dir, stereo ? (eye || 0) : null, lens[0], lens[1], S.ipd);
      },
      state: function () {
        return {
          mode: mode, sim: simMode, coverage: coverage, lit: lit, trust: trust, stale: stale,
          view: S.view, grid: S.grid, gazeOut: gazeOut(),
          people: people.map(function (p) { return { yaw: p.yaw, pitch: p.pitch, size: p.size }; }),
          tracks: tracks.map(function (t) {
            return { id: t.id, u: t.u, v: t.v, dir: t.dir, area: t.area, age: t.age };
          })
        };
      }
    };

    requestAnimationFrame(tick);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
}());
