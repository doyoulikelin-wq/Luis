// Each case runs in a fresh page. The runner also checks a new physical-contact
// sequence and visible output after the case. Chrome CDP is not phone OS input.
const idle = h => h.page.locator('#window-surface').getAttribute('data-gesture');

async function startDrag(h) {
  await h.touch('touchStart', [h.point(.44, .52)]);
  await h.waitMode('hold');
  await h.touch('touchMove', [h.point(.8, .53)]);
  await h.waitMode('drag');
}

async function traceLifecycle(page) {
  await page.evaluate(() => {
    window.luisLifecycleLog = [];
    function log(event) {
      window.luisLifecycleLog.push({
        type: event.type, trusted: event.isTrusted, hidden: document.hidden,
        persisted: event.persisted ?? null, time: Math.round(performance.now())
      });
    }
    for (const e of ['blur', 'focus', 'pagehide', 'pageshow']) window.addEventListener(e, log);
    for (const e of ['freeze', 'resume', 'visibilitychange']) document.addEventListener(e, log);
  });
}

async function navigationReady(h) {
  await h.page.waitForURL(h.url, {waitUntil: 'commit', timeout: 5000});
  await h.page.waitForFunction(() => {
    const mode = document.querySelector('#window-surface')?.dataset.gesture;
    return mode && mode !== 'loading';
  });
  await h.refreshBox();
}

async function livePixels(page) {
  return page.evaluate(() => new Promise(resolve => {
    const canvas = document.querySelector('#avatar');
    const timer = setTimeout(() => resolve(null), 1000);
    canvas.addEventListener('luis:frame', () => {
      clearTimeout(timer);
      const probe = document.createElement('canvas');
      probe.width = 64;
      probe.height = 48;
      const ctx = probe.getContext('2d');
      ctx.drawImage(canvas, 0, 0, 64, 48);
      const {data} = ctx.getImageData(0, 0, 64, 48);
      let visible = 0;
      for (let i = 0; i < data.length; i += 4) {
        // Broad non-black coverage only. Detailed expression is not an oracle.
        if (data[i + 3] > 0 && Math.max(data[i], data[i + 1], data[i + 2]) > 64) visible++;
      }
      resolve(visible);
    }, {once: true});
  }));
}

