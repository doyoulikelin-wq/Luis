// Procedural surface geometry and orthographic camera. All meshes and materials are first-party.
import {add, sub, mul, dot, cross, length, norm, transform, BONES} from './pose.js';

const ID = [[1,0,0],[0,1,0],[0,0,1]];
const front = norm([.105,.038,1]);
const right = norm(cross([0,1,0], front));
const up = cross(front, right);
const ivory = '#ece0c5', skin = '#cd9e78', hair = '#463f38', dark = '#333d37';
const gold = '#b29b6a';

function axes(yaxis, hint = [1,0,0]) {
  const y = norm(yaxis);
  if (Math.abs(dot(y,hint)) > .97) hint = [0,0,1];
  const z = norm(cross(hint,y));
  return [cross(y,z), y, z];
}

function ringMesh(profile, sectors = 36) {
  const vertices = [], normals = [], indices = [];
  for (let i=0; i<profile.length; i++) {
    const [height, radius, depth, shift=0] = profile[i];
    const prev = profile[Math.max(0,i-1)], next = profile[Math.min(profile.length-1,i+1)];
    for (let j=0; j<=sectors; j++) {
      const a = 2*Math.PI*j/sectors, x = Math.cos(a), z = Math.sin(a);
      vertices.push(x*radius, height, z*depth+shift);
      const tangent = [-Math.sin(a)*Math.max(.002,radius),0,Math.cos(a)*Math.max(.002,depth)];
      const slope = [(next[1]-prev[1])*x,next[0]-prev[0],
        (next[2]-prev[2])*z+(next[3]||0)-(prev[3]||0)];
      normals.push(...norm(cross(slope,tangent)));
      if (i<profile.length-1 && j<sectors) {
        const k=i*(sectors+1)+j;
        indices.push(k,k+sectors+1,k+1,k+1,k+sectors+1,k+sectors+2);
      }
    }
  }
  return {vertices:new Float32Array(vertices), normals:new Float32Array(normals), indices:new Uint16Array(indices)};
}
const sphere = ringMesh(Array.from({length:17},(_,i) => {
  const t=-Math.PI/2+Math.PI*i/16;
  return [Math.sin(t),Math.cos(t),Math.cos(t)];
}));
const coat = ringMesh([[-1,.62,.72],[-.99,.8,.78],[-.91,.83,.81],[-.60,.83,.83],[-.22,.87,.93],[.2,.96,1],[.54,1,.98],[.76,.98,.90],[.86,.81,.79],[.98,.42,.60],[1,.31,.43]]);
const face = ringMesh([[-1,.12,.22,.12],[-.92,.46,.59,.1],[-.75,.69,.76,.08],[-.42,.90,.92,.04],[-.12,.99,.99,0],[.30,1,1,0],[.66,.93,.93,-.02],[.89,.69,.69,-.02],[1,.1,.16,0]]);
const cap = ringMesh([[.26,.98,1.0,0],[.30,1.035,1.04,0],[.66,.965,.97,-.02],[.89,.73,.74,-.02],[1.015,.19,.23,0],[1.023,.013,.016,0]]);
const disc = ringMesh([[-1,.91,.91],[-.85,1,1],[.73,1,1],[1,.92,.92],[1,.02,.02]]);
const meshes = {sphere,coat,face,cap,disc};

