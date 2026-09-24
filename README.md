# KEMOSH

For a phone and a cardboard headset. You start in **a white void**. As you look
around, the room **builds itself back up around you out of blocks** — not the
camera picture, a blocky model of the place you are standing in, assembled from
what you have scanned so far.

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

Then: open the page, tap **Use the camera**, allow it, put the phone in the
headset. It goes fullscreen and locks to landscape on its own.

No camera handy, or trying it on a laptop? **Try the room instead** builds a
room out of arithmetic and puts a couple of simulated people in it, so the whole
effect is visible without a camera. Drag with the mouse, or use the arrow keys,
to look around. It starts blank exactly as the camera does, and runs through the
same pipeline — so you scan it the same way.

## How to use it

1. **You start in white.** Nothing has been seen yet, so there is nothing to
   draw: a blank white space with the faintest hint of cube seams.
2. **Scan every angle.** Turn all the way round on the spot, with nobody in front
   of you. The phone is taking a photograph sixty times a second, and each one
   adds a little more: wherever you look, that part of the room fades up out of
   the white over about a second — colour, shading and relief together — and
   stays. A compass along the bottom of the view shows which directions are
   still blank. Nothing is on a clock; it waits for you.
3. **Press Done.** The scan ends when you say so. Inside the headset, a
   double-tap on the case does the same thing. **Done stops the learning**: the
   room is then kept exactly as you scanned it. It won't drift towards a room
   that has since changed, and a direction you never scanned stays blank rather
   than filling itself in later. *Rescan* is how you ask for a new one.
4. **You are now standing in a blocky model of your room.** Anyone who walks in
   is not in that model, so they never appear.

That's the whole thing. There's no score, no timer, nothing to win — it's a way
of seeing, not a game.

## How it works

The trick is a **world-locked plate**. During the scan the phone paints what the
camera sees onto a sphere that stays put while your head turns — so at any moment
it can say what the room looked like when nobody was in it, in the exact
direction you happen to be facing.

The plate starts out **white with no confidence**, and every direction walks from
white to the truth on one curve as more photographs of it arrive. That curve is
the build-up you watch: an unscanned wall is blank paper, a wall that has been
photographed a dozen times is a fifth of the way there, and one you have dwelt on
for a second is done.

### Where the surface is: measured, or guessed

Turning on the spot tells the phone which way it is pointing and nothing else.
Every photograph is taken from the same point, so there is no parallax in them
and **no depth to recover** — which is why, on its own, this can only take the
room to be **a box with you standing in the middle of it**. That guess is right
for the walls, and the corners it produces keep the result reading as a place
rather than as wallpaper, but it cannot tell a bed from the wall behind the bed.

**Measure the room in 3D** fixes that, on Android. It opens an AR session, which
knows where the phone *is* as well as which way it faces and hands over a depth
map with every frame — angle, location, and what the camera sees, which between
them put every pixel at a place in the room. Those places are collected into one
distance per direction, measured out from where you started. From one standing
point nothing is ever behind anything else, so one distance per direction is the
whole room, and a bed comes out as a bed.

The drawing doesn't change at all: it already asks "how far is the surface, this
way?" and marches cubes up to it. It just gets a true answer instead of a guessed
one. Where nothing was measured it falls back to the box, blended at the join so
a half-scanned edge isn't a cliff. And once the room has been measured there is
nothing left to invent, so the brightness-driven relief drops away to a token —
the bed is a bed because it was measured to be one, not because it was lighter
than the wall.

Scanning has to be done **holding the phone**, walking around the room: phone AR
draws to the screen, so it can't happen inside the headset. Measure first, then
put it in the Cardboard and look at what you captured.

**iPhone can't do this, LiDAR or not.** Every browser on iPhone — Safari,
Chrome, all of them — runs on the same engine, and that engine has never
shipped the web API this needs. It makes no difference whether the phone has a
LiDAR scanner; the web page has no way to ask for it. On iPhone the app tells
you so and falls back to the guessed box. Reaching an iPhone's LiDAR at all
would mean a native app instead of a web page — a different, much bigger
project than this one.

