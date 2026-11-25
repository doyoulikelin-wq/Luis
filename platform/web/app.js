const $ = (selector) => document.querySelector(selector);
const actionButtons = [...document.querySelectorAll('[data-action]')];
const tabs = [...document.querySelectorAll('[role="tab"]')];
const storageKey = 'luis.motion-workspace.v1';
const actions = new Set(['idle', 'nod', 'wave']);
const faults = new Set(['none', 'stretch', 'detach', 'jitter']);
const controls = ['#play', '#prev', '#next', '#loop', '#skeleton', '#scrub', '#reset', '#export-file', '#import-file'];
let viewer;
let imported;
let writeTimer;
let importRequest = 0;
let dirty = false;
let lastSignature = '';
let currentAccent;

function notice(message, error = false) {
  const target = $('#notice');
  target.textContent = message;
  target.classList.toggle('is-error', error);
}
function storageStatus(message, error = false) {
  const target = $('#storage-status');
  target.textContent = message;
  target.classList.toggle('is-error', error);
}
function errorText(error) {
  return error instanceof Error && error.message ? error.message : String(error);
}
function selectTab(selected, focus = false) {
  document.body.classList.toggle('companion-active', selected.id === 'tab-companion');
  for (const tab of tabs) {
    const active = tab === selected;
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute('aria-controls'));
    panel.hidden = !active;
  }
  if (focus) selected.focus();
}
for (const [index, tab] of tabs.entries()) {
  tab.addEventListener('click', () => selectTab(tab));
  tab.addEventListener('keydown', (event) => {
    const next = {ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1}[event.key];
    if (next !== undefined) {
      event.preventDefault();
      selectTab(tabs[next], true);
    }
  });
}

