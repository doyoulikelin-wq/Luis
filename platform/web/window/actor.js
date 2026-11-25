// Registration is in the approved illustration's pixel coordinates. The file is a
// lossless crop of that illustration; all deformation happens at presentation.
const artURL = new URL('./assets/blue-companion.webp', import.meta.url);
const frame = {left: 249, top: 117, width: 570, height: 475};
const crop = {left: 240, top: 128};
const headContour = new Path2D('M280 429 Q286 371 302 271 Q310 195 382 165 Q418 141 467 140 Q531 135 600 161 Q711 174 736 248 Q768 303 773 394 L787 415 Q788 435 761 458 Q752 507 736 539 L338 548 Q320 535 318 512 L300 463 Q285 452 280 438 Z');
const fingers = new Path2D(
  'M433 540 Q434 524 457 519 Q472 514 486 523 Q495 528 499 541 Q498 552 493 557 Q490 561 485 558 Q480 567 469 563 Q462 568 453 559 Q448 564 441 559 Q434 554 433 545 Z ' +
  'M587 538 Q589 521 603 516 Q620 509 634 519 Q648 524 651 538 Q652 548 644 556 Q640 559 635 555 Q627 565 618 558 Q609 565 602 555 Q595 561 590 552 Q587 547 587 538 Z'
);
const eyes = [
  {
    // Keep the hair fringe and eyebrow in the underlying face layer.
    shape: new Path2D('M418 452 Q424 437 437 426 L443 420 Q460 415 475 416 Q489 416 497 426 L512 444 Q511 462 504 478 Q500 487 478 489 Q447 491 435 475 Q423 470 418 456 Z'),
    iris: [477,456,27,32],
    top: 418, bottom: 488,
    lash: new Path2D('M427 453 Q440 465 455 460 Q477 449 500 458 Q482 454 461 464 Q444 474 432 462 Q428 458 427 453 Z'),
  },
  {
    shape: new Path2D('M568 442 Q566 428 577 415 Q588 404 605 402 Q618 401 626 401 L636 407 L651 417 L656 425 L659 434 Q644 454 640 463 Q634 475 611 477 Q583 480 576 465 Q570 459 568 442 Z'),
    iris: [603,445,28,33],
    top: 406, bottom: 475,
    lash: new Path2D('M572 447 Q590 436 607 440 Q634 448 648 431 Q646 441 636 448 Q626 453 612 448 Q593 440 572 448 Z'),
  },
];

function surface(width, height) {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}
function registeredContext(canvas) {
  const ctx = canvas.getContext('2d');
  ctx.translate(-frame.left, -frame.top);
  return ctx;
}
function sampleInside(ctx, path, image) {
  ctx.save();
  ctx.clip(path);
  ctx.drawImage(image, crop.left, crop.top);
  ctx.restore();
}

