// These predicates execute inside the preview document. A video player, sprite
// renderer or skeletal runtime can supply its own visible A/B states and neutral pose.
export const windowAdapter = {
  surface: '#window-surface',
  pressMode: 'press',
  acceptanceBudgetMs: 1250,
  accepted() {
    const f=window.__luisTouchTrace.frame;
    return f?.mode==='hold' && f.targetX<-.55 && f.eyeX<-.55;
  },
  leftReady() {
    const f=window.__luisTouchTrace.frame;
    return f?.targetX<-.55 && f.eyeX<-.62 && f.headX<-.59 && f.leanIn>.91 && f.blink<.02;
  },
  rightReady() {
    const f=window.__luisTouchTrace.frame;
    return f?.mode==='drag' && f.targetX>.55 && f.eyeX>.62 && f.headX>.59 && f.blink<.02;
  },
  released() {
    return document.querySelector('#window-surface')?.dataset.gesture==='idle';
  },
  neutral() {
    const f=window.__luisTouchTrace.frame;
    return f?.mode==='idle' && Math.abs(f.targetX)<.01 && Math.abs(f.targetY)<.01 &&
      Math.hypot(f.eyeX,f.eyeY)<.12 && Math.hypot(f.headX,f.headY)<.12 && f.press<.08 && f.leanIn<.12;
  },
};
