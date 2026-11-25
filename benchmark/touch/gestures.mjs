// Bounds refer to Luis v1: 350 ms to hold, 10 CSS px of movement slop.
// Rendered pixels during the shared recovery probe are evaluated separately.
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function current(h, predicate, timeout = 450) {
  const deadline = performance.now() + timeout;
  let observation;
  do {
    observation = await h.snapshot();
    if (predicate(observation)) break;
    await delay(15);
  } while (performance.now() < deadline);
  return observation;
}

function pose(observation) {
  const f = observation.frame;
  return {mode: observation.mode, target: [f?.targetX, f?.targetY],
    eye: [f?.eyeX, f?.eyeY], head: [f?.headX, f?.headY]};
}

function register(t, id, expectation, scenario, oracle = 'contract', input = 'native-touch') {
  return t.run({id, phase: 'recognition', input, oracle, expectation}, scenario);
}

const start = (h, p) => h.touch('touchStart', [p]);
const move = (h, p) => h.touch('touchMove', [p]);
const end = h => h.touch('touchEnd', []);
const at = mode => observation => observation.mode === mode && observation.frame?.mode === mode;

async function sendHorizontalSwipe(h, jitter, sign) {
  const origin = h.point(.50, .57);
  await start(h, origin);
  if (jitter) await move(h, {...origin, x: origin.x - sign*jitter});
  await move(h, h.point(.50 + sign*.16, .57));
  await move(h, h.point(.50 + sign*.37, .57));
  await end(h);
}

async function contactDuration(h, {stallMs = 0, pulseMs = 80, expected = 'tap'} = {}) {
  // Preserve a hardware-like input timestamp when the renderer is unable to service
  // the event queue. No fabricated PointerEvent or change to the application clock.
  await h.page.evaluate(stall => {
    const probe = window.__luisQueueProbe = {events: [], modes: []};
    const surface = document.querySelector('#window-surface');
    for (const type of ['pointerdown', 'pointerup']) {
      window.addEventListener(type, ev => probe.events.push({type, trusted: ev.isTrusted, stamp: ev.timeStamp,
        delivery: performance.now()}), {capture:true, once:true});
    }
    const observer = new MutationObserver(records => {
      for (const record of records) probe.modes.push(record.oldValue);
      probe.modes.push(surface.dataset.gesture);
    });
    observer.observe(surface, {attributes:true, attributeFilter:['data-gesture'], attributeOldValue:true});
    probe.observer = observer;
    if (stall) {
      window.addEventListener('pointerdown', () => {
        const unblockAt = performance.now() + stall;
        // Deliberate, bounded main-thread blockage after Luis has received pointerdown.
        while (performance.now() < unblockAt) { /* failure injection */ }
      }, {once:true});
    }
  }, stallMs);
  const press = h.cdp.send('Input.dispatchTouchEvent', {type:'touchStart', touchPoints:[h.point(.50,.55)],
    timestamp:Date.now()/1000});
  await delay(pulseMs);
  const release = h.cdp.send('Input.dispatchTouchEvent', {type:'touchEnd', touchPoints:[],timestamp:Date.now()/1000});
  await Promise.all([press,release]);
  const trace = await h.page.evaluate(() => {
    const {observer, events, modes} = window.__luisQueueProbe;
    observer.disconnect();
    return {events, modes: [...new Set(modes)], mode:document.querySelector('#window-surface').dataset.gesture};
  });
  const [down,up] = trace.events;
  h.require(down?.type === 'pointerdown' && up?.type === 'pointerup' && down.trusted && up.trusted,
    '原生输入没有抵达页面');
  const eventDurationMs = Math.round(up.stamp - down.stamp);
  const deliveredDurationMs = Math.round(up.delivery - down.delivery);
  h.note('queue', {pulseMs, eventDurationMs, deliveredDurationMs, stallMs, modes:trace.modes});
  const short = expected === 'tap';
  h.require(short ? eventDurationMs >= 0 && eventDurationMs < 345 : eventDurationMs > 355,
    '触点原生时间戳超出了预定分支');
  const timingIsEstablished = stallMs ? deliveredDurationMs >= 400 :
    (short ? deliveredDurationMs < 345 : deliveredDurationMs > 355);
  h.require(timingIsEstablished, '实际投递时长不满足该场景的前置条件');
  h.check('原生输入时长对应的手势被识别', trace.modes.includes(expected), trace.modes);
  h.check('未派发表意相反的定时手势', !trace.modes.includes(short ? 'hold' : 'tap'), trace.modes);
}