export async function lifecycle(t) {
  const run = (id, input, expectation, fn, oracle = 'contract') =>
    t.run({id, phase:'lifecycle', input, expectation, oracle}, fn);

  await run('tab-focus-roundtrip', 'mixed', '另一个标签获得焦点后，即使原指没有送达抬起，回来也能恢复。', async h => {
    // Playwright otherwise forces every page to appear focused simultaneously.
    await h.cdp.send('Emulation.setFocusEmulationEnabled', {enabled:false});
    await h.page.bringToFront();
    await traceLifecycle(h.page);
    await startDrag(h);
    const other = await h.context.newPage();
    let log;
    try {
      await other.goto('about:blank');
      await other.bringToFront();
      await h.page.bringToFront();
      log = await h.page.evaluate(() => window.luisLifecycleLog);
    } finally {
      await other.close();
    }
    h.note('signals', log);
    const beforeUp = await idle(h);
    await h.touch('touchEnd', []);
    h.require(log.some(e => e.trusted && (e.type === 'blur' || (e.type === 'visibilitychange' && e.hidden))),
      '未观察到真实窗口失焦或页面隐藏');
    h.check('切回后的旧拖拽已退出（在发送原指抬起之前）', beforeUp === 'idle', {beforeUp});
  });

  await run('visibility-without-terminal', 'injected', '只送达隐藏和恢复信号也会撤销长按计时及原接触。', async h => {
    await h.touch('touchStart', [h.point(.55,.52)]);
    await h.waitMode('press');
    await h.page.evaluate(() => {
      Object.defineProperty(document, 'hidden', {configurable:true, value:true});
      try { document.dispatchEvent(new Event('visibilitychange')); }
      finally { delete document.hidden; }
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await h.page.waitForTimeout(430);
    const beforeUp = await idle(h);
    await h.touch('touchEnd', []);
    h.check('恢复后越过长按期限仍然待机', beforeUp === 'idle', {beforeUp});
  });

  await run('freeze-resume', 'mixed', '浏览器确实冻结期间用户松手，恢复后不会保留旧拖拽。', async h => {
    await h.cdp.send('Emulation.setFocusEmulationEnabled', {enabled:false});
    await traceLifecycle(h.page);
    await startDrag(h);
    await h.cdp.send('Page.setWebLifecycleState', {state:'frozen'});
    // Queue the lift while frozen. Resume from the Node clock even if Chrome
    // postpones delivery until the page becomes active again.
    const release = h.touch('touchEnd', []);
    try {
      await new Promise(resolve => setTimeout(resolve, 450));
    } finally {
      await h.cdp.send('Page.setWebLifecycleState', {state:'active'});
    }
    await release;
    const log = await h.page.evaluate(() => window.luisLifecycleLog);
    const modeAfterResume = await idle(h);
    h.note('signals', log);
    h.require(log.some(e => e.type === 'freeze' && e.trusted) && log.some(e => e.type === 'resume' && e.trusted),
      'CDP 返回成功，但页面未收到可验证的 freeze 和 resume；需后台真机或支持该生命周期的浏览器');
    h.check('冻结恢复后原接触已释放', modeAfterResume === 'idle', {modeAfterResume});
  });

  await run('reload-during-contact', 'native-touch', '刷新时的旧触点不会占用重新载入的页面。', async h => {
    await startDrag(h);
    await h.page.reload({waitUntil:'domcontentloaded'});
    await navigationReady(h);
    const modeAfterReload = await idle(h);
    await h.touch('touchEnd', []);
    h.check('重新载入后旧模式已清除', modeAfterReload === 'idle', {modeAfterReload});
  });

  for (const releaseAway of [false, true]) {
    const id = releaseAway ? 'navigate-back-during-contact' : 'navigate-back-after-release';
    const expectation = releaseAway
      ? '离开时未松手，离开后抬起，再返回后可接受新接触。'
      : '先抬手再离开，返回后可按住、拖动、抬起，作为缓存路径的配对对照。';
    await run(id, 'native-touch', expectation, async h => {
      await traceLifecycle(h.page);
      await startDrag(h);
      if (!releaseAway) await h.touch('touchEnd', []);
      await h.page.goto('about:blank', {waitUntil:'domcontentloaded'});
      if (releaseAway) {
        await h.page.evaluate(() => {
          window.luisReleaseSignals = [];
          for (const type of ['pointerup','pointercancel','touchend','touchcancel']) {
            document.addEventListener(type, e => window.luisReleaseSignals.push({type:e.type, trusted:e.isTrusted}), true);
          }
        });
        await h.touch('touchEnd', []);
        h.note('awayRelease', {requested:true, domSignals:await h.page.evaluate(() => window.luisReleaseSignals)});
      }
      // BFCache restores do not re-fire load; wait on URL and actor readiness.
      await h.page.evaluate(() => history.back());
      await navigationReady(h);
      const log = await h.page.evaluate(() => window.luisLifecycleLog ?? null);
      const persisted = log?.some(e => e.type === 'pageshow' && e.persisted && e.trusted) ?? false;
      const modeOnReturn = await idle(h);
      h.note('restoration', {path:persisted ? 'bfcache' : 'document-recreated-or-unobserved', signals:log, releaseAway});
      h.check('历史返回后旧模式已退出', modeOnReturn === 'idle', {persisted, modeOnReturn});
    });
  }

  await run('persisted-page-only-no-release', 'injected', '若仅投递缓存离开/返回事件而抬起、失焦和隐藏都缺失，旧指不能永久阻塞新指。', async h => {
    // A synthetic owner leaves Chrome's actual touch stream free for the
    // runner's independent native probe. This is an injected missing-signal case.
    await h.page.evaluate(() => {
      const el = document.querySelector('#window-surface');
      const rect = el.getBoundingClientRect();
      el.dispatchEvent(new PointerEvent('pointerdown', {bubbles:true, pointerId:97, pointerType:'touch',
        isPrimary:true, button:0, buttons:1, clientX:rect.x + .42*rect.width, clientY:rect.y + .55*rect.height}));
    });
    await h.waitMode('hold');
    await h.page.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent('pagehide', {persisted:true}));
      window.dispatchEvent(new PageTransitionEvent('pageshow', {persisted:true}));
    });
    const modeOnReturn = await idle(h);
    h.check('恢复后没有占据控制权的上一根指针', modeOnReturn === 'idle', {modeOnReturn});
  }, 'fault');

  await run('modal-during-drag', 'mixed', '拖动中说明弹窗抢占界面，在弹窗内抬起，关闭后小窗可继续使用。', async h => {
    await startDrag(h);
    await h.page.evaluate(() => document.querySelector('#open-help').click());
    h.require(await h.page.locator('#guide').evaluate(dialog => dialog.open), '说明弹窗未真正打开');
    await h.touch('touchEnd', []);
    await h.page.keyboard.press('Escape');
    await h.page.waitForFunction(() => !document.querySelector('#guide').open);
    const modeAfterClose = await idle(h);
    h.check('弹窗关闭后旧拖拽已退出', modeAfterClose === 'idle', {modeAfterClose});
  });

  await run('resize-during-drag', 'mixed', '拖动中画面改为横屏尺寸，允许取消，或用新边界继续跟随并在抬起时退出。', async h => {
    await startDrag(h);
    const previous = h.page.viewportSize();
    try {
      await h.page.setViewportSize({width:844, height:390});
      await h.refreshBox();
      const modeAfterResize = await idle(h);
      if (modeAfterResize === 'drag') {
        await h.touch('touchMove', [h.point(.16,.50)]);
        const {frame} = await h.snapshot();
        // Wait through one presentation so the trace is from the updated viewport.
        if (frame?.targetX >= 0) await h.page.waitForTimeout(100);
        const current = (await h.snapshot()).frame;
        h.check('新坐标系下向左移动仍然被跟踪', current?.targetX < -.3, {targetX:current?.targetX});
      } else h.check('尺寸变化后取消了旧接触', modeAfterResize === 'idle', {modeAfterResize});
      await h.touch('touchEnd', []);
      h.check('横屏抬起已清理', await idle(h) === 'idle');
    } finally {
      await h.page.setViewportSize(previous);
      await h.refreshBox();
    }
  });

  await run('webgl-loss-release-restore', 'mixed', '图形上下文丢失时仍处理抬起，上下文恢复后画布有内容且新手势有效。', async h => {
    const before = await livePixels(h.page);
    h.require(before > 100, '初始画布不可观测');
    const available = await h.page.evaluate(() => {
      const canvas = document.querySelector('#avatar');
      const gl = canvas.getContext('webgl');
      const ext = gl?.getExtension('WEBGL_lose_context');
      if (!ext) return false;
      window.luisGlProbe = {ext, lost:false, restored:false};
      canvas.addEventListener('webglcontextlost', () => { window.luisGlProbe.lost=true; }, {once:true});
      canvas.addEventListener('webglcontextrestored', () => { window.luisGlProbe.restored=true; }, {once:true});
      return true;
    });
    h.require(available, 'WebGL 不支持受控丢失');
    await startDrag(h);
    await h.page.evaluate(() => window.luisGlProbe.ext.loseContext());
    try {
      await h.page.waitForFunction(() => window.luisGlProbe.lost, null, {timeout:1000});
      const during = await livePixels(h.page);
      await h.touch('touchEnd', []);
      h.note('pixelsDuringLoss', {during, before});
      h.check('绘图中断期间响应抬起', await idle(h) === 'idle');
    } finally {
      await h.page.evaluate(() => window.luisGlProbe.ext.restoreContext());
    }
    await h.page.waitForFunction(() => window.luisGlProbe.restored, null, {timeout:2500}).catch(() => {});
    const restored = await h.page.evaluate(() => window.luisGlProbe.restored);
    const after = await livePixels(h.page);
    h.check('实际收到恢复事件且角色画面恢复', restored && after > 100, {restored, after});
    await h.page.evaluate(() => { delete window.luisGlProbe; });
  });
}