// Build the still, independent eye mattes, and closed-lash drawings once.
// All three sheets share the same registration, including phone rotations.
function makeSheets(image) {
  const layers = Array.from({length: 3}, () => surface(frame.width, frame.height));
  const [base, eye, closed] = layers.map(registeredContext);
  base.fillStyle = '#000';
  base.fillRect(frame.left, frame.top, frame.width, frame.height);
  sampleInside(base, headContour, image);

  const sill = base.createLinearGradient(0, 545, 0, 592);
  sill.addColorStop(0, '#4b484e');
  sill.addColorStop(0.06, '#2a282e');
  sill.addColorStop(0.43, '#1a191e');
  sill.addColorStop(1, '#101014');
  base.fillStyle = sill;
  base.beginPath();
  base.moveTo(248, 548); base.lineTo(820, 539); base.lineTo(820, 594); base.lineTo(248, 594);
  base.fill();
  base.beginPath();
  base.moveTo(248, 548); base.lineTo(820, 539);
  base.strokeStyle = '#827e83'; base.lineWidth = 1.2; base.stroke();
  sampleInside(base, fingers, image);

  // Eyelids reveal skin where the iris used to be. Reconstruct that patch from
  // nearby unoccluded skin. Preserve overlapping blue hair at the eye corners.
  const skinSamples = [[451,418],[470,409],[480,411],[506,458],[510,474],
    [458,489],[475,488],[494,484],[541,465],[571,423],[594,402],
    [603,398],[574,461],[593,478],[614,478],[636,469],[640,463]];
  const under = base.getImageData(0,0,frame.width,frame.height);
  const swatches = skinSamples.map(([x,y]) => {
    const i=4*((y-frame.top)*frame.width+x-frame.left);
    return {x,y,r:under.data[i],g:under.data[i+1],b:under.data[i+2]};
  }).filter(({r,g,b}) => r>202 && g>147 && r>b+8);
  for (const item of eyes) {
    sampleInside(eye, item.shape, image);
    closed.fillStyle = '#361c27';
    closed.fill(item.lash);
  }
  const overlay = eye.getImageData(0,0,frame.width,frame.height);
  for (let y=397; y<492; y++) {
    for (let x=415; x<662; x++) {
      const i=4*((y-frame.top)*frame.width+x-frame.left);
      const alpha=overlay.data[i+3]/255;
      if (!alpha) continue;
      const [cx,cy,rx,ry]=eyes[x<540?0:1].iris;
      const insideIris=Math.abs((x-cx)/rx)<1 && Math.abs((y-cy)/ry)<1;
      const atHair = x<540 ? x<442 || x>490 : x<575 || x>625;
      if (atHair && !insideIris && under.data[i+2]>under.data[i]+6) {
        overlay.data[i+3]=0;
        continue;
      }
      let sum=0,r=0,g=0,b=0;
      for (const swatch of swatches) {
        const dist=(x-swatch.x)**2+(y-swatch.y)**2+20;
        const weight=1/(dist*dist);
        sum+=weight; r+=weight*swatch.r; g+=weight*swatch.g; b+=weight*swatch.b;
      }
      under.data[i]=under.data[i]*(1-alpha)+alpha*r/sum;
      under.data[i+1]=under.data[i+1]*(1-alpha)+alpha*g/sum;
      under.data[i+2]=under.data[i+2]*(1-alpha)+alpha*b/sum;
    }
  }
  base.putImageData(under,0,0);
  eye.putImageData(overlay,0,0);
  return layers;
}

const vertexSource = `
attribute vec2 corner;
varying vec2 unit;
void main() {
  unit = vec2(0.5 + 0.5*corner.x, 0.5 - 0.5*corner.y);
  gl_Position = vec4(corner, 0., 1.);
}`;
const fragmentSource = `
precision highp float;
varying vec2 unit;
uniform sampler2D atlas;
uniform vec2 viewSize;
uniform vec2 gaze;
uniform vec2 lean;
uniform vec4 expression; // blink, smile, hold, tap
uniform vec2 fingers;
uniform float leanIn;
const vec2 origin = vec2(249.,117.);
const vec2 design = vec2(570.,475.);

vec4 layer(vec2 p, float row) {
  vec2 uv = (p-origin)/design;
  uv = clamp(uv, 0.5/design, 1.-0.5/design);
  return texture2D(atlas, vec2(uv.x, (row+uv.y)/3.));
}

vec2 moveIris(vec2 point, vec2 center) {
  // The eyelash and corners remain stationary. The visible sclera compresses
  // slightly to one side as the intact coloured iris follows the target.
  vec2 local = abs((point-center)/vec2(38.,32.));
  vec2 weight = 1.-smoothstep(vec2(0.32,0.28),vec2(1.0,0.90),local);
  return point - gaze*vec2(8.5,4.4)*weight.x*weight.y;
}

void main() {
  float fit = min(viewSize.x/design.x, viewSize.y/design.y);
  vec2 p = origin + design*.5 + (unit-.5)*viewSize/fit;
  if (any(lessThan(p,origin)) || any(greaterThan(p,origin+design))) {
    gl_FragColor = vec4(0.,0.,0.,1.); return;
  }

  // Anchor the jaw to the sill; the fingertips below it keep their contacts.
  float free = 1.-smoothstep(496.,533.,p.y);
  vec2 pivot = vec2(541.,524.);
  float angle = lean.x*.040*free;
  float c = cos(angle), s = sin(angle);
  vec2 v = p - pivot - free*vec2(lean.x*6.5, lean.y*6.0-expression.z*1.6-expression.w*1.1);
  p = pivot + vec2(c*v.x+s*v.y, -s*v.x+c*v.y)/(1.+.038*leanIn*free);
  vec2 leftHand = (p-vec2(465.,535.))/vec2(31.,18.);
  vec2 rightHand = (p-vec2(617.,533.))/vec2(33.,19.);
  float lift = fingers.x*(1.-smoothstep(.12,1.,length(leftHand)))
             + fingers.y*(1.-smoothstep(.12,1.,length(rightHand)));
  p.y += lift*2.6;

  float mouth = 1.-smoothstep(.35,1.,length((p-vec2(544.,501.))/vec2(24.,12.)));
  p.y += expression.y*mouth*(abs(p.x-544.)*.18-1.3);
  vec4 face = layer(p,0.);
  if (p.x>420. && p.x<660. && p.y>399. && p.y<491.) {
    bool left = p.x<540.;
    vec2 center = left ? vec2(477.,457.) : vec2(603.,445.);
    float amount = clamp(expression.x,0.,1.);
    float crease = left ? 461. : 447.;
    vec2 q = p;
    q.y = crease+(p.y-crease)/max(.06,(1.-amount)*(1.+.065*expression.z));
    vec4 iris = layer(moveIris(q,center),1.)*(1.-smoothstep(.73,.99,amount));
    vec4 lashes = layer(p,2.)*smoothstep(.42,.95,amount);
    face = iris + face*(1.-iris.a);
    face = lashes + face*(1.-lashes.a);
  }
  gl_FragColor = vec4(face.rgb,1.);
}`;

