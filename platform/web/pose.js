// The diagnostic figure uses metres in avatar-local coordinates. Positive X is character-left.
export const FPS = 30;
export const CLIPS = { idle: 121, nod: 85, wave: 109 };
export const FAULTS = new Set(['none', 'stretch', 'detach', 'jitter']);
export const add = (a, b) => a.map((v, i) => v + b[i]);
export const sub = (a, b) => a.map((v, i) => v - b[i]);
export const mul = (v, n) => v.map(x => x * n);
export const dot = (a, b) => a.reduce((n, x, i) => n + x * b[i], 0);
export const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
export const length = v => Math.hypot(...v);
export const norm = v => length(v) > 1e-9 ? mul(v, 1 / length(v)) : [0, 1, 0];
const ID = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
export const transform = (cols, v) => [0, 1, 2].map(i => cols[0][i]*v[0] + cols[1][i]*v[1] + cols[2][i]*v[2]);
const compose = (a, b) => b.map(col => transform(a, col));

function rotation(x, z) {
  const a = Math.cos(x), b = Math.sin(x), c = Math.cos(z), d = Math.sin(z);
  return [[c, d, 0], [-d*a, c*a, b], [d*b, -c*b, a]];
}

const rig = [
  ['spine', null, [0, .215, 0]],
  ['chest', 'spine', [0, .242, 0]],
  ['neck', 'chest', [0, .077, 0]],
  ['head', 'neck', [0, .202, 0]],
];
for (const [side, sign] of [['left', 1], ['right', -1]]) {
  rig.push(
    [side+'Clavicle', 'chest', [sign*.168, -.012, 0]],
    [side+'UpperArm', side+'Clavicle', [sign*.045, -.208, .012]],
    [side+'LowerArm', side+'UpperArm', [sign*.011, -.182, .045]],
    [side+'Hand', side+'LowerArm', [sign*.007, -.088, .012]],
  );
}
const definitions = new Map(rig.map(([id, parent, vector]) => [id, {id, parent, vector}]));
export const BONES = rig.map(([id, parent, vector]) => ({id, parent, rest_length: length(vector)}));
const JOINTS = ['left','right'].map(side => ({
  id: side+'Elbow', parent:side+'UpperArm', child:side+'LowerArm', angle_deg:[0,160],
}));

export function demoFrame(action, fault, frame) {
  const u = frame / (CLIPS[action] - 1);
  const p = 2 * Math.PI * u, breath = Math.sin(p), lift = (1 - Math.cos(p)) / 2;
  const nod = action === 'nod' ? (.5 - .5*Math.cos(2*p)) * lift : 0;
  const wave = action === 'wave' ? lift : 0;
  const faults = lift * lift;
  const bones = {}, transforms = new Map();
  for (const [id, parent, vector] of rig) {
    let pitch = 0, roll = 0, scale = 1;
    if (id === 'chest') pitch = .025*breath;
    if (id === 'neck') pitch = .13*nod;
    if (id === 'head') pitch = .23*nod;
    if (id === 'rightUpperArm') roll = -.025*breath;
    if (id === 'leftUpperArm') roll = .025*breath + .90*wave;
    if (id === 'leftLowerArm') {
      roll = (1.55 + .20*Math.sin(4*p))*wave;
      if (fault === 'stretch') scale += .58*faults;
      if (fault === 'jitter') roll += .56*faults*Math.sin(frame*2.28);
    }
    if (id === 'leftHand') roll = .22*Math.sin(5*p)*wave;
    const ancestor = transforms.get(parent);
    let translation = [0, -.002 + .002*breath, 0];
    if (ancestor) {
      // Child bind translation and parent's terminal marker are independently transformed.
      // A detached joint changes the child's anchor without modifying the parent's endpoint.
      let bind = mul(definitions.get(parent).vector, ancestor.scale);
      if (id === 'leftLowerArm' && fault === 'detach') bind = add(bind, [.091*faults, .012*faults, 0]);
      translation = add(ancestor.translation, transform(ancestor.basis, bind));
    }
    const basis = compose(ancestor ? ancestor.basis : ID, rotation(pitch, roll));
    transforms.set(id, {translation, basis, scale});
    const marker = local => add(translation, transform(basis, local));
    bones[id] = {head:marker([0,0,0]), tail:marker(mul(vector, scale))};
  }
  return {t:frame/FPS, bones};
}

export function createDemoTrace(action = 'idle', fault = 'none') {
  if (!Object.hasOwn(CLIPS, action) || !FAULTS.has(fault)) throw Error('动作或故障类型无效。');
  return {
    schema:'luis.motion-trace.v1', units:'m', space:'avatar_local',
    anchors:'independent_segment_markers', connection_default:'coincident',
    source:'Luis diagnostic mannequin. Synthetic FK; each bone origin and authored terminal marker are transformed by that segment. No sensor or skinned-mesh measurement.',
    action, fault, fps:FPS, bones:BONES.map(b => ({...b})), joints:JOINTS.map(j => ({...j})),
    limits:{length_rel:.05, gap_m:.01, angular_speed_deg_s:720, endpoint_speed_m_s:6, max_frame_dt_s:.08},
    frames:Array.from({length:CLIPS[action]}, (_, i) => demoFrame(action, fault, i)),
  };
}

export function validateTrace(trace) {
  const fail = message => { throw Error(message); };
  if (!trace || trace.schema !== 'luis.motion-trace.v1' || trace.units !== 'm' || trace.space !== 'avatar_local') {
    fail('需要 luis.motion-trace.v1 JSON，坐标为 avatar_local，单位 m。');
  }
  if (!Number.isFinite(trace.fps) || trace.fps <= 0 || trace.fps > 240) fail('fps 必须在 0 到 240 之间。');
  if (!Array.isArray(trace.bones) || !trace.bones.length || trace.bones.length > 256) fail('骨段数量应在 1 到 256 之间。');
  const ids = new Map();
  for (const b of trace.bones) {
    if (!b || typeof b.id !== 'string' || !b.id.trim() || ids.has(b.id) || !Number.isFinite(b.rest_length) || b.rest_length <= 0) fail('骨段 ID 或静止长度无效。');
    ids.set(b.id,b);
  }
  for (const b of ids.values()) {
    let current = b;
    const seen = new Set();
    while (current.parent !== null) {
      if (seen.has(current.id) || !ids.has(current.parent)) fail('骨架存在循环或缺失父骨。');
      seen.add(current.id);
      current = ids.get(current.parent);
    }
  }
  if (!Array.isArray(trace.frames) || !trace.frames.length || trace.frames.length > 30000) fail('轨迹帧数应在 1 到 30000 之间。');
  let previous = -Infinity;
  const point = v => Array.isArray(v) && v.length === 3 && v.every(Number.isFinite);
  for (const frame of trace.frames) {
    if (!frame || !Number.isFinite(frame.t) || frame.t < 0 || frame.t <= previous || !frame.bones) fail('帧时间必须为递增的非负秒数。');
    previous = frame.t;
    for (const id of ids.keys()) {
      const b = frame.bones[id];
      if (!b || !point(b.head) || !point(b.tail)) fail('缺少骨段端点或端点不是三维坐标：'+id);
    }
  }
  return trace;
}