Space is then cut into a lattice of cubes. For each direction you look, a ray
walks that lattice until it meets a solid cube, and the cube's face is shaded by
which way it points: floor-side faces brightest, ceiling-side darkest, the two
wall directions in between. That flat per-face shading is most of what says
"cube" to the eye.

Cubes don't all sit flush with the wall. Each column stands proud of it by a
whole number of cubes, taken from how bright that part of the room is **compared
with the rest of that room** — not against a fixed number. Judging it absolutely
only worked for a room of roughly the brightness it was tuned on: a white room
sat past the top of the range, so every column got pushed the same maximum
amount, and maximum everywhere draws exactly like flat everywhere. A bright room
came out as a smooth empty box. How deep that relief goes is set as a real depth, not
a number of cubes, so making the cubes smaller makes the detail finer instead
of flattening the room.

The heights themselves come off a **coarser lattice than the cubes** — a few
cubes to a step. Taking a height per cube let the grain of the wall, and the
camera's own speckle, flip single cubes in and out; the result read as static
rather than as a room. Coarse heights with fine cubes give terraces: the shape
stays architectural while the surface keeps its detail.

Two things keep this cheap enough for a phone. A headset viewer only ever turns,
never walks, so the whole block world is a function of direction alone and a ray
can start just short of the wall instead of at the eye — a handful of lattice
steps, not hundreds. And the colours are quantised by **brightness only**, never
per channel, because rounding red, green and blue separately drags a beige wall
off towards olive or maroon, which looks like a fault in the camera.

### Keeping people out of the model

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

### The camera view

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

- **The blocks are on a guessed box, not measured depth.** A chair in the middle
  of the floor does not become a lump in the middle of the floor; it lands on the
  wall behind it, as relief. The shape you stand in is a room-shaped box every
  time, whatever shape your room really is.
- **One camera means one picture.** Both eyes get the same view. It tracks your
  head correctly when you turn, but there is no real depth — near things don't
  sit nearer. It is comfortable enough; it isn't true stereo.
- **Turning is fine, walking is not.** The plate assumes your head rotates about
  roughly one point. Take three steps and everything shifts against it and the
  room stops matching. It knows, and says so — *the room has changed — press
  rescan* — but it will not quietly rebuild itself, because Done means done.
- **Anyone standing still during the scan gets built into the room**, and then it
  thinks they're furniture. This is why the scan asks for an empty room and why
  Done is yours to press: don't press it until everyone is out of shot. They'll
  fade out once they move; *Rescan* fixes it outright.
- **A blank white wall gives it nothing to work with.** Rooms with texture in
  them work better, and come out with more relief.

## If it looks wrong

Everything below is in **Settings** on the start screen.

| What you see | What to change |
|---|---|
| The room stays white | Keep turning — and check **Camera turned** below |
| A patch stayed white after Done | It was never scanned. *Rescan* and cover it |
| Cubes too coarse, or too fine to read | **Block size** |
| You want the real picture instead | **Show** → *the camera* |
| The view is sideways, or squashed | **Camera turned** — try 90°, then 270° |
| Straight lines bow, or the edges are blurry | **Lens correction**, and **Eye spacing** |
| The two halves don't merge into one image | **Eye spacing** |
| Not using a headset | Turn **Stereo** off for a single full-screen view |

The last three settings — **Spot people**, **Hide people** and **How completely**
— only do anything in the camera view. Among blocks nothing live is drawn at all,
so there is nothing to hide.

If the picture starts coming apart, that's the safety valve saying the plate no
longer matches the room. It stops trusting the difference, and since Done
stopped the learning, *rescan* is what puts it right.

## The files

```
index.html   the page, the start screen, the settings
styles.css   the look
vr.js        the renderer — plate, blocks, mask, stereo, lens; all on the GPU
app.js       orientation, the scan, tracking people, the settings
```

Plain HTML, CSS and JavaScript. No libraries, no build step, no install. Edit a
file, reload the page.

`window.KEMOSH` is left on the page on purpose: `KEMOSH.state()` reports what the
page currently believes — coverage, tracked people, how much of the mask is
lit — which is the quickest way to see why something isn't behaving on a real
phone.
