// All three scenes use the same additional scroll space. Only the location of
// contact or a single CSS policy changes. The Luis page and controller stay alive.
async function verticalPan(h, variant) {
  const outside = variant === 'outside';
  const allowPan = variant === 'inside-auto';
  const surface = h.page.locator('#window-surface');
  const fixture = await surface.evaluate((s, auto) => {
    const spacer = document.createElement('div');
    spacer.setAttribute('data-benchmark-scroll-fixture', '');
    spacer.setAttribute('aria-hidden', 'true');
    spacer.style.height = '150vh';
    document.body.appendChild(spacer);
    const oldAction = s.style.touchAction;
    if (auto) s.style.touchAction = 'auto';
    return {
      oldAction,
      effectiveAction: getComputedStyle(s).touchAction,
      scrollY,
      room: document.scrollingElement.scrollHeight - innerHeight - scrollY,
    };
  }, allowPan);
  try {
    const box = await h.refreshBox();
    const point = h.point(.5, .78, 44);
    if (outside) point.x = Math.max(1, box.x / 2);
    const hit = await h.page.evaluate(({x, y}) =>
      document.querySelector('#window-surface').contains(document.elementFromPoint(x, y)), point);
    h.require(hit === !outside && fixture.room > 240, '滚动空间或起始触点不足以构成对照');
    h.require(fixture.effectiveAction === (allowPan ? 'auto' : 'none'), '触摸区域仲裁配置不符合本次条件');
    await h.touch('touchStart', [point]);
    // Screenspace coordinates stay fixed even as the page scrolls beneath the finger.
    for (const dy of [16, 34, 54, 76, 98, 120]) {
      await new Promise(resolve => setTimeout(resolve, 32));
      await h.touch('touchMove', [{...point, y:point.y - dy}]);
    }
    await new Promise(resolve => setTimeout(resolve, 160));
    await h.touch('touchEnd', []);
    await new Promise(resolve => setTimeout(resolve, 180));
    const s = await h.snapshot();
    const events = s.events.filter(e => e.trusted && e.pointerType === 'touch');
    const terminal = events.filter(e => e.type === 'pointercancel' || e.type === 'pointerup');
    const travel = Math.round(await h.page.evaluate(() => scrollY) - fixture.scrollY);
    const evidence = {
      inside: hit, touchAction: fixture.effectiveAction, scrollDelta: travel,
      mode: s.mode, modesSeen:s.modes.map(m => m.mode),
      terminal: terminal.map(e => ({type:e.type, id:e.id, target:e.target})),
    };
    h.note('arbitration', evidence);
    h.require(events.some(e => e.type === 'pointerdown'), '页面没有收到受信任的起始触摸');
    if (outside || allowPan) {
      h.require(travel > 20, '没有观测到浏览器实际接管滚动');
      h.check('原生滚动终止了本次指针流', terminal.some(e => e.type === 'pointercancel'), evidence);
      if (outside) {
        h.check('窗外滚动期间角色保持空闲', !s.modes.some(m => m.mode !== 'idle') && s.mode === 'idle', evidence);
      } else {
        h.check('原生滚动接管前接触已到达角色', s.modes.some(m => m.mode === 'press' || m.mode === 'swipe'), evidence);
        h.check('接管后角色自动放手', s.mode === 'idle' && s.frame?.mode === 'idle'
          && !s.frame.targetX && !s.frame.targetY, evidence);
      }
    } else {
      h.check('窗内输入阻止页面滚动并保留原生松手', Math.abs(travel) <= 2 && terminal.some(e => e.type === 'pointerup')
        && !terminal.some(e => e.type === 'pointercancel'), evidence);
      h.check('窗内竖划得到角色回应', s.modes.some(m => m.mode === 'swipe'), evidence);
    }
  } finally {
    // Restore only the injected layout/policy before the normal recovery probe.
    // No synthetic pointer release, controller reset, navigation, or reload.
    await surface.evaluate((s, action) => {
      s.style.touchAction = action;
      document.querySelector('[data-benchmark-scroll-fixture]')?.remove();
      window.scrollTo(0, 0);
    }, fixture.oldAction);
  }
}

