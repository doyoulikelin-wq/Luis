import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {dirname} from 'node:path';
import {windowAdapter} from './window-adapter.mjs';

const require = createRequire(import.meta.url);
const playwrightPath = require.resolve(process.env.LUIS_PLAYWRIGHT_MODULE || 'playwright');
export const {chromium} = require(playwrightPath);
const {PNG} = require(require.resolve('pngjs', {paths:[dirname(playwrightPath)]}));

export class Unverified extends Error {}
export class ModeTimeout extends Error {}

export const profile = {
  viewport: {width:390, height:844}, deviceScaleFactor:1,
  modeBudgetMs:900, terminalBudgetMs:1100, returnBudgetMs:1500,
  visualColumns:80, visualRows:64, minContrast:0.8, repeatNoiseFactor:1.6,
};

function observeDocument() {
  const trace = {events:[], modes:[], downResults:[], frame:null, frameCount:0};
  window.__luisTouchTrace = trace;
  const record = entry => {
    trace.events.push(entry);
    if (trace.events.length > 240) trace.events.shift();
  };
  for (const type of ['pointerdown','pointermove','pointerup','pointercancel','gotpointercapture','lostpointercapture']) {
    window.addEventListener(type, e => {
      record({type, id:e.pointerId, primary:e.isPrimary, pointerType:e.pointerType, trusted:e.isTrusted,
        x:Math.round(e.clientX), y:Math.round(e.clientY), target:e.target.id || e.target.tagName, onSurface:document.querySelector('#window-surface')?.contains(e.target),
        stamp:Math.round(e.timeStamp), t:Math.round(performance.now())});
    }, true);
  }
  window.addEventListener('pointerdown', e => {
    trace.downResults.push({id:e.pointerId, t:Math.round(performance.now()), mode:document.querySelector('#window-surface')?.dataset.gesture});
    if (trace.downResults.length>60) trace.downResults.shift();
  });
  for (const type of ['blur','focus','pagehide','pageshow','freeze','resume','visibilitychange','webglcontextlost','webglcontextrestored']) {
    window.addEventListener(type, e => record({type, trusted:e.isTrusted, persisted:e.persisted, hidden:document.hidden, t:Math.round(performance.now())}), true);
  }
  document.addEventListener('luis:frame', e => {
    const frame = e.detail;
    trace.frameCount++;
    trace.frame = {...frame};
    if (trace.modes.at(-1)?.mode !== frame.mode) {
      trace.modes.push({mode:frame.mode,t:Math.round(performance.now()),rafTime:Math.round(frame.now)});
      if (trace.modes.length > 60) trace.modes.shift();
    }
  }, true);
}

export async function attach(context, page, url) {
  await context.addInitScript(observeDocument);
  page.setDefaultTimeout(4000);
  page.setDefaultNavigationTimeout(14000);
  await page.goto(url, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => window.__luisTouchTrace?.frameCount >= 2 && document.querySelector('#window-surface')?.dataset.gesture === 'idle');
  const surface = page.locator('#window-surface');
  const cdp = await context.newCDPSession(page);
  let box;
  const checks = [], notes = {};
  const refreshBox = async () => {
    box = await surface.boundingBox();
    if (!box || box.width < 2 || box.height < 2) throw new Unverified('No visible interaction surface');
    return box;
  };
  await refreshBox();
  return {
    page, context, cdp, url, checks, notes, refreshBox,
    point(u,v,id=1) { return {x:box.x+u*box.width, y:box.y+v*box.height, id}; },
    touch(type,touchPoints=[]) { return cdp.send('Input.dispatchTouchEvent',{type,touchPoints}); },
    async waitMode(mode, timeoutMs=profile.modeBudgetMs) {
      try {
        await page.waitForFunction(v => document.querySelector('#window-surface')?.dataset.gesture === v, mode, {timeout:timeoutMs,polling:12});
      } catch (error) {
        if (error.name !== 'TimeoutError') throw error;
        throw new ModeTimeout('Expected '+mode+' within '+timeoutMs+' ms');
      }
    },
    snapshot() {
      return page.evaluate(() => ({mode:document.querySelector('#window-surface')?.dataset.gesture, ...window.__luisTouchTrace}));
    },
    check(label, ok, evidence) { checks.push({label,ok:Boolean(ok),evidence}); },
    note(key,value) { notes[key] = value; },
    require(ok,reason) { if (!ok) throw new Unverified(reason); },
  };
}

async function waitFrame(h, predicate, timeout) {
  try {
    await h.page.waitForFunction(predicate, null, {timeout,polling:15});
    return true;
  } catch (e) {
    if (e.name !== 'TimeoutError') throw e;
    return false;
  }
}

