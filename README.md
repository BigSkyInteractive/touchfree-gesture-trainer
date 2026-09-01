# TouchFree Gesture Trainer — the live camera feed and recognizer telemetry, on a web page

An interactive web page to onboard users to gesture control using the TouchFree API for gesture control and video frame imbedded in the page.

User clicks three targets a pointed finger, waves left and right, and gets a "Good Job". Beside them, a circular live view of
themselves with their own skeleton drawn on it, which zooms in on their hand the
moment the tracker locks onto it.

This is a shipping [TouchFree](https://bigskyinteractive.com) content page, published for free to use as an example how to use gesture interaction and use the camera view from TouchFree with landmark and skeleton overlay.

1. **Show the live camera** with the tracker's own overlay geometry on top.
2. **Read the recognizer's per-frame telemetry**, so a page can tell somebody
   *why* a gesture did not register instead of just staying silent.

Everything here is plain HTML, one JavaScript file and one JSON file. No build
step, no framework, no external requests.

---

## How a TouchFree page works, in one paragraph

TouchFree runs a local server on the machine the camera is plugged into. Your
page is served from it, so it is **same-origin** and can call the API and open
the WebSocket with no CORS setup and no credentials. Gestures arrive as ordinary
browser input: the pointing finger moves a real cursor and dispatches real
`mousemove` and `click` events, and the wave dispatches `ArrowRight` and
`ArrowLeft`. A page that only wants gestures needs no API at all — a plain
button with a `click` handler already works. Everything below is for pages that
want more than that.

---

## 1. The live camera feed

The feed is **MJPEG**, consumed by an ordinary `<img>`:

```html
<img id="feed" alt="">
```
```js
feed.src = '/api/camera/setup/mjpeg?t=' + Date.now();
```

That is the whole integration. The picture is the full camera frame, mirrored,
at the camera's own capture resolution.

### Three things that will catch you out

**Nothing is produced until a camera profile is bound.** Call
`GET /api/camera/detect` first, once, and check the result. Until it has run in
the current server session the stream returns nothing at all, and it fails
*silently* — the `<img>` simply stays blank with no error anywhere.

```js
const r = await (await fetch('/api/camera/detect')).json();
if (!r.ok || r.detection.status !== 'detected') { /* say so on screen */ }
const { capture_width, capture_height } = r.detection.profile;
```

**Opening the stream is what turns it on.** Encoding is gated on there being a
consumer, so nothing is encoded and no bandwidth is used while nobody is
watching. Closing the page stops it. That also means the overlay messages in
section 2 only flow while the feed is open.

**Do not poll it back to life.** It is tempting to watch the `<img>` `load`
event and reopen the stream when one has not fired for a while. A hidden or
1-pixel `<img>` does not reliably fire that event, so a naive watchdog reopens a
perfectly healthy stream once a second forever, and the picture visibly flashes
each time. Take liveness from the WebSocket instead (section 2) — the overlay
message is emitted on the same gate and the same cadence as the JPEG, so its
arrival *is* proof the feed is running. If you must reconnect, load into a
**separate `Image`** and only swap it in once it has decoded a frame, so the
visible source is never empty. `openFeed()` in `training.js` does both.

### Drawing it yourself

If you want to pan, zoom or mask the picture, keep the `<img>` off-screen and
use it as a decode source for a `<canvas>`:

```js
ctx.drawImage(feed, sx, sy, sw, sh, dx, dy, dw, dh);
```

Compose into an **offscreen** canvas and blit the finished frame to the visible
one. A frame that is mid-decode throws from `drawImage`, and if you have already
cleared the visible canvas you get a black flash; composing offscreen means a
failed frame never reaches the screen and the previous good one stays up.

---

## 2. The WebSocket

One connection, several message types:

```js
const ws = new WebSocket(`ws://${location.host}/ws`);
ws.onmessage = e => {
  const m = JSON.parse(e.data);
  switch (m.type) { /* ... */ }
};
```

Store the newest payload in your handler and **return**. Do all drawing in one
`requestAnimationFrame` loop. Messages arrive at up to 30 Hz while you render at
60, so anything that draws in a socket callback either wastes frames or
stutters.

### `camera_setup_state` — the overlay geometry

Arrives while the video feed is open, at the same cadence. Everything in it is
in **mirrored pixel space**, the same coordinates as the MJPEG picture, so
landmarks land on the person with no conversion.

```json
{
  "frame_w": 1920, "frame_h": 1080,
  "roi": { "x1": 700, "y1": 300, "w": 480, "h": 480, "mode": "tracking" },
  "active_hand": "right",
  "body_keypoints_px": [[x, y, visibility], "... 33 entries, null where unseen ..."],
  "hand_landmarks_px": [[x, y], "... 21 entries, null when no hand ..."]
}
```

- `roi` is the crop the hand tracker is working in. `mode` is `no_hand`,
  `acquiring` or `tracking`. **`tracking` is the lock signal** — it is what this
  page eases its zoom on.
- An entry may be `null`: the camera could not see that point. The index is kept
  so numbering holds. Guard before reading one, and treat `null` as "drop it",
  never as "keep drawing it at the old place".
- The ROI is deliberately much larger than the hand, so the hand can move inside
  it between detections. Do not expect it to hug the fingers.

### `pointer_fast` — the cursor, ~30 Hz

```json
{
  "pointer": { "xy": [0.5, 0.3], "visible": true, "engaged": true },
  "hand":    { "present": true, "handedness": "Right" },
  "landmark":{ "hand_state": "pointing", "splayed": false }
}
```

`hand_state` is `pointing`, `open_palm` or `none`. `splayed` distinguishes a
spread open palm from a closed one. `pointer.xy` is normalised 0–1.

### `semantic_slow` — click commitment, ~10 Hz

```json
{ "click": { "allowed": true, "state": "priming", "prime_progress": 0.62 },
  "gates": { "pointer_engaged": true, "not_in_cooldown": true } }
```

`prime_progress` is 0–1, how close the click is to firing. It is what drives the
star in this page.

### `click_event` and `gesture_command` — it fired

```json
{ "type": "gesture_command",
  "payload": { "action": "navigate_forward", "confidence": 1.0 } }
```

`navigate_forward` and `navigate_back` are the wave. They are also what get
turned into `ArrowRight` and `ArrowLeft` for the page.

### `controls_changed` — what is switched on

An operator can turn any gesture off. When they do, its engine is skipped
entirely and it can never fire. Read `GET /api/kiosk/status` once on load, then
follow `controls_changed`:

```json
{ "gesture_cursor_enabled": true, "gesture_click_enabled": true,
  "gesture_wave_enabled": true,  "gesture_rotate_enabled": false }
```

**Honour it.** A page still saying "wave to continue" with the wave switched off
is asking for something that physically cannot happen. Name the missing control
instead.

---

## 3. Subscribing to the recognizer telemetry

This is the part that makes a training page possible, and it is **opt-in**. A
client that does not ask for it does not receive it, because it is a large
payload and most pages have no use for it.

```js
ws.onopen = () => ws.send(JSON.stringify({ type: 'subscribe', diagnostics: true }));
```

Send it again with `false` to stop. It ends by itself when the socket closes.

Once subscribed, `pointer_fast` carries a `diagnostics` object. Without the
subscription the key is **absent**, not empty, so guard on it.

### Why it exists

A recognizer either fires or stays silent. Silence alone cannot tell somebody
whether they moved too little, moved the wrong way, or were not in a state where
anything could be measured. The telemetry publishes each condition **as a
measurement beside the threshold it is judged against**, so your page compares
them itself and never hardcodes a number that could be retuned later.

### `diagnostics.wave`

```json
{ "stage": "live",
  "shrink_frac": 0.31, "press_enter": 0.25,
  "toward_thumb": 0.08, "lean_deadband": 0.06,
  "descent_px_s": 12.0, "descent_limit": 225.0,
  "armed": true, "cooled": true, "baseline_ready": true, "fired": false }
```

`stage` says what the frame was, and it matters as much as the numbers:

| `stage` | meaning |
|---|---|
| `no_hand` | nothing usable to measure this frame |
| `idled` | the frame was routed elsewhere. It does **not** say why — use `pointer_fast`'s `hand_state` and `splayed` to tell an open palm from a spread one from no pose at all |
| `baseline_pending` | still learning this person's resting hand. **Normal, not a fault** — it takes a couple of seconds of a steady open palm, and nothing can fire until it completes. Say so rather than showing a dead bar |
| `live` | measuring against a learned baseline; every field below is meaningful |

On a `live` frame:

| pair | what it tells the visitor |
|---|---|
| `shrink_frac` vs `press_enter` | how far the movement got. Under the threshold: not far enough |
| `toward_thumb` vs `lean_deadband` | which way it went. Inside the deadband: they moved but picked no direction, the most common failure |
| `descent_px_s` vs `descent_limit` | over the limit, it read as a hand being lowered and was suppressed |
| `armed` | `false` until the hand returns to rest. One movement cannot fire twice |
| `cooled` | `false` during the refractory period after a fire |

`armed` and `cooled` are booleans because they are internal state you cannot
recompute. Everything else is a published measurement — compare it yourself.

### `diagnostics.rotate`

The same idea for the rotate dial: a measured angle, the adopted rest baseline,
the deviation from it, an `engaged` flag, and a `stage` of `not_splayed`,
`no_hand`, `flip_guard`, `baseline_pending`, `edge_on` or `live`.

---

## 4. Things this page does that are worth copying

**Cap the zoom.** When zooming to the hand, never magnify past 1:1 — the source
is a camera frame and blowing it up past its own pixels only makes it soft. This
page also caps how much of its circular mask the crop may fill, so there is
always frame around the hand.

**Do not smooth the tracker's output.** It is smoothed already. Adding a filter
on top puts two in series, roughly doubles the lag, and a filter chasing a
target that only updates at the feed's cadence never catches up — it trails and
rubber-bands. Draw the geometry exactly as it arrives. This page learned that
the hard way and the comment is still in `training.js`.

**Let the server decide.** Never re-derive whether a gesture happened. The
cursor dispatches real clicks, so an ordinary DOM `click` handler on a button is
the whole of it. A page that scored gestures itself would teach people to
satisfy the page rather than the product.

**Say what is missing, by name.** A clip that is not on disk is reported on
screen with its filename. A gesture that is switched off says so. A page that
quietly shows a black rectangle teaches the visitor that the product is broken.

---

## Configuration

Everything the page says and does is in **`lessons.json`**: the lessons and
their order, every line of coaching, which clip each uses, the target positions
and size, how much of the mask the zoom may fill, and how long the finish screen
holds. The JavaScript reads it and never contains a word of copy or a tuned
number.

Target positions are fixed rather than random, so the visitor learns where to
reach. `avoid` and `avoid_rects` do not place anything — they are the check: on
load the page reports any configured target overlapping the camera view, the
coaching line or the left column, by name, in the console.

## Running it

Serve this folder from a TouchFree machine and open `index.html`. As a shipped
content page it appears in the dashboard's content list by folder name.

## Files

| File | Role |
|---|---|
| `index.html` | Markup and style only. Every element id here is `training.js`'s contract |
| `training.js` | The integration: feed, WebSocket, overlay drawing, scoring, game |
| `lessons.json` | Every setting and every word |
| `media/*.webm` | The demonstration clips |

## Also from TouchFree

- [touchfree-fluid-body](https://github.com/BigSkyInteractive/touchfree-fluid-body) — body landmarks driving a WebGL fluid simulation
- [touchfree-receiver-kit](https://github.com/BigSkyInteractive/touchfree-receiver-kit) — driving rigged 3D characters
- [touchfree-puppet-2d](https://github.com/BigSkyInteractive/touchfree-puppet-2d) — a flat cartoon puppet that copies the person

## License

MIT — see [LICENSE](LICENSE).