function dim(hex, factor) {
  const c=[1,3,5].map(i=>Math.min(255,Math.round(parseInt(hex.slice(i,i+2),16)*factor)));
  return '#'+c.map(n=>n.toString(16).padStart(2,'0')).join('');
}
function buildFigure(bones, rig, accent, skeleton, mannequin) {
  const bodies=[], marks=[];
  function object(mesh, origin, scale, color, basis=ID, bucket=bodies) {
    bucket.push({mesh,origin,scale,color,basis});
  }
  function stick(a,b,radius,color,bucket=bodies,depth=radius) {
    const diff=sub(b,a), h=length(diff);
    if (h>1e-8) object('sphere',mul(add(a,b),.5),[radius,h*.55,depth],color,axes(diff),bucket);
  }
  function ball(p,r,color,bucket=bodies) { object('sphere',p,[r,r,r],color,ID,bucket); }
  if (mannequin) {
    const base=bones.spine.head, stern=bones.chest.tail, trunk=axes(sub(stern,base));
    const local=(origin,basis,v)=>add(origin,transform(basis,v));
    const body=(x,y,z)=>local(base,trunk,[x,y,z]);
    // A low studio mount identifies the upper-body asset.
    object('disc',body(0,-.102,-.015),[.13,.016,.076],dim(accent,.66),trunk);
    object('disc',body(0,-.063,-.015),[.062,.029,.048],gold,trunk);
    object('coat',body(0,.206,-.006),[.197,.24,.107],accent,trunk);
    object('disc',body(0,.442,-.002),[.067,.019,.055],dim(accent,.78),trunk);
    // Placket, two matte fasteners, and a fabric strip.
    stick(body(0,.404,.065),body(0,.264,.108),.003,dim(accent,.76));
    for (const [y,z] of [[.36,.089],[.316,.10]]) ball(body(.002,y,z),.0043,gold);
    object('disc',body(.096,.315,.088),[.026,.009,.007],ivory,trunk);
    const neck=bones.neck;
    stick(neck.head,neck.tail,.041,skin);
    const h=bones.head, hbase=axes(sub(h.tail,h.head)), headHeight=length(sub(h.tail,h.head));
    const hp=(x,y,z)=>local(h.head,hbase,[x,y,z]);
    object('face',hp(0,.48*headHeight,.004),[.083,.59*headHeight,.078],skin,hbase);
    object('cap',hp(0,.48*headHeight,.004),[.083,.59*headHeight,.078],hair,hbase);
    // Swept forelock, brows, nose, cheeks, and restrained face details.
    object('sphere',hp(-.031,.139,.074),[.033,.009,.009],hair,hbase);
    for (const sign of [-1,1]) {
      object('sphere',hp(sign*.082,.095,.003),[.015,.024,.014],skin,hbase);
      object('sphere',hp(sign*.033,.114,.075),[.008,.009,.004],dark,hbase);
      object('sphere',hp(sign*.033,.132,.072),[.018,.003,.005],hair,hbase);
    }
    object('sphere',hp(0,.093,.08),[.011,.018,.013],skin,hbase);
    stick(hp(-.017,.058,.080),hp(.017,.06,.080),.0026,'#86604d');
    for (const side of ['left','right']) {
      const upper=bones[side+'UpperArm'], lower=bones[side+'LowerArm'], hand=bones[side+'Hand'];
      stick(body((side==='left'?1:-1)*.05,.409,-.003),upper.head,.047,accent);
      ball(upper.head,.055,dim(accent,.88));
      stick(upper.head,upper.tail,.044,skin);
      stick(upper.head,add(upper.head,mul(sub(upper.tail,upper.head),.68)),.056,accent,bodies,.053);
      ball(upper.tail,.035,gold);
      stick(lower.head,lower.tail,.034,skin,bodies,.031);
      ball(lower.tail,.022,gold);
      const handAxis=axes(sub(hand.tail,hand.head));
      const palmCenter=add(hand.head,mul(sub(hand.tail,hand.head),.49));
      object('sphere',palmCenter,[.027,.044,.017],skin,handAxis);
      const sign=side==='left'?1:-1;
      for(let j=0;j<4;j++) {
        const near=local(hand.head,handAxis,[(j-1.5)*.011,.059,.001]);
        const far=local(hand.head,handAxis,[(j-1.5)*.012,.091-.004*Math.abs(j-1),.004]);
        stick(near,far,.006,skin);
      }
      stick(local(hand.head,handAxis,[sign*.019,.028,.003]),
        local(hand.head,handAxis,[sign*.038,.060,.008]),.009,skin);
    }
  } else {
    for (const b of rig) {
      const {head,tail}=bones[b.id];
      stick(head,tail,Math.max(.004,Math.min(.025,b.rest_length*.11)),accent);
      ball(head,Math.max(.005,Math.min(.028,b.rest_length*.13)),gold);
    }
  }
  if (skeleton) {
    for (const b of rig) {
      const seg=bones[b.id];
      const color = b.id.startsWith('left') ? '#bff4c9' : '#f6ce77';
      stick(seg.head,seg.tail,.0033,color,marks);
      ball(seg.head,.0052,'#3d594a',marks);
      ball(seg.tail,.0046,color,marks);
    }
  }
  return [bodies,marks];
}