async function twoFingerZoom(h, allowZoom) {
  const surface = h.page.locator('#window-surface');
  const oldAction = await surface.evaluate((s, allow) => {
    const previous = s.style.touchAction;
    if (allow) s.style.touchAction = 'auto';
    return previous;
  }, allowZoom);
  try {
    const getScale = () => h.page.evaluate(() => window.visualViewport?.scale);
    const initial = await getScale();
    h.require(initial === 1, '缺少可观测的默认视觉视口');
    const center = h.point(.5, .5);
    const pair = dx => [
      {...center, x:center.x-dx, id:4},
      {...center, x:center.x+dx, id:5},
    ];
    await h.touch('touchStart', pair(20));
    for (const dx of [28,36,44,52,60,68,76,84]) {
      await new Promise(resolve => setTimeout(resolve, 28));
      await h.touch('touchMove', pair(dx));
    }
    await h.touch('touchEnd', []);
    await new Promise(resolve => setTimeout(resolve, 530));
    const current = await h.snapshot();
    const final = await getScale();
    const events = current.events.filter(e => e.trusted && e.pointerType === 'touch');
    const ids = type => [...new Set(events.filter(e => e.type === type).map(e => e.id))];
    const down = ids('pointerdown'), cancelled = ids('pointercancel'), up = ids('pointerup');
    const evidence = {initialScale:initial, finalScale:final, down, cancelled, up, modes:current.modes.map(m => m.mode)};
    h.note('pinch', evidence);
    h.require(down.length === 2, '没有观测到两根真实触点');
    if (allowZoom) {
      h.require(final > initial + .10, '没有观测到浏览器实际缩放');
      h.check('浏览器接管缩放后取消两根触点', cancelled.length === 2, evidence);
      h.check('浏览器接管缩放后角色无残留长按', current.mode === 'idle' && current.frame?.mode === 'idle', evidence);
    } else {
      h.check('默认窗口保留触点且浏览器视口未缩放',
        Math.abs(final-initial) < .01 && up.length === 2 && !cancelled.length, evidence);
      h.check('两根触点释放后角色最终空闲', current.mode === 'idle' && current.frame?.mode === 'idle', evidence);
    }
  } finally {
    await surface.evaluate((s, previous) => {s.style.touchAction = previous;}, oldAction);
    // Restore only the test viewport; no controller input or reload.
    if (allowZoom) {
      await h.cdp.send('Emulation.setPageScaleFactor', {pageScaleFactor:1});
      await h.page.waitForFunction(() => Math.abs(window.visualViewport.scale - 1) < .01);
    }
    await h.page.evaluate(() => window.scrollTo(0, 0));
  }
}

export async function arbitration(t) {
  for (const [variant, expectation] of [
    ['inside-none','默认黑窗内竖划由角色接收，页面保持位置'],
    ['inside-auto','允许原生滚动时，浏览器接管窗内竖划并真实取消指针，角色能放手'],
    ['outside','从黑窗外起手，同一页面能原生滚动，角色不会抢占指针'],
  ]) {
    await t.run({id:'browser-pan-'+variant,phase:'arbitration',input:'mixed',oracle:'contract',expectation},
      h => verticalPan(h, variant));
  }
  for (const allow of [false, true]) {
    await t.run({id: allow ? 'browser-pinch-auto' : 'browser-pinch-none',phase:'arbitration',
      input:allow ? 'mixed' : 'native-touch',oracle:'contract',
      expectation:allow ? '允许缩放时由浏览器接管两根触点，角色解除按压' : '黑窗默认双指外扩不放大视口，两根触点结束后角色可恢复'},
      h => twoFingerZoom(h, allow));
  }
}
