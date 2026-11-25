// These cases exercise ownership and terminal events independently of the artwork.
// CDP finger IDs index the input driver. The DOM assigns its own pointer IDs.
const finger = (h, u, id = 1) => h.point(u, .57, id);

async function sampled(h) {
  await h.page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  return h.snapshot();
}

async function drag(h) {
  await h.touch('touchStart', [finger(h, .24)]);
  await h.waitMode('hold');
  await h.touch('touchMove', [finger(h, .78)]);
  await h.waitMode('drag');
  const {events, frame} = await sampled(h);
  const down = events.findLast(e => e.type === 'pointerdown' && e.primary && e.trusted);
  h.require(down && frame?.targetX > .4, 'A trusted primary contact must first drag right.');
  return down.id;
}

function outcome(h, snap, mode, label) {
  h.check(label, snap.mode === mode, {mode: snap.mode, targetX: snap.frame?.targetX});
}

async function ownerMovedLeft(h, label) {
  await h.touch('touchMove', [finger(h, .18)]);
  const snap = await sampled(h);
  h.check(label, snap.mode === 'drag' && snap.frame?.targetX < -.4,
    {mode: snap.mode, target: snap.frame?.targetX});
}

async function discardTerminals(h, id, types) {
  await h.page.evaluate(({id, types}) => {
    window.__discardedTerminals = [];
    for (const type of types) {
      const intercept = event => {
        if (event.pointerId !== id) return;
        window.removeEventListener(type, intercept, true);
        window.__discardedTerminals.push({type:event.type, trusted:event.isTrusted});
        event.stopImmediatePropagation();
      };
      window.addEventListener(type, intercept, true);
    }
  }, {id, types});
}

async function releaseWithLoss(h, both) {
  const id = await drag(h);
  const types = both ? ['pointerup', 'lostpointercapture'] : ['pointerup'];
  await discardTerminals(h, id, types);
  await h.touch('touchEnd', []);
  const released = await sampled(h);
  const suppressed = await h.page.evaluate(() => window.__discardedTerminals);
  h.note('fault', suppressed);
  h.require(types.every(type => suppressed.some(e => e.type === type && e.trusted)),
    'The browser must deliver every nominated terminal to the fault injector.');
  if (!both) {
    h.require(released.events.some(e => e.type === 'lostpointercapture' && e.id === id && e.trusted),
      'The independent capture-loss signal must reach the observer.');
    outcome(h, released, 'idle', 'Capture loss releases the actor when pointerup is lost.');
    return;
  }

  // A silent finger can legitimately remain held forever. Only score after proof
  // that all physical contacts actually ended and a fresh primary pointer arrived.
  const before = released.events.length;
  await h.touch('touchStart', [finger(h, .20, 7)]);
  const next = await sampled(h);
  const fresh = next.events.slice(before).find(e => e.type === 'pointerdown' && e.trusted && e.primary && e.id !== id);
  h.require(fresh, 'The next independent trusted primary down must actually reach the document.');
  h.check('A fresh contact can take ownership after the previous release signals were suppressed.',
    ['press','hold'].includes(next.mode) && next.frame?.targetX < -.4,
    {previousPointer:id, nextPointer:fresh.id, mode:next.mode, target:next.frame?.targetX});
  await h.touch('touchEnd', []);
}

