/*
Gesture Training -- TouchFree content page.

WHAT THIS FILE DOES AND DELIBERATELY DOES NOT DO.

It renders. Every gesture number on screen was measured by the server and
arrives over the WebSocket; this page never decides whether a gesture
happened, never smooths a position, never re-derives a threshold. That is the
TouchFree rule: the server is the sole authority and the
UI is a pure renderer. A training page that scored gestures itself would teach
people to satisfy the page rather than the product.

THE ONE MESSAGE THIS PAGE SENDS. The per-frame recognizer telemetry is
opt-in: a client that does not ask for it does not receive it.
This page asks, in connect(). Without that subscribe every gate reading would
be permanently blank, so it is checked for and reported rather than assumed.

FRAME BUDGET. Socket handlers store the newest payload and return. All drawing
happens in one requestAnimationFrame loop. body/setup data arrives at ~15 Hz
and pointer_fast at 30 while the page renders at 60, so anything that drew in a
socket callback would either waste frames or stutter. Text is written only when
its value actually changes, never 30 times a second.
*/
'use strict';

(function () {

  // ---- design box -------------------------------------------------------
  // Fixed 1920x1080, scaled to whatever screen it lands on. Same mechanic as
  // content/pages/bsi_videos. Every number in this file is a design pixel.
  var DESIGN_W = 1920, DESIGN_H = 1080;
  var CAM_W = 980, CAM_H = 760;     // must match #camera in index.html
  var MASK_D = 760;                 // the porthole diameter, must match
                                    // the clip-path on #view
  var SUPERSAMPLE = 2;              // canvas backing store multiplier

  function fit() {
    document.documentElement.style.setProperty('--fit',
      Math.min(window.innerWidth / DESIGN_W, window.innerHeight / DESIGN_H));
  }
  window.addEventListener('resize', fit);
  fit();

  // ---- landmark tables --------------------------------------------------
  // TouchFree's landmark order, and the same edge tables the dashboard's own
  // camera view uses, so the two draw the same body.
  // The eleven head points are deliberately not drawn: at kiosk distance they
  // cluster into a scribble over the person's face, and nothing downstream
  // steers on them.
  var BODY_EDGES = [
    [5, 6], [5, 11], [6, 12], [11, 12],
    [5, 7], [7, 9], [6, 8], [8, 10],
    [11, 13], [13, 15], [12, 14], [14, 16],
    [9, 23], [9, 25], [9, 27], [23, 25],
    [10, 24], [10, 26], [10, 28], [24, 26],
    [15, 29], [29, 31], [15, 31], [16, 30], [30, 32], [16, 32]
  ];
  var BODY_POINTS = [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
                     23, 24, 25, 26, 27, 28, 29, 30, 31, 32];
  var HAND_EDGES = [
    [0, 1], [1, 2], [2, 3], [3, 4],
    [0, 5], [5, 6], [6, 7], [7, 8],
    [9, 10], [10, 11], [11, 12],
    [13, 14], [14, 15], [15, 16],
    [0, 17], [17, 18], [18, 19], [19, 20],
    [5, 9], [9, 13], [13, 17]
  ];
  var HAND_TIPS = { 4: 1, 8: 1, 12: 1, 16: 1, 20: 1 };

  // ---- state ------------------------------------------------------------
  var lessons = null, lessonIx = 0;
  var controls = {};                 // which interactions the operator has on
  var fast = null, slow = null, setup = null;   // newest payload of each kind
  var lastFrameTs = 0;               // MJPEG watchdog
  var feedImg = null, pendingFeed = null;
  var fired = { at: 0, label: '' };  // most recent gesture_command / click

  // The view transition. 0 = whole frame with the body drawn, 1 = zoomed on
  // the hand ROI with the hand drawn. Eased toward `tTarget` every frame.
  var t = 0, tTarget = 0;

  var el = {};
  ['stage', 'lessonTitle', 'clip', 'clipVideo', 'missingFile',
   'scale', 'camera', 'feed', 'view', 'noFeed', 'fault',
   'clipCanvas',
   'faultBody', 'play', 'cursorState', 'cursorText', 'star', 'starBurst',
   'arrows', 'keyLeft', 'keyRight', 'done', 'doneTitle', 'doneSub'].forEach(function (id) { el[id] = document.getElementById(id); });

  function fault(text) {
    el.faultBody.textContent = text;
    el.fault.classList.add('on');
    console.error('[training] ' + text);
  }

  // Write text only when it changes. Called at frame rate.
  function setText(node, s) { if (node && node.__last !== s) { node.__last = s; node.textContent = s; } }
  function setClass(node, name, on) { if (node) node.classList.toggle(name, !!on); }
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function lerp(a, b, k) { return a + (b - a) * k; }

  // =======================================================================
  // Lessons
  // =======================================================================

  function lesson() { return lessons.lessons[lessonIx]; }

  function show(i) {
    lessonIx = (i + lessons.lessons.length) % lessons.lessons.length;
    var L = lesson();

    setText(el.lessonTitle, L.title);

    // The clip. A named file that is not on disk is reported by name.
    var src = (lessons.media_dir || 'media') + '/' + L.video;
    el.clip.classList.remove('no-media');
    el.missingFile.textContent = src;
    el.clipVideo.onerror = function () { el.clip.classList.add('no-media'); };
    if (L.poster) el.clipVideo.poster = (lessons.media_dir || 'media') + '/' + L.poster;
    el.clipVideo.src = src;
    // The clip runs continuously again, at the rate lessons.json asks for.
    // It loops; that was never what made the page blink (it was the MJPEG
    // watchdog reopening the stream every second -- see openFeed).
    el.clipVideo.loop = true;
    el.clipVideo.playbackRate = gameCfg().clip_rate || 1;
    var pl = el.clipVideo.play();
    if (pl && pl.catch) pl.catch(function () { /* autoplay refusal is not a fault */ });

    buildScale(L);
  }

  // =======================================================================
  // The target game
  //
  // Three buttons appear over the screen and the visitor clears them with the
  // gesture this page teaches: the cursor is the fingertip, the click is the
  // finger tipping forward. Nothing here decides whether a click happened --
  // the gesture pipeline dispatches a real mouse click through CDP, so an
  // ordinary DOM click handler is all a target needs, and the page stays a
  // renderer.
  // =======================================================================

  var targets = [];          // live target elements
  var waveDone = { navigate_forward: false, navigate_back: false };

  function gameCfg() { return (lessons && lessons.game) || {}; }

  // FIXED POSITIONS, from lessons.json. The targets do not move between
  // rounds: the visitor learns where to reach instead of hunting a new layout
  // every time, and the placement can be checked once here rather than being
  // re-rolled by the page and hoped about.
  //
  // The keep-outs are no longer used to PLACE anything, only to check what was
  // configured. Reported by name, in the console, once at load: a target
  // sitting on the camera view or the coaching line is a settings mistake, and
  // it should be named rather than silently drawn on top of something.
  function checkPositions(g) {
    var r = g.radius, av = g.avoid, rects = g.avoid_rects || [], ps = g.positions || [];
    ps.forEach(function (P, i) {
      var bad = [];
      if (av && Math.sqrt((av.cx - P.x) * (av.cx - P.x) +
                          (av.cy - P.y) * (av.cy - P.y)) < av.r + r) bad.push('the camera view');
      rects.forEach(function (R) {
        var nx = Math.max(R.x, Math.min(P.x, R.x + R.w));
        var ny = Math.max(R.y, Math.min(P.y, R.y + R.h));
        if (Math.sqrt((P.x - nx) * (P.x - nx) + (P.y - ny) * (P.y - ny)) < r) bad.push(R.name || 'a reserved area');
      });
      if (bad.length) {
        console.warn('[training] target ' + (i + 1) + ' at (' + P.x + ',' + P.y +
                     ') overlaps ' + bad.join(' and ') + '. Move it in lessons.json.');
      }
    });
  }

  function place() {
    return (gameCfg().positions || []).slice();
  }

  function spawn() {
    var g = gameCfg(), r = g.radius || 92;
    el.play.innerHTML = '';
    targets = [];
    place().forEach(function (p, i) {
      var d = document.createElement('div');
      d.className = 'target';
      d.style.left = (p.x - r) + 'px';
      d.style.top = (p.y - r) + 'px';
      d.style.width = d.style.height = (2 * r) + 'px';
      d.textContent = (i + 1);
      d.addEventListener('click', function () { hit(d); });
      el.play.appendChild(d);
      targets.push(d);
    });
  }

  function hit(d) {
    if (d.classList.contains('hit')) return;
    d.classList.add('hit');
    if (!targets.every(function (t) { return t.classList.contains('hit'); })) return;
    // One round of clicks is the whole click lesson. Clear it and the page
    // moves to the wave rather than spawning more of the same. No counters:
    // the score head was removed, and a tally nobody can see is dead weight.
    el.play.innerHTML = '';
    targets = [];
    setTimeout(function () {
      if (lessons.lessons.length > 1) show(1);
    }, 900);
  }

  // The wave lesson is done when BOTH directions have been sent once. The two
  // keycaps above the clip are the progress: each lights when its key goes out
  // and stays marked.
  function markWave(action) {
    if (!(action in waveDone)) return;
    waveDone[action] = true;
    flashKey(action === 'navigate_back' ? el.keyLeft : el.keyRight);
    if (waveDone.navigate_forward && waveDone.navigate_back) finish();
  }

  // A key STAYS marked once its direction has been sent, so the two caps are
  // the progress through the lesson: one lit means one to go.
  function flashKey(node) {
    if (node) node.classList.add('lit');
  }

  function finish() {
    var c = gameCfg().copy || {};
    setText(el.doneTitle, c.complete || 'Training complete');
    var sub = c.restart || '';
    setText(el.doneSub, sub);
    el.doneSub.style.display = sub ? '' : 'none';
    el.done.classList.add('on');
    setTimeout(restart, gameCfg().restart_ms || 4500);
  }

  function restart() {
    el.done.classList.remove('on');
    waveDone.navigate_forward = waveDone.navigate_back = false;
    el.keyLeft.classList.remove('lit');
    el.keyRight.classList.remove('lit');
    show(0);
    spawn();
  }

  function remaining() {
    var n = 0;
    for (var i = 0; i < targets.length; i++) {
      if (!targets[i].classList.contains('hit')) n++;
    }
    return n;
  }

  // =======================================================================
  // The score scale
  // =======================================================================

  var scaleEls = {};

  // Every lesson's readout is now the coaching line plus, for the click, the
  // star in the left column. The Press and Lean bars and the gate table were
  // removed: they were instrument panels, and this page is for
  // a visitor, not a bench. The measurements behind them are unchanged and
  // still arrive on the wire; nothing is drawing them.
  function buildScale(L) {
    el.scale.innerHTML = '';
    scaleEls = {};
    var v = document.createElement('div');
    v.className = 'verdict';
    el.scale.appendChild(v);
    scaleEls.verdict = v;
  }

  // THE CLICK STAR. Grows and brightens with the commitment the server
  // publishes, snaps to full on the click, then fades on its own. Driven every
  // frame from prime_progress, so it is the same measurement the old bar
  // showed, just shaped like feedback instead of furniture.
  var starHold = 0, starFired = false;
  function starDrive(progress, justHit) {
    if (!el.starBurst) return;
    if (justHit) starHold = Date.now();
    var since = Date.now() - starHold;
    var burst = starHold && since < 900 ? 1 - (since / 900) : 0;
    setClass(el.star, 'landed', burst > 0);
    var v = Math.max(Math.min(progress || 0, 1), burst);
    el.starBurst.style.opacity = v.toFixed(3);
    el.starBurst.style.transform = 'scale(' + (0.35 + 0.75 * v).toFixed(3) + ')';
  }

  function justFired() { return (Date.now() - fired.at) < 1400; }

  function updateScale() {
    var L = lesson(), s = L.scale;
    if (controls[L.control] === false) {
      say(s.label + ' is switched off in Kiosk Manager', 'warn');
      return;
    }
    if (s.kind === 'pose')   return scalePose(s);
    if (s.kind === 'click')  return scaleClick(s);
    if (s.kind === 'wave')   return scaleWave(s);
    if (s.kind === 'rotate') return scaleRotate(s);
  }

  function say(text, cls) {
    setText(scaleEls.verdict, text);
    scaleEls.verdict.className = 'verdict' + (cls ? ' ' + cls : '');
  }

  // What the round wants next, in the game's own words. Falls back to the
  // lesson's coaching whenever the cursor is not ready to click anything.
  function roundLine() {
    var c = (gameCfg().copy) || {};
    var n = remaining();
    if (n === 0) return c.done || 'Round cleared';
    if (n === 1) return c.last || 'One more';
    if (n === targets.length) return c.start || 'Point at a target and click it';
    return c.progress || 'Keep going';
  }

  // The index-finger pose. index_extended_score is the server's own 0..1
  // reading of how extended the finger is; hand_state is its verdict.
  function scalePose(s) {
    var lm = fast && fast.landmark, hand = fast && fast.hand;
    if (!hand || !hand.present) { return say(s.hint_idle); }
    var score = (lm && lm.index_extended_score) || 0;
    var ok = lm && lm.hand_state === 'pointing';
    if (ok) return say(s.hint_pass, 'pass');
    say(s.hint_working);
  }

  // Click has a genuine live progress value on the wire and always has had.
  function scaleClick(s) {
    var c = slow && slow.click;
    var hit = justFired() && fired.label === 'click';
    starDrive(c ? c.prime_progress : 0, hit && !starFired);
    starFired = hit;
    if (hit) return say(s.hint_pass, 'pass');
    if (!c || !c.allowed) return say(s.hint_idle);
    say((c.prime_progress || 0) > 0.05 ? s.hint_working : roundLine());
  }

  // The wave. Every one of these numbers is the recognizer's own, published
  // beside the threshold it is judged against, so the bar and the gate mark
  // come from the same place the decision did.
  function scaleWave(s) {
    var w = fast && fast.diagnostics && fast.diagnostics.wave;
    if (!w) { return say(diagMissing() || s.hint_idle); }

    if (justFired() && fired.label === 'wave') {
      // Name the key the gesture actually dispatched: TouchFree sends
      // ArrowRight for forward and ArrowLeft for back, so this is what a
      // content page underneath would just have received.
      return say(fired.action === 'navigate_back'
                 ? s.hint_pass_back : s.hint_pass_forward, 'pass');
    }
    if (w.stage === 'idled' || w.stage === 'no_hand' || w.stage === 'reset') { return say(s.hint_idle); }
    if (w.stage === 'baseline_pending') { return say(s.hint_learning); }
    // live. The coaching line names the gate that is blocking, each one a
    // measurement the recognizer published beside its own threshold.
    var pressOk = w.shrink_frac >= w.press_enter;
    var leanOk  = Math.abs(w.toward_thumb) >= w.lean_deadband;

    if (w.descent_px_s > w.descent_limit) return say(s.hint_descending, 'warn');
    if (!w.cooled) return say('Wait a moment before the next one');
    if (!w.armed)  return say('Let your palm come back to rest first');
    if (pressOk && !leanOk) return say(s.hint_no_side, 'warn');
    if (!pressOk) return say(s.hint_working);
    say(s.hint_working);
  }

  // The dial. The rotation recognizer publishes its measured angle, the rest
  // baseline it adopted and the deviation, but NOT the enter/release
  // thresholds the wave publishes, so this bar has no gate mark to draw.
  // Normalised against ROTATE_DISPLAY_DEG purely for display; the pass state
  // comes from the recognizer's own `engaged`, never from that number.
  var ROTATE_DISPLAY_DEG = 30;
  function scaleRotate(s) {
    var r = fast && fast.diagnostics && fast.diagnostics.rotate;
    if (!r) { return say(diagMissing() || s.hint_idle); }
    if (justFired() && fired.label === 'dial') { return say(s.hint_pass, 'pass'); }
    if (r.stage === 'not_splayed' || r.stage === 'no_hand' || r.stage === 'reset') { return say(s.hint_idle); }
    if (r.stage === 'baseline_pending') { return say(s.hint_learning); }
    if (r.stage === 'flip_guard') { return say('Lost track of your knuckles for a moment'); }
    if (r.stage === 'edge_on') { return say('Rolled too far to read — come back toward the screen', 'warn'); }
    say(r.engaged ? s.hint_pass : s.hint_working, r.engaged ? 'pass' : '');
  }

  // Told once, precisely, rather than showing dead bars forever.
  var subscribeSent = false, firstFastAt = 0;
  var camFault = null;   // camera trouble, shown in the porthole only
  function diagMissing() {
    if (!fast) return null;
    if (fast.diagnostics) return null;
    if (!firstFastAt) firstFastAt = Date.now();
    if (Date.now() - firstFastAt < 2000) return null;
    return subscribeSent
      ? 'The server is not sending recognizer telemetry. diagnostics.enabled is off in tuning.json.'
      : 'Not subscribed to recognizer telemetry.';
  }

  // =======================================================================
  // The camera view
  // =======================================================================

  // TWO contexts. `ctx` is an OFFSCREEN buffer that the whole frame is
  // composed into; `vctx` is the canvas on screen, which only ever receives a
  // FINISHED composition.
  //
  // Why: this used to clear the visible canvas to black and then draw the
  // camera frame into it. Any single frame where the MJPEG <img> was not
  // decodable left the cleared black canvas on screen, which reads as a blink.
  // It fired reliably when the demonstration clip looped, because restarting
  // the VP9 decode competes with the MJPEG decode and one <img> frame arrives
  // incomplete.
  //
  // Composing offscreen means a failed or partial frame simply never reaches
  // the screen and the previous good frame stays up. Holding the last frame is
  // always better than showing black.
  var CLIP_W = 430, CLIP_H = 398;   // must match #clip in index.html
  var clipCtx = null;
  var ctx = null;    // offscreen — everything draws here
  var vctx = null;   // on screen — blitted to, once, at the end of a frame
  var buf = null;

  function initCanvas() {
    el.view.width = CAM_W * SUPERSAMPLE;
    el.view.height = CAM_H * SUPERSAMPLE;
    vctx = el.view.getContext('2d');
    buf = document.createElement('canvas');
    buf.width = el.view.width;
    buf.height = el.view.height;
    ctx = buf.getContext('2d');

    // The clip's own canvas. Must match #clip in index.html.
    el.clipCanvas.width = CLIP_W * SUPERSAMPLE;
    el.clipCanvas.height = CLIP_H * SUPERSAMPLE;
    clipCtx = el.clipCanvas.getContext('2d');
  }

  // Sample the hidden <video> into its canvas. Never clears first: the source
  // and the box are the same aspect to within 0.1%, so a drawn frame covers
  // the canvas completely, and a frame that is not ready simply leaves the
  // previous one up rather than flashing black.
  function drawClip() {
    var v = el.clipVideo;
    if (!clipCtx || v.readyState < 2 || !v.videoWidth) return;
    try {
      clipCtx.drawImage(v, 0, 0, v.videoWidth, v.videoHeight,
                        0, 0, el.clipCanvas.width, el.clipCanvas.height);
    } catch (e) { /* mid-decode: hold the last frame */ }
  }

  // The ONLY place the visible canvas is written.
  function present() {
    vctx.setTransform(1, 0, 0, 1, 0, 0);
    vctx.drawImage(buf, 0, 0);
  }

  function startFeed() {
    // THE SETUP FEED PRODUCES NOTHING UNTIL A CAMERA PROFILE IS BOUND, and it
    // fails SILENTLY: with no profile bound the server returns before it
    // encodes anything, so the <img> simply stays blank with no error
    // anywhere. Only GET /api/camera/detect binds it. The dashboard's own
    // camera view calls it first for exactly this reason.
    fetch('/api/camera/detect')
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) throw new Error(d.error || 'camera detection failed');
        if (!d.detection || d.detection.status !== 'detected')
          throw new Error('no camera was detected');
        openFeed();
      })
      .catch(function (e) {
        // NOT a page fault. The lesson, the coaching and the score scale all
        // run off the WebSocket and work perfectly well without a picture, so
        // a camera problem reports itself INSIDE the camera view and leaves
        // the rest of the page alone. Blanking the whole page for this was
        // wrong.
        camFault = 'The live view cannot start: ' + e.message + '.';
        console.error('[training] ' + camFault);
      });
  }

  // THE FEED, DOUBLE BUFFERED.
  //
  // This is what was making the page blink, and it had nothing to do with the
  // demonstration clip. The old watchdog reassigned the SAME <img>'s src
  // whenever no 'load' had fired for a second. Reassigning src blanks the
  // element instantly: naturalWidth drops to 0, the page flips to its no-feed
  // state and back, and the picture flashes. It only advanced its timestamp on
  // 'load', so if Chromium does not fire that once per MJPEG part it fired
  // every single second, forever.
  //
  // Two changes. A reconnect now loads into a SEPARATE Image and only becomes
  // the sampled one once it has actually decoded a frame, so the visible
  // source is never empty. And liveness no longer depends on 'load' at all:
  // camera_setup_state is emitted by the server on the same gate and the same
  // throttle as the JPEG, so its arrival is direct proof the feed is running.
  function newFeed() {
    var img = new Image();
    img.onload = function () {
      lastFrameTs = Date.now();
      if (pendingFeed === img) { feedImg = img; pendingFeed = null; }
    };
    img.onerror = function () { if (pendingFeed === img) pendingFeed = null; };
    img.src = '/api/camera/setup/mjpeg?t=' + Date.now();
    return img;
  }

  function openFeed() {
    // Opening this stream is what turns the setup encode path on server-side
    // (it is consumer-gated), and it is also what makes camera_setup_state
    // start arriving.
    feedImg = pendingFeed = newFeed();
    setInterval(function () {
      // Three seconds, and only when nothing is already on its way in. A
      // reconnect costs a stream teardown, so it is a last resort, not a tick.
      if (pendingFeed) return;
      if (Date.now() - lastFrameTs > 3000) pendingFeed = newFeed();
    }, 1000);
  }

  function frameDims() {
    if (feedImg && feedImg.naturalWidth > 0) return [feedImg.naturalWidth, feedImg.naturalHeight];
    if (setup && setup.frame_w) return [setup.frame_w, setup.frame_h];
    return null;
  }

  function render() {
    requestAnimationFrame(render);
    if (!ctx || !lessons) return;

    // THE READOUTS COME FIRST, and never depend on the camera. They are driven
    // by the WebSocket, not by the picture, so a stalled or undecodable frame
    // must not freeze them: below this point there are three early returns for
    // camera trouble, and all three used to take the score scale down too.
    // The cursor's own state, straight off pointer_fast. This replaced the
    // written instructions: showing whether the thing is ready is worth more
    // than telling someone how to make it ready.
    //
    // THE ARMED LIGHT. One widget, two meanings, each taken from whatever the
    // lesson's own recognizer actually reports:
    //
    //   click  the cursor is up and engaged, so a click can land
    //   wave   the wave recognizer is LIVE, meaning it has an open palm and
    //          has learned the resting hand, so a wave will be measured
    //
    // Both are the server's own state; neither is inferred here.
    setClass(el.arrows, 'on', lesson().scale.kind === 'wave');
    var sc = lesson().scale;
    var wantLight = sc.show_cursor_state !== false;
    el.cursorState.style.display = wantLight ? '' : 'none';
    if (wantLight) {
      var armed;
      if (sc.kind === 'wave') {
        var wv = fast && fast.diagnostics && fast.diagnostics.wave;
        armed = !!(wv && wv.stage === 'live');
      } else {
        var pt = fast && fast.pointer;
        armed = !!(pt && pt.visible && pt.engaged);
      }
      setClass(el.cursorState, 'live', armed);
      setText(el.cursorText, armed ? (sc.cursor_live || 'Ready')
                                   : (sc.cursor_idle || 'Present your hand'));
    }
    updateScale();
    drawClip();

    var dims = frameDims();
    var alive = (Date.now() - lastFrameTs) < 1500 && dims;
    setClass(el.camera, 'no-feed', !alive);
    if (!alive) {
      setText(el.noFeed, camFault ||
                         'Waiting for the camera. The live view comes from the ' +
                         'same feed as the dashboard’s Camera View.');
      return;
    }

    var fw = dims[0], fh = dims[1];
    var roi = setup && setup.roi;

    // The lock signal is the recognizer's own: roi.mode reaches "tracking"
    // when the palm width is known and the crop is palm-sized.
    tTarget = (roi && roi.mode === 'tracking') ? 1 : 0;
    t += (tTarget - t) * 0.08;
    if (t < 0.001) t = 0;
    if (t > 0.999) t = 1;

    // THE ROI IS DRAWN EXACTLY AS IT ARRIVES. No client-side easing.
    //
    // This page used to lerp the displayed ROI toward the real one at 0.15 per
    // frame. TouchFree ALREADY smooths it server-side, so that put a second
    // filter in series and roughly doubled the lag.
    // Worse than the lag, a 103 ms filter chasing a target that only moves at
    // 15 Hz never catches up, so the box trailed and rubber-banded instead of
    // tracking. The dashboard's own camera view does none of this and looks
    // markedly better for it.
    //
    // It is also the TouchFree rule:
    // "The server is the sole authority. The UI is a pure renderer. No
    // client-side smoothing, position computation, or gesture logic."
    // Smoothing the server's own output is exactly that, and the result was
    // measurably worse than obeying the rule.

    // THE ZOOM RULE. Never magnify past 1:1, so the picture is always native
    // camera pixels and can never go soft; zoom out only when the ROI is
    // bigger than the panel. Everything outside it is dimmed instead.
    // FILL THE MASK VERTICALLY. Containing the whole frame in the canvas made
    // the picture only as tall as the canvas is wide allows, which left black
    // inside the ring and made the view look far smaller than the camera it
    // came from. The circle only ever shows the middle of the frame's width
    // anyway, so the sides are meant to be clipped.
    var scaleFit = MASK_D / fh;
    var scaleZoom = scaleFit, cx = fw / 2, cy = fh / 2;
    if (roi && roi.w > 0) {
      // Fit the ROI to a FRACTION of the mask, not to the canvas and not to
      // the whole circle. The canvas is 980 wide but only the central 551
      // circle is visible, and filling even that read as zoomed far too far
      // in: the crop is five palm widths across, so a crop touching the ring
      // leaves no frame around the hand at all. camera.roi_fill decides how
      // much of the circle it may occupy. Still capped at 1.0, so the picture
      // is never magnified past native camera pixels.
      var fill = MASK_D * ((lessons.camera && lessons.camera.roi_fill) || 0.66);
      scaleZoom = Math.min(fill / roi.w, fill / roi.h, 1.0);
      cx = lerp(fw / 2, roi.x1 + roi.w / 2, t);
      cy = lerp(fh / 2, roi.y1 + roi.h / 2, t);
    }
    var s = lerp(scaleFit, scaleZoom, t);

    var dw = fw * s, dh = fh * s;
    var dx = CAM_W / 2 - cx * s, dy = CAM_H / 2 - cy * s;
    // Clamp so the frame edge is never pulled inside the panel.
    dx = (dw <= CAM_W) ? (CAM_W - dw) / 2 : clamp(dx, CAM_W - dw, 0);
    dy = (dh <= CAM_H) ? (CAM_H - dh) / 2 : clamp(dy, CAM_H - dh, 0);

    ctx.save();
    ctx.setTransform(SUPERSAMPLE, 0, 0, SUPERSAMPLE, 0, 0);
    ctx.clearRect(0, 0, CAM_W, CAM_H);
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, CAM_W, CAM_H);
    // A frame that is mid-decode throws here. Return WITHOUT presenting, so
    // the last good frame stays on screen instead of a black one.
    try { ctx.drawImage(feedImg, 0, 0, fw, fh, dx, dy, dw, dh); }
    catch (e) { ctx.restore(); return; }

    var P = function (x, y) { return [dx + x * s, dy + y * s]; };

    // The spotlight. Same treatment as CameraSetupOverlay's focus vignette:
    // clear inside, about half opacity outside. Drawn with one even-odd path
    // so there is a single fill and no second copy of the picture.
    if (t > 0.01 && roi) {
      var r0 = P(roi.x1, roi.y1);
      var rw = roi.w * s, rh = roi.h * s;
      ctx.beginPath();
      ctx.rect(0, 0, CAM_W, CAM_H);
      roundRect(ctx, r0[0], r0[1], rw, rh, 14);
      ctx.fillStyle = 'rgba(0, 0, 0, ' + (0.66 * t).toFixed(3) + ')';
      ctx.fill('evenodd');
      ctx.strokeStyle = 'rgba(124, 192, 255, ' + (0.5 * t).toFixed(3) + ')';
      ctx.lineWidth = 2;
      ctx.beginPath(); roundRect(ctx, r0[0], r0[1], rw, rh, 14); ctx.stroke();
    }

    // Body fades out as the hand fades in, on the same easing value, so the
    // two never fight and both stay registered through the move.
    if (setup) {
      // camera_setup_state is in the FRAME's pixel space; if the MJPEG is
      // being decoded at another size, carry the landmarks with it.
      var k = setup.frame_w ? (fw / setup.frame_w) : 1;
      var Q = function (x, y) { return P(x * k, y * k); };
      if (t < 0.995) drawBody(setup.body_keypoints_px, Q, (1 - t) * 0.95, s);
      if (t > 0.005) drawHand(setup.hand_landmarks_px, Q, t, s);
    }
    ctx.restore();
    present();
  }

  function roundRect(c, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    c.moveTo(x + r, y);
    c.arcTo(x + w, y, x + w, y + h, r);
    c.arcTo(x + w, y + h, x, y + h, r);
    c.arcTo(x, y + h, x, y, r);
    c.arcTo(x, y, x + w, y, r);
    c.closePath();
  }

  function drawBody(kp, Q, alpha, s) {
    if (!kp || !kp.length || alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = 'rgba(124, 192, 255, 0.85)';
    ctx.lineWidth = Math.max(1.5, 3 * s);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (var i = 0; i < BODY_EDGES.length; i++) {
      var a = kp[BODY_EDGES[i][0]], b = kp[BODY_EDGES[i][1]];
      if (!a || !b) continue;          // null = the camera could not see it
      var pa = Q(a[0], a[1]), pb = Q(b[0], b[1]);
      ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]);
    }
    ctx.stroke();
    ctx.fillStyle = 'rgba(238, 244, 250, 0.90)';
    for (var j = 0; j < BODY_POINTS.length; j++) {
      var p = kp[BODY_POINTS[j]];
      if (!p) continue;
      var q = Q(p[0], p[1]);
      ctx.beginPath(); ctx.arc(q[0], q[1], Math.max(2, 4 * s), 0, 6.2832); ctx.fill();
    }
    ctx.restore();
  }

  function drawHand(lm, Q, alpha, s) {
    if (!lm || !lm.length || alpha <= 0) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = 'rgba(124, 192, 255, 0.95)';
    ctx.lineWidth = Math.max(1.5, 3.5 * s);
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (var i = 0; i < HAND_EDGES.length; i++) {
      var a = lm[HAND_EDGES[i][0]], b = lm[HAND_EDGES[i][1]];
      if (!a || !b) continue;
      var pa = Q(a[0], a[1]), pb = Q(b[0], b[1]);
      ctx.moveTo(pa[0], pa[1]); ctx.lineTo(pb[0], pb[1]);
    }
    ctx.stroke();
    for (var j = 0; j < lm.length; j++) {
      if (!lm[j]) continue;
      var q = Q(lm[j][0], lm[j][1]);
      ctx.fillStyle = HAND_TIPS[j] ? 'rgba(124, 192, 255, 1)' : 'rgba(238, 244, 250, 0.92)';
      ctx.beginPath(); ctx.arc(q[0], q[1], Math.max(2, (HAND_TIPS[j] ? 5 : 3.5) * s), 0, 6.2832); ctx.fill();
    }
    ctx.restore();
  }

  // =======================================================================
  // Wire
  // =======================================================================

  function applyControls(cfg) {
    if (!cfg) return;
    ['gesture_cursor_enabled', 'gesture_click_enabled',
     'gesture_wave_enabled', 'gesture_rotate_enabled'].forEach(function (k) {
      if (k in cfg) controls[k] = !!cfg[k];
    });
  }

  function connect() {
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    var ws = new WebSocket(proto + '//' + location.host + '/ws');

    ws.onopen = function () {
      // THE ONLY MESSAGE THIS PAGE SENDS. Without it the server does not build
      // pointer_fast.payload.diagnostics for anyone, and every gate reading on
      // this page would be blank forever. See README.md, "Subscribing to
      // the recognizer telemetry".
      ws.send(JSON.stringify({ type: 'subscribe', diagnostics: true }));
      subscribeSent = true;
    };

    ws.onmessage = function (ev) {
      var m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      // Store and return. Drawing happens in the rAF loop, never here.
      switch (m.type) {
        case 'pointer_fast':       fast = m.payload; break;
        case 'semantic_slow':      slow = m.payload; break;
        case 'camera_setup_state':
          setup = m.payload;
          // Emitted on the same consumer gate and throttle as the JPEG,
          // so this IS the feed running. Liveness never depends on the
          // <img> 'load' event firing per MJPEG part.
          lastFrameTs = Date.now();
          break;
        case 'controls_changed':   applyControls(m.payload); break;
        case 'click_event':
          fired = { at: Date.now(), label: 'click' };
          break;
        case 'gesture_command':
          var a = m.payload && m.payload.action ? String(m.payload.action) : '';
          fired = { at: Date.now(),
                    label: a.indexOf('dial') === 0 ? 'dial' : 'wave',
                    action: a };
          if (fired.label === 'wave') markWave(a);
          break;
      }
    };

    ws.onclose = function () { setTimeout(connect, 2000); };
  }

  // ---- boot -------------------------------------------------------------
  fetch('./lessons.json')
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (cfg) {
      if (!cfg.lessons || !cfg.lessons.length) throw new Error('no lessons defined');
      lessons = cfg;
      initCanvas();
      checkPositions(cfg.game || {});
      spawn();
      show(0);
      startFeed();
      requestAnimationFrame(render);
    })
    .catch(function (e) {
      // The page refuses to run rather than inventing defaults. A silent
      // built-in default is how a page and its published settings drift apart.
      fault('lessons.json could not be read (' + e.message + '). It sits beside ' +
            'index.html and holds every lesson, every line of coaching and every ' +
            'clip filename.');
    });

  // Controls: the status read covers a page loaded mid-session, the
  // controls_changed subscription covers an operator flipping a toggle after.
  fetch('/api/kiosk/status')
    .then(function (r) { return r.json(); })
    .then(function (d) { applyControls(d.config); })
    .catch(function (e) { console.error('[training] status read failed:', e); });

  connect();

})();