export async function gestures(t) {
  for (const distance of [9,10,11]) {
    const expected = distance > 10 ? 'swipe' : 'tap';
    await register(t, 'slop-' + distance + 'px', '短接触移动 ' + distance + ' CSS px 后松开，识别为 ' + expected, async h => {
      const p = h.point(.50,.55);
      await start(h, p);
      await move(h, {...p,x:p.x+distance});
      await end(h);
      const s = await current(h, at(expected), 180);
      const inputs = s.events.filter(event => event.trusted && ['pointerdown', 'pointermove', 'pointerup'].includes(event.type));
      const down = inputs[0], up = inputs.at(-1);
      h.require(down?.type === 'pointerdown' && up?.type === 'pointerup', '缺少完整的短接触轨迹');
      const observedDistance = Math.max(...inputs.map(event => Math.hypot(event.x-down.x, event.y-down.y)));
      const duration = up.stamp-down.stamp;
      h.note('actualInput', {duration, observedDistance});
      h.require(duration < 345 && Math.abs(observedDistance-distance) <= .5, '实际投递不满足本次时长和位移条件');
      h.check('移动容差分支', s.mode === expected, pose(s));
    });
  }

  await register(t, 'stationary-hold-small-drag', '保持静止允许持续长按，离开容差后能开始跟随，再回到起点仍能更新', async h => {
    const p = h.point(.50,.55);
    await start(h, p);
    await h.waitMode('hold');
    await move(h,{...p,x:p.x+7});
    await delay(450);
    const held = await h.snapshot();
    h.check('固定目标与轻微抖动保持长按', held.mode === 'hold', pose(held));
    await move(h,{...p,x:p.x+18});
    const dragged = await current(h, s => s.frame?.mode === 'drag' && s.frame.targetX > .03);
    h.check('静止后的小幅拖动可以开始', dragged.frame?.mode === 'drag' && dragged.frame.targetX > .03, pose(dragged));
    await move(h,p);
    const returned = await current(h, s => s.frame?.mode === 'drag' && Math.abs(s.frame.targetX)<.025);
    h.check('回到起点的拖动不会卡在上一个目标', returned.mode === 'drag' && Math.abs(returned.frame?.targetX)<.025, pose(returned));
    await end(h);
  });

  await register(t, 'drag-pause-and-mirrored-reversals', '长按后四个象限反复换向，中间停住，再次移动无需重新落指', async h => {
    await start(h,h.point(.50,.55));
    await h.waitMode('hold');
    const checkpoints=[];
    for (const [u,v] of [[.80,.73],[.18,.22],[.82,.23],[.19,.73]]) {
      await move(h,h.point(u,v));
      const sx = Math.sign(u-.5), sy = Math.sign(v-.55);
      const follows = o => o.frame?.mode === 'drag' && o.frame.eyeX*sx > .15 && o.frame.eyeY*sy > .15;
      const observed = await current(h, follows);
      checkpoints.push({u,v,...pose(observed)});
      h.check('双轴反向 '+u+','+v, follows(observed), pose(observed));
      await delay(140);
    }
    await delay(550);
    await move(h,h.point(.82,.23));
    const resumed = await current(h, s => s.frame?.mode === 'drag' && s.frame.eyeX>.15 && s.frame.eyeY<-.15);
    h.check('停顿后同一触点继续拖动', resumed.frame?.eyeX>.15 && resumed.frame?.eyeY<-.15 && resumed.mode==='drag', pose(resumed));
    h.note('checkpoints',checkpoints);
    await end(h);
  });

  await register(t, 'rapid-drag-roundtrip', '短时间多次反向后，渲染目标收敛到最后的触点', async h => {
    await start(h,h.point(.50,.55));
    await h.waitMode('hold');
    const sequence = [.82,.18,.78,.20,.84];
    for (const x of sequence) await move(h,h.point(x,.55));
    const observed=await current(h,s=>s.frame?.mode==='drag' && s.frame.targetX>.6 && s.frame.eyeX>.45);
    h.check('最新接触位置生效', observed.mode==='drag' && observed.frame?.targetX>.6 && observed.frame?.eyeX>.45,pose(observed));
    await end(h);
  });

  await register(t, 'repeat-tap-preempts-tail', '交替轻点四次且每次都在上一反应结束前重新按下，新触点都能接管', async h => {
    for (const [i,u] of [.18,.82,.18,.82].entries()) {
      const sign = Math.sign(u-.5);
      await start(h,h.point(u,.55));
      const down = await current(h,s=>s.frame?.mode==='press' && s.frame.targetX*sign>.5,160);
      h.check('按下 '+(i+1),down.mode==='press' && down.frame?.targetX*sign>.5,pose(down));
      await end(h);
      const up=await current(h,at('tap'),120);
      h.check('点按 '+(i+1),up.mode==='tap',pose(up));
    }
  });

  // A new contact might unstick an old state. Verify passive release first,
  // before the harness sends its fresh control probe.
  for (const action of ['tap', 'hold', 'drag', 'swipe']) {
    await register(t, 'unattended-release-' + action,
      action + '松手后即使没有后续输入，也要自行释放并回正，旧状态不能再次出现', async h => {
        await start(h, h.point(.82, .25));
        if (action === 'hold' || action === 'drag') await h.waitMode('hold');
        if (action === 'swipe' || action === 'drag') {
          await move(h, h.point(.16, .80));
          await h.waitMode(action);
        }
        if (action === 'tap') await delay(65);
        const before = await h.snapshot();
        h.require(before.mode === (action === 'tap' ? 'press' : action), '未建立预期手势');
        await end(h);
        const neutral = s => {
          const f = s.frame;
          return s.mode === 'idle' && f?.mode === 'idle' && Math.abs(f.targetX) < .01
            && Math.abs(f.targetY) < .01 && Math.abs(f.eyeX) < .12 && Math.abs(f.eyeY) < .12
            && Math.abs(f.headX) < .12 && Math.abs(f.headY) < .12 && f.press < .08 && f.leanIn < .10;
        };
        const terminal = await current(h, neutral, 1500);
        h.check('无后续触摸时双轴、按压与前探均释放', neutral(terminal),
          {...pose(terminal), press:terminal.frame?.press, leanIn:terminal.frame?.leanIn});
        await delay(160);
        const stable = await h.snapshot();
        h.check('终态稳定', neutral(stable), pose(stable));
      });
  }

  for (const old of ['tap','swipe']) {
    await register(t, old+'-tail-with-new-hold', '前一'+old+'的回正期限不能覆盖新的长按或拖拽', async h => {
      await start(h,h.point(.22,.55));
      if (old==='swipe') await move(h,h.point(.88,.55));
      await end(h);
      const first=await current(h,at(old),150);
      h.require(first.mode===old, '没有建立上一段的收尾状态');
      await delay(155);
      await start(h,h.point(.20,.55));
      // Wait beyond both the old tail and the new contact's hold boundary.
      await delay(470);
      const held=await current(h,at('hold'),140);
      h.check('旧收尾之后新长按仍属活跃触点',held.mode==='hold' && held.frame?.targetX<-.5,pose(held));
      await move(h,h.point(.82,.55));
      const dragged=await current(h,s=>s.frame?.mode==='drag' && s.frame.eyeX>.25);
      h.check('新输入可在旧收尾后换向',dragged.mode==='drag' && dragged.frame?.eyeX>.25,pose(dragged));
      await end(h);
    });
  }

  for (const distance of [7,14]) {
    for (const sign of [-1,1]) {
      await register(t, 'main-swipe-'+(sign<0?'left':'right')+'-after-'+distance+'px',
        '单次短划以显著净位移为意图，逆向轻移后应采用主方向', async h=>{
          await sendHorizontalSwipe(h,distance,sign);
          const observed=await current(h,s=>s.frame?.mode==='swipe' && (s.frame.eyeX*s.frame.targetX)>.25,180);
          h.require(observed.mode==='swipe' && observed.frame?.mode==='swipe','轨迹没有被识别为一次短滑');
          h.check('主滑方向被接受',observed.frame.targetX*sign>.5 && observed.frame.eyeX*sign>.15,pose(observed));
        },'policy');
    }
  }

  await register(t, 'early-move-pause-then-retarget', '用户持续触摸并改为跟随时，应有机会从先前认定的滑动恢复',async h=>{
    const origin=h.point(.50,.55);
    await start(h,origin);
    await delay(115);
    await move(h,{...origin,x:origin.x+18});
    const first=await current(h,at('swipe'),140);
    h.require(first.mode==='swipe','没有先进入一次滑动');
    await delay(480);
    await move(h,h.point(.85,.55));
    await move(h,h.point(.16,.55));
    await delay(230);
    const last=await h.snapshot();
    h.note('initial_and_late', {first:pose(first),last:pose(last)});
    h.check('同一次未抬起接触可以接管新目标',last.frame?.targetX<-.5 && last.frame?.eyeX<-.2,pose(last));
    await end(h);
  },'policy');

  await register(t,'release-only-displacement','仅抬起事件带有最终位移时仍能识别一次滑动',async h=>{
    const startPoint=h.point(.72,.55), endPoint=h.point(.25,.55);
    await h.page.evaluate(([a,b])=>{
      const surface=document.querySelector('#window-surface');
      const options={pointerId:301,pointerType:'touch',isPrimary:true,bubbles:true,cancelable:true,button:0};
      surface.dispatchEvent(new PointerEvent('pointerdown',{...options,buttons:1,clientX:a.x,clientY:a.y}));
      surface.dispatchEvent(new PointerEvent('pointerup',{...options,buttons:0,clientX:b.x,clientY:b.y}));
    }, [startPoint,endPoint]);
    const observed=await current(h,at('swipe'),180);
    h.check('只有最终位移时仍能提交主方向',observed.mode==='swipe' && observed.frame?.targetX<-.6,pose(observed));
  }, 'contract','injected');

  await register(t,'stationary-release-320ms','无移动，实际接触时间位于长按门槛下方时仍确认点按',
    h=>contactDuration(h,{pulseMs:320}));
  await register(t,'stationary-release-380ms','无移动，实际接触时间位于长按门槛上方时确认长按并释放',
    h=>contactDuration(h,{pulseMs:380,expected:'hold'}));
  await register(t, 'release-queued-behind-drag', '拖动时主线程阻塞，同一次触摸的折返和松手相继排队，恢复后能结束且不会重播过期拖动', async h => {
    await start(h, h.point(.20, .55));
    await h.waitMode('hold');
    await move(h, h.point(.33, .55));
    await h.waitMode('drag');
    await h.page.evaluate(() => {
      window.addEventListener('pointermove', () => {
        const stop = performance.now() + 460;
        while (performance.now() < stop) { /* temporary stall during an active drag */ }
      }, {once:true});
    });
    const before = await h.snapshot();
    const eventCount = before.events.length;
    const send = (type, points) => h.cdp.send('Input.dispatchTouchEvent', {
      type, touchPoints: points, timestamp: Date.now() / 1000,
    });
    const first = send('touchMove', [h.point(.88, .55)]);
    await delay(100);
    const reversal = send('touchMove', [h.point(.18, .55)]);
    await delay(70);
    const release = send('touchEnd', []);
    await Promise.all([first, reversal, release]);
    await delay(400);
    const after = await h.snapshot();
    const events = after.events.slice(eventCount).filter(e => e.trusted && (e.type === 'pointerup' || e.type === 'pointermove'));
    const initialMove = events.find(e => e.type === 'pointermove');
    const up = events.find(e => e.type === 'pointerup');
    h.require(initialMove && up, '拖拽及松手的输入轨迹不完整');
    const eventSpan = up.stamp - initialMove.stamp;
    const deliverySpan = up.t - initialMove.t;
    h.note('queuedDrag', {eventSpan, deliverySpan, events, final:pose(after)});
    h.require(eventSpan > 0 && eventSpan < 320 && deliverySpan >= 350, '没有建立触点先松开、JS 后处理的时间条件');
    h.check('最后的松手赢过过期的拖拽', after.mode === 'idle' && after.frame?.mode === 'idle'
      && after.frame.targetX === 0 && Math.abs(after.frame.eyeX) < .12, pose(after));
  }, 'fault', 'mixed');
  await register(t,'short-tap-load-control','事件时间中 80 ms 短按在正常投递时有点按响应',h=>contactDuration(h));
  await register(t,'short-tap-blocked-delivery','主线程一次性阻塞 480 ms，已按下又松开的短触点仍按物理输入时长识别',h=>contactDuration(h,{stallMs:480}),'fault','mixed');
}