function programFor(gl) {
  const shaders = [];
  const program = gl.createProgram();
  try {
    for (const [type, code] of [[gl.VERTEX_SHADER,vertexSource],[gl.FRAGMENT_SHADER,fragmentSource]]) {
      const shader = gl.createShader(type);
      shaders.push(shader);
      gl.shaderSource(shader,code); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program,shader);
    }
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  } catch (error) {
    gl.deleteProgram(program);
    throw error;
  } finally {
    for (const shader of shaders) gl.deleteShader(shader);
  }
  return program;
}

function gpuRenderer(gl, sheets) {
  const program = programFor(gl);
  gl.useProgram(program);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  const corner = gl.getAttribLocation(program,'corner');
  gl.enableVertexAttribArray(corner); gl.vertexAttribPointer(corner,2,gl.FLOAT,false,0,0);
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D,texture);
  for (const axis of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T]) gl.texParameteri(gl.TEXTURE_2D,axis,gl.CLAMP_TO_EDGE);
  for (const filter of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER]) gl.texParameteri(gl.TEXTURE_2D,filter,gl.LINEAR);
  const atlas = surface(frame.width,frame.height*3);
  const ctx = atlas.getContext('2d');
  sheets.forEach((sheet,i) => ctx.drawImage(sheet,0,frame.height*i));
  gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);
  gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,atlas);
  gl.uniform1i(gl.getUniformLocation(program,'atlas'),0);
  const loc = Object.fromEntries(['viewSize','gaze','lean','expression','fingers','leanIn'].map(k=>[k,gl.getUniformLocation(program,k)]));
  return {
    draw(w,h,s) {
      gl.viewport(0,0,w,h);
      gl.uniform2f(loc.viewSize,w,h); gl.uniform2f(loc.gaze,s.eyeX,s.eyeY); gl.uniform2f(loc.lean,s.headX,s.headY);
      gl.uniform4f(loc.expression,s.blink,s.smile,s.press,s.tap); gl.uniform2f(loc.fingers,s.handL,s.handR);
      gl.uniform1f(loc.leanIn,s.leanIn);
      gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
    },
    dispose() { gl.deleteBuffer(buffer); gl.deleteTexture(texture); gl.deleteProgram(program); },
  };
}

