// Preserve the trusted TouchEvent stream while deliberately delaying delivery of
// the corresponding PointerEvent release across at least one presented frame.
export async function registerOrderedRelease(t) {
  await t.run({id:'touchend-before-pointerup', phase:'repair', input:'mixed', oracle:'contract',
    expectation:'同一次松手的 touchend 先到、pointerup 晚一帧时，轻点和短划仍保留原有回应并正常结束。'}, async h=>{
    for (const action of ['tap','swipe']) {
      await h.page.evaluate(()=>{
        const controller=new AbortController();
        const capture={capture:true,signal:controller.signal};
        const state={};
        window.__orderedRelease=state;
        let pending;
        window.addEventListener('pointerup',event=>{
          if (!event.isTrusted || pending) return;
          pending={id:event.pointerId, x:event.clientX, y:event.clientY, target:event.target};
          state.downId=event.pointerId;
          state.upStamp=event.timeStamp;
          event.stopImmediatePropagation();
        },capture);
        window.addEventListener('lostpointercapture',event=>{
          if (pending?.id!==event.pointerId) return;
          state.captureLossHeld=event.isTrusted;
          event.stopImmediatePropagation();
        },capture);
        window.addEventListener('touchend',event=>{
          if (!event.isTrusted || !pending || event.touches.length) return;
          state.touchEndStamp=event.timeStamp;
          state.startFrame=window.__luisTouchTrace.frameCount;
          requestAnimationFrame(()=>requestAnimationFrame(()=>{
            controller.abort();
            const surface=document.querySelector('#window-surface');
            state.beforeReplay=surface.dataset.gesture;
            pending.target.dispatchEvent(new PointerEvent('pointerup',{bubbles:true,pointerType:'touch',isPrimary:true,
              pointerId:pending.id,clientX:pending.x,clientY:pending.y,button:0,buttons:0}));
            state.afterReplay=surface.dataset.gesture;
            state.replayAt=performance.now();
            state.frameGap=window.__luisTouchTrace.frameCount-state.startFrame;
          }));
        },{signal:controller.signal});
      });
      await h.touch('touchStart',[h.point(.2,.55)]);
      await h.waitMode('press');
      if (action==='swipe') {
        await h.touch('touchMove',[h.point(.8,.55)]);
        await h.waitMode('swipe');
      }
      await h.touch('touchEnd');
      await h.page.waitForFunction(()=>window.__orderedRelease.afterReplay!==undefined);
      const evidence=await h.page.evaluate(()=>{
        const trace=window.__luisTouchTrace;
        const order=window.__orderedRelease;
        const down=trace.events.findLast(event=>event.type==='pointerdown' && event.id===order.downId && event.trusted);
        return {...order,downStamp:down?.stamp};
      });
      h.note(action,evidence);
      h.require(evidence.captureLossHeld && evidence.frameGap>=1 && Number.isFinite(evidence.downStamp) &&
        evidence.replayAt-evidence.downStamp<320,'A short physical contact and delayed pointerup across a frame are required.');
      h.check(action+' retains its response after the deferred pointerup',evidence.afterReplay===action,evidence);
      await h.waitMode('idle',1100);
    }
  });
}
