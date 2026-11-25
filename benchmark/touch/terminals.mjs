// Exercise every active mode at each terminal, regardless of what the character draws.
const activeModes=['press','hold','drag','swipe'];
const terminals=['release','cancel','capture-loss','blur'];

export async function terminalsMatrix(t) {
  for (const state of activeModes) {
    for (const terminal of terminals) {
      await t.run({
        id:state+'-'+terminal+'-matrix', phase:'terminal', oracle:'contract',
        input:['release','cancel'].includes(terminal)?'native-touch':'mixed',
        expectation:state+' 收到 '+terminal+' 后退场；旧长按/收尾计时器不得重新夺取下一次触摸。',
      }, async h=>{
        const start=h.point(.28,.43), tiny=h.point(.284,.43), far=h.point(.78,.72);
        await h.touch('touchStart',[start]);
        // Complete implicit capture while staying below swipe slop.
        await h.touch('touchMove',[tiny]);
        if (state==='hold' || state==='drag') await h.waitMode('hold');
        if (state==='drag' || state==='swipe') await h.touch('touchMove',[far]);
        await h.waitMode(state);
        const before=await h.snapshot();
        const down=before.events.findLast(e=>e.type==='pointerdown' && e.trusted);
        h.require(down && before.mode===state,'The requested live mode must be reached before termination.');
        if (terminal==='release') {
          await h.touch('touchEnd');
        } else if (terminal==='cancel') {
          await h.touch('touchCancel');
        } else if (terminal==='blur') {
          await h.page.evaluate(()=>window.dispatchEvent(new Event('blur')));
        } else {
          const had=await h.page.locator('#window-surface').evaluate((surface,id)=>{
            if (!surface.hasPointerCapture(id)) return false;
            surface.releasePointerCapture(id);
            return true;
          },down.id);
          h.require(had,'The owner did not actually have capture.');
          const p=state==='drag'||state==='swipe'?h.point(.72,.68):h.point(.295,.43);
          await h.touch('touchMove',[p]);
        }
        const expected=terminal==='release' && state==='press'?'tap':terminal==='release' && state==='swipe'?'swipe':'idle';
        const eventName={release:'pointerup',cancel:'pointercancel','capture-loss':'lostpointercapture',blur:'blur'}[terminal];
        // TouchMove may be coalesced for the next compositor frame after the driver replies.
        try {
          await h.page.waitForFunction(({eventName,id})=>window.__luisTouchTrace.events.some(e=>
            e.type===eventName && (eventName==='blur' || e.id===id && e.trusted)),
            {eventName,id:down.id},{timeout:850});
        } catch (error) {
          if (error.name!=='TimeoutError') throw error;
        }
        const after=await h.snapshot();
        const witness=after.events.findLast(e=>e.type===eventName && (terminal==='blur' || e.id===down.id && e.trusted));
        if (terminal==='capture-loss' || terminal==='blur') await h.touch('touchEnd');
        h.require(witness,'Required terminal was not observed in the document.');
        h.check('Correct immediate exit',after.mode===expected,{before:before.mode,after:after.mode,expected,terminal:witness});
        await h.waitMode('idle',1100);
        // Also wait past the 350 ms long-press timer after a cancel or lost capture.
        await h.page.waitForTimeout(420);
        const quiet=await h.snapshot();
        h.check('Quiescent before the next input',quiet.mode==='idle' && quiet.frame?.targetX===0 && quiet.frame?.targetY===0,
          {mode:quiet.mode,x:quiet.frame?.targetX,y:quiet.frame?.targetY});
      });
    }
  }
}

export {terminalsMatrix as terminals};