// Canvas fallback retains gesture, gaze and blink for devices with WebGL disabled.
function flatRenderer(canvas, sheets) {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法启动角色画布');
  const [base, eyesOpen, eyesClosed] = sheets;
  const scene = surface(frame.width,frame.height);
  const sceneCtx = scene.getContext('2d');
  return {
    draw(w,h,s) {
      sceneCtx.drawImage(base,0,0);
      // Re-sample the palm around its fixed contact point with the sill.
      for (const [x,y,amount] of [[216,419,s.handL],[367,417,s.handR]]) {
        if (amount <= 0.001) continue;
        sceneCtx.save();
        sceneCtx.beginPath();
        sceneCtx.ellipse(x,y-2,29,15,0,0,2*Math.PI);
        sceneCtx.clip();
        sceneCtx.drawImage(base,x-32,y-20,64,40,x-32,y-20-2.8*amount,64,40+2.8*amount);
        sceneCtx.restore();
      }
      if (s.smile > 0.001) {
        const x=295,y=383;
        sceneCtx.save();
        sceneCtx.beginPath();
        sceneCtx.ellipse(x,y,22,10,0,0,2*Math.PI);
        sceneCtx.clip();
        sceneCtx.drawImage(base,x-23,y-12,46,24,x-23-2*s.smile,y-12,46+4*s.smile,24+s.smile);
        sceneCtx.restore();
      }
      for (const [x,y] of [[223,344],[355,330]]) {
        const height = 83*Math.max(.04,(1-s.blink)*(1+.065*s.press));
        sceneCtx.globalAlpha = 1-s.blink*s.blink;
        sceneCtx.drawImage(eyesOpen,x-54,y-62,108,83,x-54+s.eyeX*3.5,y-height*62/83+s.eyeY*1.8,108,height);
      }
      sceneCtx.globalAlpha = s.blink;
      sceneCtx.drawImage(eyesClosed,0,0);
      sceneCtx.globalAlpha = 1;
      const k = Math.min(w/frame.width,h/frame.height);
      ctx.setTransform(1,0,0,1,0,0);
      ctx.fillStyle='#000'; ctx.fillRect(0,0,w,h);
      ctx.setTransform(k,0,0,k,(w-frame.width*k)/2,(h-frame.height*k)/2);
      const shear = -.042*s.headX;
      const stretch = 1-.012*s.headY-.003*s.press+.035*s.leanIn;
      const zoom = 1+.025*s.leanIn;
      const jaw = 420;
      ctx.save();
      ctx.transform(zoom,0,shear,stretch,(1-zoom)*285-jaw*shear,jaw*(1-stretch));
      ctx.drawImage(scene,0,0,frame.width,374,0,0,frame.width,374);
      ctx.restore();

      // Reduce deformation gradually above the anchored fingertips. Each band
      // keeps its contacts with the next one even as the head changes direction.
      function band(y) {
        const t = Math.max(0, Math.min(1, (y-373)/37));
        const influence = 1-t*t*(3-2*t);
        const scale = 1+(zoom-1)*influence;
        return {
          x:(1-scale)*285+shear*(y-jaw)*influence,
          y:y+(stretch-1)*(y-jaw)*influence,
          width:frame.width*scale,
        };
      }
      for (let y=373; y<410; y+=3) {
        const end = Math.min(410,y+3);
        const startBand = band(y);
        const endBand = band(end);
        ctx.drawImage(scene,0,y,frame.width,end-y+.5,startBand.x,startBand.y,startBand.width,endBand.y-startBand.y+.5);
      }
      ctx.drawImage(scene,0,410,frame.width,65,0,410,frame.width,65);
    },
    dispose() {},
  };
}

export async function createActor(canvas) {
  const image = new Image();
  image.src = artURL.href;
  await image.decode();
  const sheets = makeSheets(image);
  const gl = canvas.getContext('webgl',{alpha:false,antialias:false,depth:false,stencil:false});
  let renderer = gl ? gpuRenderer(gl,sheets) : flatRenderer(canvas,sheets);
  let lost = false;
  function onLost(event) { event.preventDefault(); lost=true; }
  function onRestored() { renderer=gpuRenderer(gl,sheets); lost=false; }
  canvas.addEventListener('webglcontextlost',onLost);
  canvas.addEventListener('webglcontextrestored',onRestored);
  let width=0, height=0;
  const resize = () => {
    const rect=canvas.getBoundingClientRect();
    const dpr=Math.min(window.devicePixelRatio||1,2);
    width=Math.max(1,Math.round(rect.width*dpr)); height=Math.max(1,Math.round(rect.height*dpr));
    if(canvas.width!==width) canvas.width=width;
    if(canvas.height!==height) canvas.height=height;
  };
  const observer = new ResizeObserver(resize);
  observer.observe(canvas);
  resize();
  return {
    draw(s = {}) {
      if (lost) return;
      renderer.draw(width,height,{
        eyeX:s.eyeX||0,eyeY:s.eyeY||0,headX:s.headX||0,headY:s.headY||0,
        blink:s.blink||0,leanIn:s.leanIn||0,smile:s.smile||0,press:s.press||0,tap:s.tap||0,handL:s.handL||0,handR:s.handR||0,
      });
    },
    dispose() {
      observer.disconnect();
      canvas.removeEventListener('webglcontextlost',onLost);
      canvas.removeEventListener('webglcontextrestored',onRestored);
      if (!lost) renderer.dispose();
    },
  };
}
