const HOLD_MS = 350;
const MOVE_SLOP = 10; // CSS pixels, independent of canvas resolution.
const TAP_MS = 480;
const SWIPE_RELEASE_MS = 360;

const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
const follow = (value, target, dt, tau) => value + (target - value) * -Math.expm1(-dt / tau);

function locate(surface, event) {
  const rect = surface.getBoundingClientRect();
  const u = (event.clientX - rect.left) / Math.max(1, rect.width);
  const v = (event.clientY - rect.top) / Math.max(1, rect.height);
  return {
    x: clamp((u - 0.5) / 0.44, -1, 1),
    y: clamp((v - 0.55) / 0.45, -1, 1),
    u, v,
  };
}

function hitZone(point, headX, headY) {
  if (point.v >= 0.86) return "sill";
  // The cheek region follows the head. Empty black corners still attract her gaze.
  const dx = (point.u - 0.50 - headX * 0.025) / 0.43;
  const dy = (point.v - 0.60 - headY * 0.015) / 0.34;
  return dx * dx + dy * dy <= 1 ? "face" : "window";
}

function blinkAmount(elapsed) {
  if (elapsed < 0 || elapsed > 152) return 0;
  return elapsed < 63
    ? 0.5 - 0.5 * Math.cos(Math.PI * elapsed / 63)
    : 0.5 + 0.5 * Math.cos(Math.PI * (elapsed - 63) / 89);
}

