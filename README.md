# KEMOSH

You start in **a white void**. Walk around your room with the phone held up,
and the room **builds itself back up around you out of blocks** — not the camera
picture, a blocky model of the place, fixed where it really is. Then **walk
through it** and see it from any side: round the back of the bed, under the
desk, from the doorway.

Because what you end up in is a model of the empty room, **anyone who walks into
it is simply not part of it**. They never appear at all.

## Getting it onto a phone

The camera is only handed out to pages served over **https**, so opening the file
off a memory card won't work. Two ways round that:

- **GitHub Pages.** In this repository: *Settings → Pages → Source: deploy from
  branch*, pick the branch, save. A minute later it's at
  `https://natguy121.github.io/Kemoush/`. Open that on the phone.
- **Any other web host.** It is four plain files with nothing to build. Copy them
  anywhere that serves https.

Then open the page and tap **Walk the room**. Walking needs an **Android phone
with Google Play Services for AR** (it's on the Play Store, and usually already
installed). The line under the buttons says whether this phone can do it.

No phone handy, or on a laptop? **Try it on this screen** runs the whole thing in
a pretend room with a pretend person wandering about. Walk with **W A S D** or the
arrow keys (or the on-screen pad), drag to look, **Enter** or a double-click for
Done.

## How to use it

1. **You start in white.** Nothing has been measured, so there is nothing to
   draw. The camera shows faintly through the white so you can see where you're
   putting your feet.
2. **Walk around the room.** Point the phone at everything — walls, floor,
   furniture, round the sides and backs of things. Wherever it measures, blocks
   fade up out of the white in the room's own colours, and stay exactly where
   they are as you move. The bar at the top counts blocks and square metres.
3. **Press Done.** Done stops the learning: the room is then kept exactly as you
   scanned it. *Rescan* starts over.
4. **Walk through it.** You are now inside a blocky model of your room, drawn
   from wherever you stand. Anyone who walks in is not in that model, so they
   never appear. **Show camera** swaps to the live picture — with people
   replaced by the room behind them.

**Mind where you walk.** In the blocks view, people — and anything moved since
the scan — are invisible *on purpose*. That is the point of it, and also a good
reason to walk slowly.

## How it works

The first version of this stored the room as **one photograph per direction**,
taken from one spot. That works while you only turn your head, and falls apart
the moment you take a step: everything in it was stored as "what you see this
way", not "what is over there", so walking made the whole room slide.

Walking stores the second thing. An AR session on Android knows **where the
phone is** as well as which way it faces, and hands over a **depth map** with
every frame — how far away each part of the picture is. Together those put
every measured point at a real place in the room, and the room is kept as **a
lattice of blocks fixed to the room** (10 cm each by default), each one solid or
empty and with a colour. Drawing it from wherever you're standing is then just
drawing blocks.

Each measurement is a sight line from the phone to a surface. The end of it is a
vote for *solid here*. The space it passed through on the way is a vote for
*empty here* — and that is what keeps people out. Someone who stood in front of
the wardrobe and then walked off is cleared out as soon as you see the wardrobe
through where they were. A block has to be seen more than once to appear, and a
few clear views through it remove it, so speckle and passers-by don't stick.

