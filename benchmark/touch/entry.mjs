const textureURL = '**/assets/blue-companion.webp';

async function newDocument(h) {
  await h.page.reload({waitUntil:'commit'});
  await h.page.locator('#window-surface').waitFor();
  await h.refreshBox();
}

async function delayedTexture(h, keepDown) {
  let allow;
  const gate = new Promise(resolve => { allow=resolve; });
  let requested;
  const waiting=new Promise(resolve=>{ requested=resolve; });
  await h.page.route(textureURL, async route => {
    requested();
    await gate;
    await route.continue();
  });
  try {
    await newDocument(h);
    await Promise.race([waiting,h.page.waitForTimeout(3000)]);
    const start=await h.snapshot();
    h.require(start.mode==='loading' && !start.frameCount,'A cold-loading surface must be visible.');
    await h.touch('touchStart',[h.point(.2,.5)]);
    if (!keepDown) await h.touch('touchEnd');
    allow();
    await h.waitMode('idle',7000);
    if (keepDown) {
      await h.touch('touchMove',[h.point(.8,.5)]);
      await h.page.waitForTimeout(170);
      const active=await h.snapshot();
      h.require(active.events.some(e=>e.type==='pointerdown' && e.trusted) && active.events.some(e=>e.type==='pointermove' && e.trusted),'Gesture must span readiness.');
      h.check('Contact still down when ready can start responding', active.mode!=='idle' && active.frame?.targetX>.3,
        {mode:active.mode,target:active.frame?.targetX});
      await h.touch('touchEnd');
    } else {
      await h.page.waitForTimeout(450);
      const end=await h.snapshot();
      h.check('No ghost hold or queued tap after loading',end.mode==='idle' && !end.modes.some(m=>m.mode!=='idle'));
    }
  } finally {
    allow();
    await h.page.unroute(textureURL);
  }
}

export async function entry(t) {
  await t.run({id:'release-before-ready',phase:'entry',input:'mixed',
    expectation:'资源未就绪时已经松开的手指不会在加载后生成幽灵操作。'}, h=>delayedTexture(h,false));
  await t.run({id:'held-across-readiness',phase:'entry',input:'mixed',oracle:'policy',
    expectation:'产品候选：加载完成时仍在窗内按住并移动，应能在同一触摸内取得控制。'}, h=>delayedTexture(h,true));

  await t.run({id:'recover-from-texture-error',phase:'entry',input:'mixed',oracle:'fault',
    expectation:'素材失败时提供可操作的重试入口；故障解除后能重新接管。'}, async h=>{
    await h.page.route(textureURL,r=>r.abort('failed'),{times:1});
    await newDocument(h);
    await h.waitMode('error',5000);
    const retry=h.page.getByRole('button',{name:'重新加载'});
    h.check('An actionable retry is visible',await retry.isVisible());
    await retry.tap();
    await h.waitMode('idle',7000);
  });
  await t.run({id:'offline-after-ready',phase:'entry',input:'mixed',
    expectation:'资源已加载时断网，触摸、释放及后续接管继续工作。'}, async h=>{
    await h.context.setOffline(true);
    await h.touch('touchStart',[h.point(.3,.5)]);
    await h.waitMode('hold');
    await h.touch('touchEnd');
    await h.waitMode('idle');
    h.note('offlineThroughProbe',true);
  });
  await t.run({id:'canvas2d-fallback',phase:'entry',input:'mixed',
    expectation:'禁用 WebGL 后，2D 回退仍接受触点且画面持续可控。'}, async h=>{
    await h.page.addInitScript(()=>{
      const original=HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext=function(kind,...args) {
        if (String(kind).includes('webgl')) return null;
        return original.call(this,kind,...args);
      };
    });
    await newDocument(h);
    await h.waitMode('idle',7000);
    h.require(await h.page.locator('#avatar').evaluate(c=>Boolean(c.getContext('2d'))),'Canvas2D adapter is required.');
  });

  await t.run({id:'repeated-sequences',phase:'session',input:'native-touch',
    expectation:'同一页面连续多轮点击、拖动、滑动和取消，每次新的按下都接管，旧计时器不污染末次释放。'},async h=>{
    const modes=[];
    for (let i=0; i<32; ++i) {
      const id=1+i%4;
      const u=i%2?.2:.8;
      await h.touch('touchStart',[h.point(u,.54,id)]);
      await h.waitMode('press');
      switch (i%4) {
        case 0:
          await h.touch('touchEnd'); await h.waitMode('tap'); modes.push('tap'); break;
        case 1:
          await h.touch('touchMove',[h.point(1-u,.54,id)]); await h.waitMode('swipe');
          await h.touch('touchEnd'); modes.push('swipe'); break;
        case 2:
          await h.waitMode('hold');
          await h.touch('touchMove',[h.point(1-u,.54,id)]); await h.waitMode('drag');
          await h.touch('touchEnd'); await h.waitMode('idle'); modes.push('drag'); break;
        default:
          await h.touch('touchCancel'); await h.waitMode('idle'); modes.push('cancel');
      }
    }
    await h.page.waitForTimeout(550);
    h.check('All 32 input sequences finish; no late timer reactivates the character',modes.length===32 && (await h.snapshot()).mode==='idle');
    h.note('perKind',8);
  });
}