/** One contact drives the actor. sample() uses the same clock as requestAnimationFrame. */
export function connectInteraction(surface, onStatus = () => {}, {returnRecovery = true, releaseRecovery = true} = {}) {
  let mode = "idle";
  let zone = "window";
  let direction = null;
  let contact = null;
  let restoredTouches = null;
  let holdTimer = 0;
  let modeSince = performance.now();
  let releaseTime = Infinity;
  let lastFrame = modeSince;
  let nextBlink = lastFrame + 2800;
  let blinkStart = -Infinity;
  let targetX = 0;
  let targetY = 0;
  let eyeX = 0;
  let eyeY = 0;
  let headX = 0;
  let headY = 0;
  let smile = 0;
  let press = 0;
  let leanIn = 0;
  let closed = false;

  function announce() {
    surface.dataset.gesture = mode;
    onStatus(mode, {zone, direction});
  }

  function transition(next, now) {
    mode = next;
    modeSince = now;
    announce();
  }

  function stopTimer() {
    clearTimeout(holdTimer);
    holdTimer = 0;
  }

  function startHold(now) {
    if (!contact || mode !== "press" || now - contact.started < HOLD_MS) return;
    stopTimer();
    transition("hold", now);
  }

  function rest(now) {
    targetX = targetY = 0;
    direction = null;
    zone = "window";
    releaseTime = Infinity;
    if (mode !== "idle") transition("idle", now);
  }

  function dropContact() {
    const id = contact?.id;
    contact = null;
    stopTimer();
    if (id !== undefined && surface.hasPointerCapture?.(id)) surface.releasePointerCapture(id);
  }

  function rememberRestoredTouch(event) {
    if (!restoredTouches || event.pointerType !== "touch") return;
    if (event.isPrimary) restoredTouches = null;
    else restoredTouches.pointers.add(event.pointerId);
  }

  function forgetRestoredTouch(event) {
    if (event.pointerType === "touch") restoredTouches?.pointers.delete(event.pointerId);
  }

  function trackRestoredTouchList(event) {
    if (!restoredTouches || !event.isTrusted) return;
    const {pointers, nativeIds} = restoredTouches;
    if (event.type === "touchstart") {
      for (const touch of event.changedTouches) nativeIds.add(touch.identifier);
    } else if (nativeIds.size) {
      // A pre-navigation touch can remain in touches. Compare only IDs that
      // started since return; Touch identifiers and Pointer IDs are unrelated.
      const active = new Set(Array.from(event.touches, touch => touch.identifier));
      for (const id of nativeIds) if (!active.has(id)) nativeIds.delete(id);
      if (!nativeIds.size) {
        pointers.clear();
        if (releaseRecovery && contact?.type === "touch" && contact.trusted) contact.touchListEnded = true;
      }
    }
  }

  function isControllingPointer(event) {
    if (event.isPrimary !== false) return true;
    // A cached document can see only non-primary touches until the browser's
    // previous sequence clears. Count fingers across the whole returned page.
    return event.pointerType === "touch" && restoredTouches?.pointers.size === 1 &&
      restoredTouches.pointers.has(event.pointerId);
  }

  function down(event) {
    if (!isControllingPointer(event) || event.button !== 0) return;
    if (contact) {
      // An independent primary touch starts a new sequence. A different finger
      // cannot replace an owner for which the browser still confirms capture.
      if (!releaseRecovery || contact.type !== "touch" || event.pointerType !== "touch" ||
          (contact.trusted && !event.isTrusted)) return;
      const stillCaptured = contact.captured && surface.hasPointerCapture(contact.id);
      const previousEnded = contact.touchListEnded || (contact.captured && !stillCaptured);
      const newPrimary = event.isPrimary && (!stillCaptured || contact.id === event.pointerId);
      if (!previousEnded && !newPrimary) return;
      dropContact();
    }
    const now = performance.now();
    const point = locate(surface, event);
    contact = {id: event.pointerId, type: event.pointerType, trusted: event.isTrusted, captured: false,
      x: event.clientX, y: event.clientY, started: now};
    targetX = point.x;
    targetY = point.y;
    zone = hitZone(point, headX, headY);
    direction = null;
    releaseTime = Infinity;
    transition("press", now);
    holdTimer = setTimeout(() => startHold(performance.now()), HOLD_MS);
    // Window-level listeners continue to handle synthetic input without native capture.
    try { surface.setPointerCapture(event.pointerId); } catch { /* no active native pointer */ }
    if (releaseRecovery && event.pointerType === "touch" && event.isTrusted) {
      contact.captured = surface.hasPointerCapture?.(event.pointerId) === true;
    }
    if (event.cancelable) event.preventDefault();
  }

  function updateContact(event, now) {
    if (!contact || event.pointerId !== contact.id) return;
    const dx = event.clientX - contact.x;
    const dy = event.clientY - contact.y;
    const moved = Math.hypot(dx, dy) > MOVE_SLOP;
    startHold(now);
    if (mode === "press" && moved) {
      stopTimer();
      // A swipe requests one glance in its travel direction, from any starting point.
      const length = Math.hypot(dx, dy);
      targetX = dx / length;
      targetY = dy / length;
      direction = Math.abs(dx) >= Math.abs(dy) ? (dx < 0 ? "left" : "right") : (dy < 0 ? "up" : "down");
      transition("swipe", now);
    } else if (mode === "drag" || (mode === "hold" && moved)) {
      const point = locate(surface, event);
      targetX = point.x;
      targetY = point.y;
      if (mode === "hold") transition("drag", now);
    }
  }

  function move(event) {
    updateContact(event, performance.now());
  }

  function up(event) {
    if (!contact || event.pointerId !== contact.id) return;
    const now = performance.now();
    // A fast gesture may deliver its final displacement only on pointerup.
    updateContact(event, now);
    dropContact();
    if (mode === "press") {
      releaseTime = now + TAP_MS;
      transition("tap", now);
    } else if (mode === "swipe") {
      releaseTime = now + SWIPE_RELEASE_MS;
    } else {
      rest(now);
    }
  }

  function cancel(event) {
    if (event?.pointerId !== undefined && event.pointerId !== contact?.id) return;
    dropContact();
    rest(performance.now());
  }

  function visibility() {
    if (document.hidden) cancel();
  }

  function observeTouchList(event) {
    if (!event.isTrusted || contact?.type !== "touch" || !contact.trusted) return;
    if (event.type === "touchstart" && contact.nativeTouchId === undefined) {
      // Touch.identifier and pointerId have separate namespaces. Match the
      // initial hit on this surface before using a native lift's coordinates.
      const starts = Array.from(event.changedTouches).filter(touch => surface.contains(touch.target) &&
        Math.abs(touch.clientX - contact.x) < 1 && Math.abs(touch.clientY - contact.y) < 1);
      if (starts.length === 1) contact.nativeTouchId = starts[0].identifier;
    } else if (event.type !== "touchstart") {
      const lift = Array.from(event.changedTouches).find(touch => touch.identifier === contact.nativeTouchId);
      if (!lift && event.touches.length) return;
      contact.touchListEnded = true;
      if (event.type === "touchend" && lift) {
        contact.liftPoint = {pointerId:contact.id, clientX:lift.clientX, clientY:lift.clientY};
      }
    }
  }

  function preventMenu(event) {
    event.preventDefault();
  }

  function sample(now = performance.now()) {
    const dt = clamp(now - lastFrame, 0, 80);
    lastFrame = now;
    // Implicit capture ends on a real lift even when its two DOM notifications
    // are lost. Only check captures we actually observed on this contact.
    if (contact && (contact.touchListEnded || (contact.captured && !surface.hasPointerCapture(contact.id)))) {
      if (contact.liftPoint) up(contact.liftPoint);
      else cancel();
    }
    startHold(now);
    if (now >= releaseTime) rest(now);
    if (now >= nextBlink) {
      blinkStart = now;
      nextBlink = now + 3000 + Math.random() * 2300;
    }

    const age = Math.max(0, now - modeSince);
    const tap = mode === "tap" ? Math.sin(Math.PI * clamp(age / TAP_MS, 0, 1)) : 0;
    const held = mode === "hold" || mode === "drag";
    const atSill = zone === "sill";
    const handTap = atSill ? tap : 0;
    const smileTarget = held ? 0.68 : zone === "face" ? tap : 0;
    smile = follow(smile, smileTarget, dt, 80);
    press = follow(press, contact ? 1 : 0, dt, contact ? 28 : 120);
    leanIn = follow(leanIn, held ? 1 : 0, dt, held ? 165 : 190);

    // Independent clocks let an ongoing head turn or blink coexist with a new gaze target.
    eyeX = follow(eyeX, targetX, dt, 30);
    eyeY = follow(eyeY, targetY, dt, 38);
    headX = follow(headX, targetX, dt, 138);
    headY = follow(headY, targetY, dt, 168);
    return {
      eyeX, eyeY, headX, headY, blink: blinkAmount(now - blinkStart), smile, press, leanIn, tap,
      handL: targetX <= 0 ? handTap : 0, handR: targetX > 0 ? handTap : 0,
      mode, zone, direction, targetX, targetY,
    };
  }

  const controller = new AbortController();
  const options = {signal: controller.signal};
  if (releaseRecovery) {
    const touchOptions = {...options, capture:true, passive:true};
    for (const type of ["touchstart", "touchend", "touchcancel"]) window.addEventListener(type, observeTouchList, touchOptions);
  }
  if (returnRecovery) {
    const capture = {...options, capture:true};
    window.addEventListener("pointerdown", rememberRestoredTouch, capture);
    window.addEventListener("pointerup", forgetRestoredTouch, capture);
    window.addEventListener("pointercancel", forgetRestoredTouch, capture);
    const passiveCapture = {...capture, passive:true};
    window.addEventListener("touchstart", trackRestoredTouchList, passiveCapture);
    window.addEventListener("touchend", trackRestoredTouchList, passiveCapture);
    window.addEventListener("touchcancel", trackRestoredTouchList, passiveCapture);
    window.addEventListener("pagehide", () => {
      restoredTouches = null;
      cancel();
    }, options);
    window.addEventListener("pageshow", event => {
      if (!event.persisted) return;
      cancel();
      restoredTouches = {pointers:new Set(), nativeIds:new Set()};
    }, options);
  }
  surface.addEventListener("pointerdown", down, options);
  window.addEventListener("pointermove", move, options);
  window.addEventListener("pointerup", up, options);
  window.addEventListener("pointercancel", cancel, options);
  surface.addEventListener("lostpointercapture", cancel, options);
  surface.addEventListener("contextmenu", preventMenu, options);
  window.addEventListener("blur", cancel, options);
  document.addEventListener("visibilitychange", visibility, options);
  announce();
  return {
    sample,
    destroy() {
      if (closed) return;
      closed = true;
      controller.abort();
      cancel();
    },
  };
}