export async function contacts(t) {
  const run = (id, expectation, body, options = {}) =>
    t.run({id, phase:'ownership', input:'native-touch', expectation, ...options}, body);

  await run('outside-return', 'The owner can exit through each edge and return without losing the drag.', async h => {
    await drag(h);
    for (const [u,v] of [[-.025,.57],[1.025,.57],[.50,-.04],[.50,1.04]]) {
      const point = h.point(u,v,1);
      const vp = h.page.viewportSize();
      h.require(point.x >= 0 && point.x < vp.width && point.y >= 0 && point.y < vp.height,
        'The test needs reachable screen pixels outside this edge.');
      await h.touch('touchMove', [point]);
      const outside = await sampled(h);
      const coordinate = u < 0 || u > 1 ? outside.frame?.targetX : outside.frame?.targetY;
      const side = u < 0 || v < 0 ? -1 : 1;
      h.check('Still tracks outside edge '+[u,v].join(','), outside.mode === 'drag' && side * coordinate > .8,
        {mode:outside.mode,coordinate});
      await ownerMovedLeft(h,'Tracks again on re-entry from '+[u,v].join(','));
    }
    await h.touch('touchEnd', []);
    outcome(h, await sampled(h), 'idle','Release after re-entry ends ownership.');
  });

  await run('outside-release', 'Releasing beyond the visual surface ends the gesture.', async h => {
    const id = await drag(h);
    await h.touch('touchMove',[h.point(1.025,.70,1)]);
    await h.touch('touchEnd',[]);
    const snap = await sampled(h);
    h.require(snap.events.some(e => e.type === 'pointerup' && e.id === id && e.trusted),
      'The owner must actually lift.');
    outcome(h,snap,'idle','An outside release resets the drag.');
  });

  await run('outside-start', 'An outside contact entering the window cannot synthesize a new press.', async h => {
    await h.touch('touchStart',[h.point(.50,-.12,1)]);
    await h.touch('touchMove',[finger(h,.65)]);
    outcome(h,await sampled(h),'idle','No ghost gesture begins when an outside touch enters.');
    await h.touch('touchEnd',[]);
  });

  await run('outside-resting-contact', 'Product policy candidate: a resting finger outside the window does not block the first in-window touch.', async h => {
    const outside = h.point(.50,-.12,1);
    const inside = finger(h,.77,2);
    await h.touch('touchStart',[outside]);
    outcome(h,await sampled(h),'idle','The exterior finger alone does not own the actor.');
    await h.touch('touchStart',[outside,inside]);
    await h.page.waitForTimeout(450);
    const during = await sampled(h);
    h.require(during.events.some(e => e.type === 'pointerdown' && e.trusted && e.primary) &&
      during.events.some(e => e.type === 'pointerdown' && e.trusted && !e.primary),
      'Both the exterior and the new interior touch must reach the browser.');
    h.check('A stationary exterior touch leaves the in-window touch available.',
      during.mode === 'hold' && during.frame?.targetX > .4, {mode:during.mode,target:during.frame?.targetX});
    await h.touch('touchEnd',[]);
  }, {oracle:'policy'});

  await run('orphan-move-up', 'Losing the initial down cannot create a ghost owner when later moves and release arrive.', async h => {
    await h.page.evaluate(() => {
      window.__droppedDown = null;
      window.addEventListener('pointerdown', event => {
        window.__droppedDown = event.isTrusted ? event.pointerId : null;
        event.stopImmediatePropagation();
      }, {capture:true, once:true});
    });
    await h.touch('touchStart',[finger(h,.20)]);
    await h.touch('touchMove',[finger(h,.78)]);
    outcome(h,await sampled(h),'idle','A move without an accepted down cannot start a drag or swipe.');
    await h.touch('touchEnd',[]);
    const after = await sampled(h);
    const id = await h.page.evaluate(() => window.__droppedDown);
    h.require(id != null && after.events.some(e => e.type === 'pointerup' && e.id === id && e.trusted),
      'The initial down must be intercepted, with a matching trusted release still delivered.');
    outcome(h,after,'idle','An orphan release cannot start a tap.');
  }, {input:'mixed',oracle:'fault'});

  await run('secondary-first-up', 'A second finger can move and lift without canceling or steering the owner.', async h => {
    const id = await drag(h);
    await h.touch('touchStart',[finger(h,.78),finger(h,.25,2)]);
    await h.touch('touchMove',[finger(h,.14,2)]);
    const second = await sampled(h);
    const auxiliary = second.events.find(e => e.type === 'pointerdown' && e.trusted && !e.primary);
    h.require(auxiliary && auxiliary.id !== id,'A distinct non-primary pointer must be present.');
    h.check('An auxiliary movement does not steer the actor.',
      second.mode === 'drag' && second.frame?.targetX > .4,{mode:second.mode,target:second.frame?.targetX});
    // Chromium dispatches a selective end for the contact IDs supplied here.
    await h.touch('touchEnd',[finger(h,.14,2)]);
    const afterUp = await sampled(h);
    h.require(afterUp.events.some(e => e.type === 'pointerup' && e.id === auxiliary.id && e.trusted),
      'Verify that the auxiliary finger, not the owner, really lifted.');
    await ownerMovedLeft(h,'Owner continues after the auxiliary finger lifts.');
    await h.touch('touchEnd',[]);
  });

  await run('owner-first-up', 'When the owner lifts, remaining contacts cannot keep a phantom drag alive.', async h => {
    const id = await drag(h);
    await h.touch('touchStart',[finger(h,.78),finger(h,.25,2)]);
    await h.touch('touchEnd',[finger(h,.78)]);
    const after = await sampled(h);
    h.require(after.events.some(e => e.type === 'pointerup' && e.id === id && e.trusted),
      'The original owner must be the first lifted finger.');
    outcome(h,after,'idle','Owner release ends the active drag.');
    await h.touch('touchMove',[finger(h,.65,2)]);
    outcome(h,await sampled(h),'idle','The remaining finger cannot resurrect the finished drag.');
    await h.touch('touchEnd',[]);
  });

  await run('multi-system-cancel', 'Canceling a two-finger sequence clears the owner and both physical contacts.', async h => {
    const id = await drag(h);
    await h.touch('touchStart',[finger(h,.78),finger(h,.25,2)]);
    await h.touch('touchCancel',[]);
    const snap = await sampled(h);
    h.require(snap.events.some(e => e.type === 'pointercancel' && e.id === id && e.trusted),
      'The browser must dispatch cancellation of the owner.');
    outcome(h,snap,'idle','A canceled two-finger sequence cannot keep the actor active.');
  });

  await run('nonowner-cancel', 'An auxiliary cancellation cannot stop the active primary contact.', async h => {
    const id = await drag(h);
    await h.touch('touchStart',[finger(h,.78),finger(h,.25,2)]);
    const snap = await sampled(h);
    const aux = snap.events.find(e => e.type === 'pointerdown' && e.trusted && e.id !== id && !e.primary);
    h.require(aux,'An actual secondary finger is required for this selective-cancel injection.');
    await h.page.evaluate(id => document.querySelector('#window-surface').dispatchEvent(
      new PointerEvent('pointercancel',{bubbles:true,pointerType:'touch',pointerId:id,isPrimary:false})),aux.id);
    await ownerMovedLeft(h,'The owner is still steering after another contact receives cancel.');
    await h.touch('touchEnd',[]);
  }, {input:'mixed'});

  await run('lost-capture', 'An explicit loss of capture ends the old drag, and later moves cannot resurrect it.', async h => {
    const id = await drag(h);
    const hadCapture = await h.page.evaluate(id => {
      const surface = document.querySelector('#window-surface');
      if (!surface.hasPointerCapture(id)) return false;
      surface.releasePointerCapture(id);
      return true;
    },id);
    h.require(hadCapture,'A browser-owned pointer capture is required.');
    await h.touch('touchMove',[finger(h,.2)]);
    const snap = await sampled(h);
    h.require(snap.events.some(e => e.id === id && e.type === 'lostpointercapture' && e.trusted),
      'The browser must dispatch a real capture-loss event.');
    outcome(h,snap,'idle','Capture loss clears the drag even while the finger remains down.');
    await h.touch('touchEnd',[]);
  }, {input:'mixed'});

  await run('stale-terminal', 'Delayed terminals from the previous pointer cannot release a newly active owner.', async h => {
    const oldId = await drag(h);
    await h.touch('touchEnd',[]);
    const newId = await drag(h);
    h.require(oldId !== newId,'Need distinct old and new DOM pointer IDs.');
    await h.page.evaluate(id => {
      const surface = document.querySelector('#window-surface');
      for (const type of ['pointerup','pointercancel','lostpointercapture']) {
        surface.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerType:'touch',pointerId:id,isPrimary:true}));
      }
    },oldId);
    await ownerMovedLeft(h,'A new owner survives three stale terminals.');
    await h.touch('touchEnd',[]);
  }, {input:'mixed'});

  await run('mixed-mouse-touch', 'A mouse press and release cannot take control from an active finger.', async h => {
    const id = await drag(h);
    const pt = finger(h,.25,2);
    await h.page.mouse.move(pt.x,pt.y);
    await h.page.mouse.down();
    await h.page.mouse.up();
    const snap = await sampled(h);
    h.require(snap.events.some(e => e.type === 'pointerdown' && e.primary && e.trusted && e.id !== id),
      'The browser must deliver a separate primary mouse pointer.');
    await ownerMovedLeft(h,'Touch drag remains responsive after a mouse down/up.');
    await h.touch('touchEnd',[]);
  }, {input:'mixed'});

  await run('missing-up', 'Capture loss suffices when delivery of pointerup is interrupted.', h => releaseWithLoss(h,false),
    {input:'mixed',oracle:'fault'});
  await run('missing-up-and-capture-loss', 'After both terminals are lost, a new primary down must be able to restart.',
    h => releaseWithLoss(h,true), {input:'mixed',oracle:'fault'});
}