function update(state) {
  const signature = [state.mode, state.action, state.fault, state.playing, state.loop, state.skeleton, state.fps, state.frameCount, imported?.name].join('|');
  if (signature !== lastSignature) {
    lastSignature = signature;
    const isTrace = state.mode === 'trace';
    $('#source-kind').textContent = isTrace ? '导入轨迹' : '合成夹具';
    $('#source-name').textContent = isTrace ? (imported?.name || '导入文件') : '内置上半身夹具';
    $('#fault').disabled = isTrace;
    $('#fault').value = faults.has(state.fault) ? state.fault : 'none';
    $('#fault').title = isTrace ? '导入轨迹将按原始骨骼数据回放。选择内置动作后可切换故障。' : '';
    for (const button of actionButtons) button.setAttribute('aria-pressed', String(!isTrace && state.action === button.dataset.action));
    $('#sample-rate').textContent = state.fps + ' fps';
    $('#frame-total').textContent = String(state.frameCount);
    $('#scrub').max = String(Math.max(0, state.frameCount - 1));
    $('#time-total').textContent = state.duration.toFixed(2) + ' s';
    $('#play-symbol').setAttribute('href', state.playing ? '#i-pause' : '#i-play');
    $('#play').setAttribute('aria-label', state.playing ? '暂停' : '播放');
    $('#loop').setAttribute('aria-pressed', String(state.loop));
    $('#skeleton').checked = state.skeleton;
  }
  const frame = state.frame + 1;
  $('#scrub').value = String(state.frame);
  $('#scrub').setAttribute('aria-valuetext', '第 ' + frame + ' 帧，共 ' + state.frameCount + ' 帧');
  $('#counter').textContent = frame + ' / ' + state.frameCount;
  const origin = state.mode === 'trace' ? (imported?.trace.frames[0].t ?? 0) : 0;
  $('#time-current').textContent = Math.max(0, state.time - origin).toFixed(2) + ' s';
}
function saveNow() {
  clearTimeout(writeTimer);
  if (!viewer || !dirty) return;
  try {
    const {action, fault, playing, loop, skeleton, frame, mode} = viewer.getState();
    const record = {version: 1, action, fault, playing, loop, skeleton, frame};
    if (mode === 'trace' && imported) record.imported = imported;
    localStorage.setItem(storageKey, JSON.stringify(record));
    dirty = false;
    storageStatus('已保存到本机');
  } catch (error) {
    storageStatus('本机保存失败', true);
    notice('本次预览仍可用，浏览器未保存设置或导入文件。请导出需要保留的轨迹。' + errorText(error), true);
  }
}
function changed() {
  dirty = true;
  clearTimeout(writeTimer);
  writeTimer = setTimeout(saveNow, 180);
}
function changeAction(action) {
  if (!viewer || !actions.has(action)) return;
  importRequest++;
  viewer.setAction(action);
  imported = undefined;
  update(viewer.getState());
  changed();
}
function restore() {
  try {
    const saved = localStorage.getItem(storageKey);
    if (!saved) {
      storageStatus('本机工作区');
      if (matchMedia('(prefers-reduced-motion: reduce)').matches) viewer.setPlaying(false);
      return;
    }
    const record = JSON.parse(saved);
    if (!record || record.version !== 1) throw new Error('工作区版本无法识别');
    if (record.imported) {
      viewer.loadTrace(record.imported.trace);
      imported = {trace: record.imported.trace, name: String(record.imported.name || '导入文件')};
    } else {
      if (!actions.has(record.action) || !faults.has(record.fault)) throw new Error('动作或故障设置无效');
      viewer.setAction(record.action);
      viewer.setFault(record.fault);
    }
    viewer.setLoop(Boolean(record.loop));
    viewer.setSkeleton(Boolean(record.skeleton));
    viewer.seekFrame(Number.isInteger(record.frame) ? record.frame : 0);
    viewer.setPlaying(Boolean(record.playing) && !matchMedia('(prefers-reduced-motion: reduce)').matches);
    storageStatus('已恢复本机设置');
  } catch (error) {
    imported = undefined;
    viewer.reset();
    storageStatus('本机读取失败', true);
    notice('无法恢复上次工作区，已打开内置夹具。' + errorText(error), true);
  }
}
function togglePlaying() {
  viewer.setPlaying(!viewer.getState().playing);
  changed();
}
function step(amount) {
  viewer.setPlaying(false);
  viewer.stepFrames(amount);
  changed();
}
function bindControls() {
  for (const id of controls) $(id).disabled = false;
  for (const button of actionButtons) {
    button.disabled = false;
    button.addEventListener('click', () => changeAction(button.dataset.action));
  }
  $('#fault').addEventListener('change', (event) => { viewer.setFault(event.target.value); changed(); });
  $('#skeleton').addEventListener('change', (event) => { viewer.setSkeleton(event.target.checked); changed(); });
  $('#play').addEventListener('click', togglePlaying);
  $('#prev').addEventListener('click', () => step(-1));
  $('#next').addEventListener('click', () => step(1));
  $('#loop').addEventListener('click', () => { viewer.setLoop(!viewer.getState().loop); changed(); });
  $('#scrub').addEventListener('input', (event) => {
    viewer.seekFrame(Number(event.target.value));
    changed();
  });
  $('#stage').addEventListener('keydown', (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.code === 'Space') { event.preventDefault(); togglePlaying(); }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      step(event.key === 'ArrowLeft' ? -1 : 1);
    }
  });
  $('#reset').addEventListener('click', () => {
    importRequest++;
    imported = undefined;
    viewer.reset();
    if (currentAccent) viewer.setAccent(currentAccent);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) viewer.setPlaying(false);
    update(viewer.getState());
    notice('已恢复内置角色与默认动作设置。');
    changed();
  });
  $('#import-file').addEventListener('click', () => $('#file-input').click());
  $('#file-input').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    const request = ++importRequest;
    try {
      const data = JSON.parse(await file.text());
      if (request !== importRequest) return;
      viewer.loadTrace(data);
      imported = {name: file.name, trace: data};
      update(viewer.getState());
      notice('已载入「' + file.name + '」。选择内置动作可返回合成夹具。');
      changed();
    } catch (error) {
      if (request === importRequest) notice('轨迹导入失败。' + errorText(error), true);
    }
  });
  $('#export-file').addEventListener('click', () => {
    try {
      const trace = viewer.exportTrace();
      const json = JSON.stringify(trace, null, 2);
      const blob = new Blob([json], {type: 'application/json'});
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      const action = String(viewer.getState().action || 'clip').replace(/[^a-z0-9_-]/gi, '_').slice(0, 48);
      link.download = 'luis-motion-' + (action || 'clip') + '.json';
      link.href = url;
      try {
        document.body.append(link);
        link.click();
        notice('已发起骨骼轨迹 JSON 下载，共 ' + viewer.getState().frameCount + ' 帧。');
      } finally {
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
      }
    } catch (error) {
      notice('骨骼导出失败。' + errorText(error), true);
    }
  });
  window.addEventListener('pagehide', saveNow);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveNow(); });
}

async function start() {
  try {
    const {createViewer} = await import('./viewer.js');
    viewer = createViewer($('#character-canvas'), {onChange: update});
    bindControls();
    restore();
    update(viewer.getState());
  } catch (error) {
    const label = '3D 预览初始化失败。' + errorText(error);
    $('#canvas-error').textContent = label;
    $('#canvas-error').hidden = false;
    storageStatus('预览未就绪', true);
    notice(label, true);
    for (const button of [...controls.map($), ...actionButtons, $('#fault')]) button.disabled = true;
  }
  try {
    const {mountCompanion} = await import('./companion.js');
    mountCompanion($('#companion-panel'), {
      playAction: changeAction,
      setAccent: (hex) => {
        currentAccent = hex;
        viewer?.setAccent?.(hex);
      }
    });
  } catch (error) {
    $('#companion-panel').textContent = '角色试用加载失败。' + errorText(error);
  }
}
start();
