// Exercise two returns to the same document. Driver finger IDs stay distinct
// from the touch held when leaving so Chromium cannot silently reuse that finger.
export async function registerReturnGuard(t) {
  await t.run({
    id:'restored-touch-ownership', phase:'lifecycle', input:'native-touch', oracle:'contract',
    expectation:'同一文档两次持按离页并缓存返回。每次返回后的连续新指可控制角色，窗外指仍按住时窗内第二指不能夺权。',
  }, async h=>{
    const rounds=[];
    h.note('rounds',rounds);
    await h.page.evaluate(()=>{
      window.__luisCacheRestores=0;
      window.addEventListener('pageshow',e=>{ if(e.isTrusted && e.persisted) window.__luisCacheRestores++; });
    });
    const originalDocument=await h.page.evaluate(()=>performance.timeOrigin);
    for (let round=1;round<=2;round++) {
      const record={round,newFingers:[]};
      rounds.push(record);
      await h.touch('touchStart',[h.point(.24,.54,1)]);
      await h.waitMode('hold');
      await h.touch('touchMove',[h.point(.8,.54,1)]);
      await h.waitMode('drag');
      await h.page.goto('about:blank',{waitUntil:'domcontentloaded'});
      await h.touch('touchEnd');
      await h.page.evaluate(()=>history.back());
      await h.page.waitForURL(h.url,{waitUntil:'commit'});
      const restored=await h.page.evaluate(()=>({timeOrigin:performance.timeOrigin,restores:window.__luisCacheRestores}));
      record.restored=restored.timeOrigin===originalDocument && restored.restores===round;
      h.require(record.restored,'The original document must report a trusted persisted pageshow for this round.');
      await h.refreshBox();
      await h.waitMode('idle');

      for (const id of [21,22]) {
        const left=h.point(.22,.53,id),right=h.point(.79,.53,id);
        await h.touch('touchStart',[left]);
        const start=await h.snapshot();
        const down=start.events.findLast(e=>e.type==='pointerdown');
        h.require(down?.trusted && down.onSurface && down.pointerType==='touch','Fresh touch must reach the surface.');
        record.newFingers.push({id:down.id,primary:down.primary,mode:start.mode});
        h.check('返回后独立新按下被受理',start.mode==='press',{round,down,mode:start.mode});
        if(start.mode!=='press') {
          await h.touch('touchEnd');
          return;
        }
        await h.waitMode('hold');
        await h.touch('touchMove',[right]);
        await h.waitMode('drag');
        await h.touch('touchEnd');
        await h.waitMode('idle');
      }
      const outside=h.point(.5,-.12,34),inside=h.point(.73,.54,35);
      await h.touch('touchStart',[outside]);
      await h.touch('touchStart',[outside,inside]);
      await h.page.waitForTimeout(420);
      const during=await h.snapshot();
      const [a,b]=during.events.filter(e=>e.type==='pointerdown').slice(-2);
      h.require(a?.trusted && b?.trusted && !a.onSurface && b.onSurface && a.id!==b.id && !b.primary,
        'Two concurrent fingers must be observed, starting outside and inside respectively.');
      record.overlap={outside:a,inside:b,mode:during.mode};
      h.check('返回后窗外手指先按下时，窗内第二指不会夺权',during.mode==='idle',record.overlap);
      await h.touch('touchEnd');
    }
  });
}

export async function registerCombinedGuard(t) {
  await t.run({
    id:'restored-release-with-lost-terminals', phase:'lifecycle', input:'mixed', oracle:'fault',
    expectation:'缓存返回后在无显式捕获时拖动。原生松手但两个指针终止通知均在应用之前被拦截，应自行退场，下一次真实触摸可以恢复控制。',
  }, async h=>{
    // Register before the player to emulate notifications that never reach any
    // of its listeners. An actual TouchEvent remains independent evidence.
    await h.page.addInitScript(()=>{
      const fault=window.__luisRestoredRelease={owner:null,blocked:[],touchEnd:null};
      for(const type of ['pointerup','lostpointercapture']) {
        window.addEventListener(type,e=>{
          if(e.pointerId!==fault.owner) return;
          fault.blocked.push({type:e.type,id:e.pointerId,trusted:e.isTrusted});
          e.stopImmediatePropagation();
        },true);
      }
      window.addEventListener('touchend',e=>{
        if(fault.owner!==null) fault.touchEnd={
          trusted:e.isTrusted,remaining:Array.from(e.touches,t=>t.identifier),
          ended:Array.from(e.changedTouches,t=>t.identifier),
        };
      },{capture:true,passive:true});
    });
    await h.page.reload({waitUntil:'domcontentloaded'});
    await h.waitMode('idle',6500);
    await h.refreshBox();
    const origin=await h.page.evaluate(()=>performance.timeOrigin);
    await h.touch('touchStart',[h.point(.25,.54,1)]);
    await h.waitMode('hold');
    await h.page.goto('about:blank',{waitUntil:'domcontentloaded'});
    await h.touch('touchEnd');
    await h.page.evaluate(()=>history.back());
    await h.page.waitForURL(h.url,{waitUntil:'commit'});
    await h.waitMode('idle');
    await h.refreshBox();
    const arrived=await h.snapshot();
    h.require(await h.page.evaluate(()=>performance.timeOrigin)===origin &&
      arrived.events.some(e=>e.type==='pageshow' && e.trusted && e.persisted),
      'A trusted persisted restore of this document is required.');

    const surface=h.page.locator('#window-surface');
    await surface.evaluate(s=>{s.setPointerCapture=()=>{throw new DOMException('Explicit capture unavailable','NotFoundError');};});
    try {
      await h.touch('touchStart',[h.point(.22,.54,23)]);
      const start=await h.snapshot();
      const down=start.events.findLast(e=>e.type==='pointerdown');
      h.require(down?.trusted && down.onSurface && down.primary===false,'A fresh trusted non-primary touch must reach the restored surface.');
      h.check('恢复后的新指能建立拖拽',start.mode==='press',{down,mode:start.mode});
      if(start.mode!=='press') {await h.touch('touchEnd');return;}
      await h.waitMode('hold');
      await h.touch('touchMove',[h.point(.78,.54,23)]);
      await h.waitMode('drag');
      const captured=await surface.evaluate((s,id)=>s.hasPointerCapture(id),down.id);
      h.require(!captured,'The surface must lack explicit capture for the faulted contact.');
      await h.page.evaluate(id=>{window.__luisRestoredRelease.owner=id;},down.id);
      await h.touch('touchEnd');
      await h.page.waitForTimeout(500);
      const fault=await h.page.evaluate(()=>window.__luisRestoredRelease);
      const end=await h.snapshot();
      h.note('restoredRelease',{down,captured,blocked:fault.blocked,touchEnd:fault.touchEnd,endMode:end.mode});
      h.require(['pointerup','lostpointercapture'].every(type=>fault.blocked.some(e=>e.type===type && e.trusted)) &&
        fault.touchEnd?.trusted && fault.touchEnd.ended.length>0 && fault.touchEnd.remaining.length>0,
        'Both pointer terminals must be withheld while a trusted touchend still lists the old pre-navigation touch.');
      h.check('真实松手后自动退出，旧的跨页 Touch 不会维持拖拽',end.mode==='idle',{mode:end.mode});
    }finally{
      await surface.evaluate(s=>{delete s.setPointerCapture;});
    }
  });
}
