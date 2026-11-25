import {drag, discardTerminals} from './contacts.mjs';
import {registerOrderedRelease} from './ordered-release.mjs';
import {registerCombinedGuard, registerReturnGuard} from './return-guard.mjs';

export async function repairs(t) {
  await t.run({id:'idle-after-lost-release', phase:'repair', input:'mixed', oracle:'fault',
    expectation:'拖拽时吞掉两个指针终止通知。实际松手后，不再触碰页面，角色应自行退出拖拽。'}, async h=>{
    const owner=await drag(h);
    const terminals=['pointerup','lostpointercapture'];
    await discardTerminals(h,owner,terminals);
    await h.touch('touchEnd');
    // Observe without sending a new down, blur or reset. A missing exit is the fault.
    try {
      await h.page.waitForFunction(()=>document.querySelector('#window-surface').dataset.gesture==='idle',
        null,{timeout:500});
    } catch (error) {
      if (error.name!=='TimeoutError') throw error;
    }
    const end=await h.snapshot();
    const intercepted=await h.page.evaluate(()=>window.__discardedTerminals);
    h.require(terminals.every(type=>intercepted.some(e=>e.type===type && e.trusted)),
      'Both browser-generated terminal notifications must actually be intercepted.');
    const up=end.events.findLast(e=>e.type==='pointerup' && e.trusted && e.id===owner);
    const idle=end.modes.find(e=>e.mode==='idle' && e.t>=up?.t);
    h.check('No second interaction needed to exit drag',end.mode==='idle',
      {owner,endMode:end.mode,observedIdleAfterUpMs:idle && up ? idle.t-up.t : null,intercepted});
  });

  await t.run({id:'stationary-drag-keeps-owner', phase:'repair', input:'native-touch',
    expectation:'已拖动后静止两秒，原手指仍能直接反向，期间没有虚假释放。'}, async h=>{
    await drag(h);
    const start=await h.snapshot();
    const lastDrag=start.modes.findLast(m=>m.mode==='drag');
    await h.page.waitForTimeout(2000);
    const still=await h.snapshot();
    h.check('Silent active touch retains drag',
      still.mode==='drag' && !still.modes.some(m=>m.t>lastDrag.t && m.mode!=='drag'),
      {before:start.mode,after:still.mode});
    await h.touch('touchMove',[h.point(.15,.57)]);
    await h.page.waitForTimeout(110);
    const reversed=await h.snapshot();
    h.check('Same finger can reverse after the pause',reversed.mode==='drag' && reversed.frame?.targetX<-.5,
      {mode:reversed.mode,target:reversed.frame?.targetX});
    await h.touch('touchEnd');
    await h.waitMode('idle');
  });
  await registerReturnGuard(t);
  await registerCombinedGuard(t);
  await registerOrderedRelease(t);
}
