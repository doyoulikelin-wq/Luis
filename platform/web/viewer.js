import {createDemoTrace, validateTrace, FAULTS} from './pose.js';
import {createRenderer} from './figure.js';

export {createDemoTrace, validateTrace} from './pose.js';

export function createViewer(canvas, {onChange = () => {}} = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') throw Error('需要 canvas 舞台元素。');
  const renderer = createRenderer(canvas);
  let trace = createDemoTrace(), mode = 'demo', frame = 0, playing = true;
  let loop = true, skeleton = false, accent = '#526e64', raf = 0, disposed = false;
  let startMs = performance.now(), startT = trace.frames[0].t;
  function state() {
    return {action:trace.action || 'imported', fault:trace.fault || 'none', mode, playing, loop,
      skeleton, accent, frame, frameCount:trace.frames.length, fps:trace.fps, time:trace.frames[frame].t,
      duration:trace.frames[trace.frames.length-1].t-trace.frames[0].t};
  }
  function draw() { if (!disposed) renderer.draw(trace.frames[frame],trace.bones,accent,skeleton); }
  function publish() { draw(); onChange(state()); }
  function request() { if (playing && !disposed && !raf) raf=requestAnimationFrame(tick); }
  function rebase() { startMs=performance.now(); startT=trace.frames[frame].t; request(); }
  function tick(now) {
    raf=0;
    if (!playing || disposed) return;
    const frames=trace.frames, first=frames[0].t, last=frames[frames.length-1].t;
    const span=last-first+1/trace.fps;
    let t=startT+(now-startMs)/1000;
    if (t>=first+span) {
      if (loop) t=first+(t-first)%span;
      else {t=last;playing=false;}
    }
    let lo=0,hi=frames.length;
    while(lo+1<hi) {
      const mid=(lo+hi)>>1;
      if (frames[mid].t<=t) lo=mid;
      else hi=mid;
    }
    if (frame!==lo || !playing) {frame=lo;publish();}
    request();
  }
  function setPlaying(value) {
    playing=!!value;
    if (playing && frame===trace.frames.length-1 && trace.frames.length>1) frame=0;
    if (!playing) {cancelAnimationFrame(raf);raf=0;}
    rebase();publish();
  }
  function seekFrame(index) {
    if (!Number.isFinite(Number(index))) return;
    frame=Math.max(0,Math.min(trace.frames.length-1,Math.round(Number(index))));
    playing=false;cancelAnimationFrame(raf);raf=0;rebase();publish();
  }
  function activate(next, nextMode, autoplay) {
    trace=next;mode=nextMode;frame=0;playing=autoplay;
    renderer.fit(mode==='trace' ? trace : null);rebase();publish();
  }
  const observer=typeof ResizeObserver==='function' ? new ResizeObserver(draw) : null;
  if(observer) observer.observe(canvas); else globalThis.addEventListener('resize',draw);
  const api={
    getState:state, setPlaying, seekFrame,
    stepFrames(delta) { seekFrame(frame+Number(delta)); },
    setAction(action) { activate(createDemoTrace(action,mode==='demo'?trace.fault:'none'),'demo',true); },
    setFault(fault) {
      if(!FAULTS.has(fault)) throw Error('未知故障类型。');
      if(mode!=='demo') return;
      trace=createDemoTrace(trace.action,fault);
      rebase();publish();
    },
    setLoop(value) {loop=!!value;publish();},
    setSkeleton(value) {skeleton=!!value;publish();},
    setAccent(value) {
      if(typeof value==='string' && /^#[0-9a-f]{6}$/i.test(value)){accent=value;publish();}
    },
    exportTrace() {return JSON.parse(JSON.stringify(trace));},
    loadTrace(json) {activate(validateTrace(typeof json==='string'?JSON.parse(json):json),'trace',false);},
    reset() {skeleton=false;loop=true;accent='#526e64';activate(createDemoTrace(),'demo',true);},
    destroy() {
      disposed=true;playing=false;cancelAnimationFrame(raf);raf=0;renderer.destroy();
      if(observer)observer.disconnect();else globalThis.removeEventListener('resize',draw);
    },
  };
  publish();request();
  return api;
}