function colorFloats(hex) { return [1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255); }
function makeGL(gl) {
  const vs = 'attribute vec3 p,n; uniform mat3 basis,cam; uniform vec3 origin,scale,center; uniform vec2 extent; varying vec3 normal; void main(){ vec3 eye=cam*(origin+basis*(p*scale)-center); gl_Position=vec4(eye.x/extent.x, eye.y/extent.y,-eye.z*.28,1.); normal=basis*(n/scale); }';
  const fs = 'precision mediump float; varying vec3 normal; uniform vec3 color; void main(){vec3 n=normalize(normal);vec3 l=normalize(vec3(-.45,.77,.60));float light=.69+.29*max(dot(n,l),0.)+.07*max(dot(n,vec3(.8,.1,-.5)),0.);float hi=.085*pow(max(dot(n,normalize(l+vec3(.12,.05,1.))),0.),32.);gl_FragColor=vec4(color*light+hi,1.);}';
  const shaders=[gl.VERTEX_SHADER,gl.FRAGMENT_SHADER].map((type,i)=>{
    const s=gl.createShader(type);gl.shaderSource(s,[vs,fs][i]);gl.compileShader(s);
    if(!gl.getShaderParameter(s,gl.COMPILE_STATUS)) throw Error(gl.getShaderInfoLog(s));
    return s;
  });
  const prog=gl.createProgram();shaders.forEach(s=>gl.attachShader(prog,s));gl.linkProgram(prog);
  if(!gl.getProgramParameter(prog,gl.LINK_STATUS)) throw Error(gl.getProgramInfoLog(prog));
  gl.useProgram(prog);shaders.forEach(s=>gl.deleteShader(s));
  const locations=Object.fromEntries(['basis','cam','origin','scale','center','extent','color'].map(k=>[k,gl.getUniformLocation(prog,k)]));
  const locP=gl.getAttribLocation(prog,'p'),locN=gl.getAttribLocation(prog,'n');
  gl.enableVertexAttribArray(locP);gl.enableVertexAttribArray(locN);
  const buffer=(type,data)=>{const b=gl.createBuffer();gl.bindBuffer(type,b);gl.bufferData(type,data,gl.STATIC_DRAW);return b;};
  const gpu={};
  for(const [name,m] of Object.entries(meshes))gpu[name]={
    p:buffer(gl.ARRAY_BUFFER,m.vertices),n:buffer(gl.ARRAY_BUFFER,m.normals),
    e:buffer(gl.ELEMENT_ARRAY_BUFFER,m.indices),count:m.indices.length};
  const u=locations;
  gl.uniformMatrix3fv(u.cam,false,[right[0],up[0],front[0],right[1],up[1],front[1],right[2],up[2],front[2]]);
  gl.clearColor(0,0,0,0);
  function layer(objects) {
    let prev;
    for(const o of objects) {
      const m=gpu[o.mesh];
      if(m!==prev) {
        gl.bindBuffer(gl.ARRAY_BUFFER,m.p);gl.vertexAttribPointer(locP,3,gl.FLOAT,false,0,0);
        gl.bindBuffer(gl.ARRAY_BUFFER,m.n);gl.vertexAttribPointer(locN,3,gl.FLOAT,false,0,0);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER,m.e);prev=m;
      }
      gl.uniform3fv(u.origin,o.origin);gl.uniform3fv(u.scale,o.scale);gl.uniform3fv(u.color,colorFloats(o.color));
      gl.uniformMatrix3fv(u.basis,false,o.basis.flat());gl.drawElements(gl.TRIANGLES,m.count,gl.UNSIGNED_SHORT,0);
    }
  }
  return {draw(layers,w,h,camera) {
    gl.viewport(0,0,w,h);gl.clear(gl.COLOR_BUFFER_BIT|gl.DEPTH_BUFFER_BIT);gl.enable(gl.DEPTH_TEST);
    gl.uniform3fv(u.center,camera.center);gl.uniform2fv(u.extent,camera.extent);
    layer(layers[0]);
    if(layers[1].length){gl.clear(gl.DEPTH_BUFFER_BIT);layer(layers[1]);}
  },destroy(){Object.values(gpu).forEach(m=>[m.p,m.n,m.e].forEach(x=>gl.deleteBuffer(x)));gl.deleteProgram(prog);}};
}

