# KEMOSH

A camera passthrough tool for a phone and a cardboard headset. You scan the
empty room from every angle, press **Done**, and from that moment **the people
in it are invisible**. Someone walks in front of you and you see the wall
behind them.

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
to look around. Everything else behaves identically — it runs through the same
pipeline as the real camera.

## How to use it

1. **Scan every angle.** Turn all the way round on the spot, with nobody in front
   of you, while the phone learns the empty room. A compass along the bottom of
   the view shows which directions are still dark — turn until they are all lit.
   Nothing is on a timer; it waits for you.
2. **Press Done.** The scan ends when you say so, not when a clock runs out.
   Inside the headset, a double-tap on the case does the same thing.
3. **From then on, people are invisible.** Anyone who walks in front of you
   simply isn't drawn — you see the room behind them, wherever in view they are.

That's the whole thing. There's no score, no timer, nothing to win — it's a way
of seeing, not a game.

## How the erasing works

The trick is a **world-locked plate**. During the scan the phone paints what the
camera sees onto a sphere that stays put while your head turns — so at any moment
it can say what the room looked like when nobody was in it, in the exact
direction you happen to be facing.

Compare that plate against the live frame and what's left over is whatever the
room doesn't account for: a person. Brightness and colour are compared
separately, because a phone's auto-exposure shifts the whole frame at once and
colour survives that better than brightness does.

Then the leftover is shaped into people — connected blobs, filtered by how tall,
wide and solid they are — and tracked from frame to frame so each one keeps an
identity while it moves. **Every pixel of a tracked person** is then drawn from
the plate instead of from the camera. Not a hole cut through them: the whole
silhouette.

That is what pressing Done switches on. Before it, nothing is erased — the phone
is still learning and would only be guessing. After it, people are gone wherever
they stand. *Settings → Hide people → only where I look* puts the erasing back on
a leash, so they fade only as you turn towards them, and reappear again when you
look away.

Nothing is downloaded, no model runs, and no picture leaves the phone. It is
arithmetic on the frame in front of you.

### What it can't do

Worth knowing before it surprises you:

- **One camera means one picture.** Both eyes get the same view. It tracks your
  head correctly when you turn, but there is no real depth — near things don't
  sit nearer. It is comfortable enough; it isn't true stereo.
- **Turning is fine, walking is not.** The plate assumes your head rotates about
  roughly one point. Take three steps and everything shifts against it, the room
  stops matching, and it knows: erasing switches off and the plate relearns,
  which you'll see as *the room changed — relearning it*.
- **Anyone standing still during the scan gets painted into the plate**, and then
  the room thinks they're furniture — they stay visible. This is why the scan
  asks for an empty room and why Done is yours to press: don't press it until
  everyone is out of shot. They'll fade back in once they move; *Rescan* fixes it
  outright.
- **A blank white wall gives it nothing to work with.** Rooms with texture in
  them work better.

## If it looks wrong

Everything below is in **Settings** on the start screen.

| What you see | What to change |
|---|---|
| The view is sideways, or squashed | **Camera turned** — try 90°, then 270° |
| Straight lines bow, or the edges are blurry | **Lens correction**, and **Eye spacing** |
| The two halves don't merge into one image | **Eye spacing** |
| Nobody ever vanishes | Raise **Spot people**, then *rescan* |
| Things vanish that aren't people | Lower **Spot people** |
| People only fade when you face them | **Hide people** → *wherever they are* |
| You want the camera plain, with no erasing | **How completely** down to 0 |
| Not using a headset | Turn **Stereo** off for a single full-screen view |

If the whole view starts dissolving at once, that's the safety valve saying the
plate no longer matches the room. It stops erasing by itself and repaints. Press
*rescan* to do it deliberately.

## The files

```
index.html   the page, the start screen, the settings
styles.css   the look
vr.js        the renderer — plate, mask, stereo, lens, everything on the GPU
app.js       orientation, the scan, tracking people, the settings
```

Plain HTML, CSS and JavaScript. No libraries, no build step, no install. Edit a
file, reload the page.

`window.KEMOSH` is left on the page on purpose: `KEMOSH.state()` reports what the
page currently believes — coverage, tracked people, how much of the mask is
lit — which is the quickest way to see why something isn't behaving on a real
phone.
