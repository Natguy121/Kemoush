# KEMOSH

A VR game for a phone and a cardboard headset. You see the room through the
camera, in stereo, exactly as it is — except that **anything you look at straight
on stops being there**.

People in the room are the game. You hunt them, and the one thing you may not do
is look at them.

## Getting it onto a phone

The camera is only handed out to pages served over **https**, so opening the file
off a memory card won't work. Two ways round that:

- **GitHub Pages.** In this repository: *Settings → Pages → Source: deploy from
  branch*, pick the branch, save. A minute later the game is at
  `https://natguy121.github.io/Kemoush/`. Open that on the phone.
- **Any other web host.** It is four plain files with nothing to build. Copy them
  anywhere that serves https.

Then: open the page, tap **Use the camera**, allow it, put the phone in the
headset. It goes fullscreen and locks to landscape on its own.

No camera handy, or trying it on a laptop? **Play the room instead** builds a
room out of arithmetic and puts people in it. Drag with the mouse, or use the
arrow keys, to look around. Everything else behaves identically — it runs through
the same pipeline as the real camera.

## How to play

1. **Scan.** Turn slowly on the spot with nobody in front of you. The phone is
   learning what the empty room looks like. It takes a few seconds and the bar
   tells you how far along it is.
2. **Hunt.** A phantom is a person the room doesn't account for. Each one gets a
   ring around it.
3. **Do not look at them.** Hold a phantom off to one side — outside the faint
   circle in the middle — and its ring fills up. Full ring, banished, points, and
   four seconds back on the clock.
4. **Facing one unmakes it.** It dissolves, the ring empties, and the streak
   dies. Instinct says turn to face what you are chasing. Instinct is wrong here.

Each banishing makes the next harder: the cone that unmakes them grows, and the
rings take longer to fill. A streak multiplies the score up to ×9, and blinking —
letting one drift into the middle while it was charging — resets it.

Inside a headset there are no buttons, so **double-tap the case**: that ends a
round, and starts the next one from the score screen.

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
identity while it moves. When a tracked person drifts into the middle of your
view, **every pixel of that person** is drawn from the plate instead of from the
camera. Not a hole cut through them: the whole silhouette, dissolving.

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
  the room thinks they're furniture. They'll fade back in once they move. *Rescan*
  fixes it outright.
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
game.js      orientation, finding and tracking people, the rules, the scoring
```

Plain HTML, CSS and JavaScript. No libraries, no build step, no install. Edit a
file, reload the page.

`window.KEMOSH` is left on the page on purpose: `KEMOSH.state()` reports what the
game currently believes — coverage, tracked phantoms, how much of the mask is
lit — which is the quickest way to see why something isn't behaving on a real
phone.