// Compare compositor screenshots from the visible surface, including any occluding
// layers. This observer does not depend on blue eyes, skin colours, or a face.
async function imageSample(h, selector, ordinal) {
  const buffer = await h.page.locator(selector).screenshot({scale:'css',timeout:3000});
  h.onProbeScreenshot?.(ordinal,buffer);
  const png = PNG.sync.read(buffer);
  const out = [];
  for (let row=0; row<profile.visualRows; row++) {
    const y = Math.floor((row+.5)*png.height/profile.visualRows);
    for (let col=0; col<profile.visualColumns; col++) {
      const x = Math.floor((col+.5)*png.width/profile.visualColumns);
      const i = 4*(y*png.width+x);
      out.push(png.data[i],png.data[i+1],png.data[i+2]);
    }
  }
  return {rgb:out, sha256:createHash('sha256').update(buffer).digest('hex')};
}
function distance(a,b) {
  const sum = a.rgb.reduce((n,v,i) => n+Math.abs(v-b.rgb[i]),0);
  return +(sum/a.rgb.length).toFixed(3);
}

export async function probeRecovery(h, adapter=windowAdapter) {
  // A new physical-style contact in the SAME document. No reset, reload or synthetic
  // cancel before the probe: that would mask a stale owner in the application.
  await h.refreshBox();
  const old = await h.snapshot();
  const left = h.point(.18,.54,81), right = h.point(.82,.54,81);
  const result = {fromMode:old.mode, accepted:false, tracks:false, rendered:'unverified', released:false, centered:false};
  const aim=await h.page.evaluate(({selector,x,y})=>{
    const target=document.elementFromPoint(x,y);
    const surface=document.querySelector(selector);
    return {x,y,hit:target?.id || target?.tagName,onSurface:Boolean(target && surface?.contains(target)),
      scale:window.visualViewport?.scale};
  },{selector:adapter.surface,x:left.x,y:left.y});
  result.aim=aim;
  const sendAt = await h.page.evaluate(() => Math.round(performance.now()));
  await h.touch('touchStart',[left]);
  try {
    result.accepted = await waitFrame(h,adapter.accepted,adapter.acceptanceBudgetMs);
    const fresh=await h.snapshot();
    const down=fresh.events.find(e=>e.type==='pointerdown' && e.trusted && e.t>=sendAt);
    const acknowledged=fresh.downResults.find(e=>e.id===down?.id && e.t>=sendAt && e.mode===adapter.pressMode);
    if (down && acknowledged) result.downToAckMs=acknowledged.t-down.t;
    result.accepted = result.accepted && Boolean(acknowledged);
    if (result.accepted) {
      const snaps=[];
      for (const [point,sign] of [[null,-1],[right,1],[left,-1]]) {
        if (point) await h.touch('touchMove',[point]);
        const targetObserved = sign < 0 ? adapter.leftReady : adapter.rightReady;
        if (!await waitFrame(h,targetObserved,profile.modeBudgetMs)) break;
        snaps.push(await imageSample(h,adapter.surface,snaps.length));
      }
      result.tracks = snaps.length===3;
      if (result.tracks) {
        const ab=distance(snaps[0],snaps[1]),bc=distance(snaps[1],snaps[2]),ac=distance(snaps[0],snaps[2]);
        result.picture = {leftRight:ab,rightLeft:bc,leftRepeat:ac,sha256:snaps.map(x=>x.sha256)};
        if (Math.min(ab,bc) > Math.max(profile.minContrast,ac*profile.repeatNoiseFactor)) result.rendered='responsive';
        else if (new Set(snaps.map(s=>s.sha256)).size===1) result.rendered='identical';
      }
    }
  } finally {
    await h.touch('touchEnd',[]);
  }
  result.released = await waitFrame(h,adapter.released,profile.terminalBudgetMs);
  result.centered = await waitFrame(h,adapter.neutral,profile.returnBudgetMs);
  const current = await h.snapshot();
  const delivered = current.events.filter(e=>e.t>=Math.floor(sendAt) && e.type.startsWith('pointer') && e.trusted);
  const down=delivered.find(e=>e.type==='pointerdown');
  const up=delivered.findLast(e=>e.type==='pointerup' && e.id===down?.id);
  result.observedDown=Boolean(down);
  result.observedUp=Boolean(up);
  const idleAfterUp=current.modes.find(m=>m.mode==='idle' && m.t>=up?.t);
  if (down) result.down={id:down.id,primary:down.primary,target:down.target,trusted:down.trusted,x:down.x,y:down.y,onSurface:down.onSurface};
  if (down && up) result.eventSpanMs=up.t-down.t;
  if (idleAfterUp) result.releaseToIdleFrameMs=idleAfterUp.t-up.t;
  if (!result.observedDown || !result.observedUp) result.outcome='unverified-delivery';
  else if (Math.hypot(down.x-aim.x,down.y-aim.y)>2) result.outcome='unverified-coordinates';
  else if (!down.onSurface) result.outcome=!aim.onSurface && aim.hit===down.target?'surface-obstructed':'unverified-target';
  else if (!result.accepted || !result.tracks || !result.released || !result.centered) result.outcome='control-failed';
  else if (result.rendered==='identical') result.outcome='presentation-failed';
  else if (result.rendered==='unverified') result.outcome='unverified-picture';
  else result.outcome='pass';
  return result;
}