function make2D(ctx) {
  // Orthographic ellipsoid silhouettes retain the actual 3D pose on machines without WebGL.
  return {draw(layers,w,h,camera) {
    ctx.clearRect(0,0,w,h);
    const scale=w/(2*camera.extent[0]);
    for(const layer of layers) {
      for(const o of [...layer].sort((a,b)=>dot(a.origin,front)-dot(b.origin,front))) {
        const p=sub(o.origin,camera.center);
        const x=w/2+dot(p,right)*scale,y=h/2-dot(p,up)*scale;
        const a=o.basis.map((v,i)=>dot(v,right)*o.scale[i]*scale);
        const b=o.basis.map((v,i)=>-dot(v,up)*o.scale[i]*scale);
        const xx=dot(a,a),yy=dot(b,b),xy=dot(a,b);
        const d=Math.hypot(xx-yy,2*xy);
        const rx=Math.max(.18,Math.sqrt(Math.max(0,(xx+yy+d)/2))),ry=Math.max(.18,Math.sqrt(Math.max(0,(xx+yy-d)/2)));
        ctx.save();ctx.translate(x,y);ctx.rotate(.5*Math.atan2(2*xy,xx-yy));ctx.scale(rx,ry);
        const grad=ctx.createRadialGradient(-.32,-.36,.12,0,0,1.13);
        grad.addColorStop(0,dim(o.color,1.13));grad.addColorStop(.69,o.color);grad.addColorStop(1,dim(o.color,.71));
        ctx.fillStyle=grad;ctx.beginPath();ctx.arc(0,0,1,0,2*Math.PI);ctx.fill();ctx.restore();
      }
    }
  },destroy(){}};
}

export function createRenderer(canvas) {
  const gl=canvas.getContext('webgl',{alpha:true,antialias:true,premultipliedAlpha:true});
  const renderer=gl ? makeGL(gl) : make2D(canvas.getContext('2d'));
  let focus=[0,.318,0],minX=.51,minY=.493,mannequin=true;
  return {
    fit(trace) {
      focus=[0,.318,0];minX=.51;minY=.493;
      mannequin=!trace || trace.bones.length===BONES.length && BONES.every(ref=>
        trace.bones.some(b=>b.id===ref.id && b.parent===ref.parent && Math.abs(b.rest_length-ref.rest_length)<.0001));
      if(mannequin)return;
      let xmin=Infinity,xmax=-Infinity,ymin=Infinity,ymax=-Infinity,zmin=Infinity,zmax=-Infinity;
      for(const frame of trace.frames) for(const b of Object.values(frame.bones)) for(const p of [b.head,b.tail]) {
        const x=dot(p,right),y=dot(p,up),z=dot(p,front);
        xmin=Math.min(xmin,x);xmax=Math.max(xmax,x);ymin=Math.min(ymin,y);ymax=Math.max(ymax,y);
        zmin=Math.min(zmin,z);zmax=Math.max(zmax,z);
      }
      focus=add(add(mul(right,(xmin+xmax)/2),mul(up,(ymin+ymax)/2)),mul(front,(zmin+zmax)/2));
      minX=Math.max(.09,(xmax-xmin)*.56);minY=Math.max(.09,(ymax-ymin)*.56);
    },
    draw(frame,rig,accent,skeleton) {
      const rect=canvas.getBoundingClientRect(),dpr=Math.min(globalThis.devicePixelRatio||1,2);
      const w=Math.max(1,Math.round(rect.width*dpr)),h=Math.max(1,Math.round(rect.height*dpr));
      if(canvas.width!==w || canvas.height!==h){canvas.width=w;canvas.height=h;}
      const ey=Math.max(minY,minX*h/w);
      renderer.draw(buildFigure(frame.bones,rig,accent,skeleton,mannequin),w,h,{center:focus,extent:[ey*w/h,ey]});
    },
    destroy:renderer.destroy,
  };
}
