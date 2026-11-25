const surface = document.querySelector('#window-surface');
const canvas = document.querySelector('#avatar');
const status = document.querySelector('#status');
const retry = document.querySelector('#retry');
const guide = document.querySelector('#guide');
const inspectFrames = new URLSearchParams(location.search).has('inspect');

document.querySelector('#open-help').addEventListener('click', () => guide.showModal());
guide.addEventListener('click', event => {
  if (event.target !== guide) return;
  const box = guide.getBoundingClientRect();
  if (event.clientX < box.left || event.clientX > box.right ||
      event.clientY < box.top || event.clientY > box.bottom) guide.close();
});
retry.addEventListener('click', () => location.reload());

const looks = {left: '向左看', right: '向右看', up: '向上看', down: '向下看'};
function showGesture(mode, {zone, direction}) {
  const labels = {
    idle: '等待触碰', press: '注意到了', hold: '持续注视', drag: '跟着手指',
    tap: zone === 'sill' ? '轻扣窗沿' : zone === 'face' ? '回应轻点' : '看向触点',
    swipe: looks[direction],
  };
  status.textContent = labels[mode];
}

let controller;
let actor;
let frameId = 0;
function stopFrame() {
  cancelAnimationFrame(frameId);
  frameId = 0;
}
function showError(error) {
  console.error('Luis character window', error);
  stopFrame();
  controller?.destroy();
  controller = null;
  surface.dataset.gesture = 'error';
  status.textContent = '小窗加载失败';
  retry.hidden = false;
}
function render(now) {
  frameId = 0;
  try {
    const state = controller.sample(now);
    actor.draw(state, now / 1000);
    if (inspectFrames) canvas.dispatchEvent(new CustomEvent('luis:frame', {detail: {...state, now}}));
    frameId = requestAnimationFrame(render);
  } catch (error) {
    showError(error);
  }
}
function refresh() {
  if (document.hidden) stopFrame();
  else if (controller && !frameId) frameId = requestAnimationFrame(render);
}
document.addEventListener('visibilitychange', refresh);
window.addEventListener('pageshow', refresh);
window.addEventListener('pagehide', event => {
  stopFrame();
  if (!event.persisted) {
    controller?.destroy();
    controller = null;
    actor?.dispose();
  }
});
try {
  const [{createActor}, {connectInteraction}] = await Promise.all([
    import('./actor.js'), import('./interaction.js?v=touch-recovery-1'),
  ]);
  actor = await createActor(canvas);
  controller = connectInteraction(surface, showGesture);
  refresh();
} catch (error) {
  showError(error);
}