Colour comes from the camera picture, when the phone allows a page to read it
(Chrome's *camera access* for AR). When it doesn't, you get the room's shape in
plain white blocks, and the bar says so.

Blocks are shaded by which way they face — floor-side faces brightest,
ceiling-side darkest, walls in between — with a faint seam at every edge. That
flat per-face shading is most of what says "cube" to the eye. Blocks buried
inside furniture are never drawn, which keeps a whole room cheap enough for a
phone.

### Keeping people out of the model

In the blocks view there's nothing to do: people were never scanned in, so they
aren't drawn. In the camera view, the phone keeps measuring depth while you look
around. Wherever something is standing **nearer than the room you scanned** —
more than 15 cm in front of it — the scanned room is drawn there instead of the
camera. The person is replaced by what's behind them, from wherever you're
standing.

### Turning on the spot (any phone)

For phones without AR — including every iPhone — the original mode is still
there: **Turn on the spot** and **Try turning here**. Stand in one place and turn
all the way round; the room is kept as a photograph per direction, drawn as
blocks on a guessed room-shaped box. It works with any phone and a Cardboard
headset, but you can't walk in it. The rest of this section describes how that
mode works.

#### Keeping people out, when turning

Compare the plate against the live frame and what's left over is whatever the
room doesn't account for: a person. Brightness and colour are compared
separately, because a phone's auto-exposure shifts the whole frame at once and
colour survives that better than brightness does. Those pixels are then refused
entry to the plate, so nobody gets painted into the room.

Nothing is called a person until the wall behind them is actually known — a
plate only part of the way to the truth disagrees with the camera everywhere,
and mistaking that for a person would stop the scan filling it in at all.

Since the block view draws the model and never the live frame, that is all it
takes: people are absent by construction rather than painted over.

#### The camera view, when turning

*Settings → Show → the camera* gives the plain passthrough instead: the live
frame, with people cut out of it. There the leftovers are shaped into people —
connected blobs, filtered by how tall, wide and solid they are, tracked from
frame to frame — and **every pixel of a tracked person** is drawn from the plate
instead of from the camera. Not a hole cut through them: the whole silhouette.
*Hide people → only where I look* puts that on a leash, so they fade only as you
turn towards them and come back when you look away.

Nothing is downloaded, no model runs, and no picture leaves the phone. It is
arithmetic on the frame in front of you.

### What it can't do

Worth knowing before it surprises you:

- **Walking needs Android with ARCore.** No iPhone browser lets a web page
  track position or read the LiDAR scanner, whichever browser you use. iPhones
  get turning on the spot.
- **It only knows what it has measured.** Anywhere you never pointed the phone
  is white — including the far side of anything you didn't walk round. Walk
  round it and it fills in.
- **Phone depth is short-sighted.** It measures well out to about four or five
  metres. In a big room, walk closer to the far wall.
- **It is blocky on purpose, and coarse by necessity.** Anything thinner than a
  block — a chair leg, a cable, a lamp stand — may come out as nothing, or as a
  gap-toothed row of blocks. *Block size → small* helps, at some cost in speed.
- **Walking while wearing Cardboard** only works if the phone's camera can see
  out of the viewer. Most Cardboards cover it, and then tracking stops. It is off
  by default: scan and walk with the phone in your hand.
- **Each walk is a fresh scan.** The phone places the room relative to where you
  started, so the next session can't line up with the last one's blocks.
- **The camera view's swap is only as sharp as the phone's depth map**, which is
  low-resolution: people are replaced in chunky blocks, and where someone stands
  very close to a wall or the floor (under 15 cm) the camera shows through.
- **Anyone standing still during the whole scan gets built in**, and then it
  thinks they're furniture. Once they move and you look past where they stood,
  they are cleared out; *Rescan* fixes it outright.

## If it looks wrong

Everything below is in **Settings** on the start screen.

| What you see | What to change |
|---|---|
| **Walk the room** is greyed out | Read the line under it — usually Google Play Services for AR is missing or old |
| Walking: blocks are all white | This phone won't let pages read the camera in AR; you get the shape only |
| Walking: colours look upside down or wrong | **Walking colours upside down** |
| Blocks too coarse, or too fine to read | **Block size** (takes effect on the next scan) |
| You want the real picture instead | **show camera** in the bar while walking |
| Walking in a headset | **Cardboard while walking** — needs a viewer with a camera hole |
| Turning: the view is sideways, or squashed | **Camera turned** — try 90°, then 270° |
| Straight lines bow, or the edges are blurry | **Lens correction**, and **Eye spacing** |
| The two halves don't merge into one image | **Eye spacing** |

**Spot people**, **Hide people** and **How completely** only apply to the camera
view when turning on the spot.

## The files

```
index.html   the page, the start screen, the settings
styles.css   the look
world.js     walking: the room as blocks in 3D, filled from depth and colour
walk.js      walking: the AR session, drawing the blocks, the camera swap,
             Cardboard, and the pretend room for trying it on a screen
vr.js        turning: the renderer — plate, blocks, mask, stereo, lens
app.js       turning: orientation, the scan, tracking people, the settings
scan3d.js    turning: the pretend room's shape for its demo
```

Plain HTML, CSS and JavaScript. No libraries, no build step, no install. Edit a
file, reload the page.

`window.WALK` and `window.KEMOSH` are left on the page on purpose.
`WALK.state()` reports what walking currently believes — blocks, area mapped,
whether colour is arriving — and `KEMOSH.state()` does the same for turning:
coverage, tracked people, how much of the mask is lit. Either is the quickest
way to see why something isn't behaving on a real phone.
