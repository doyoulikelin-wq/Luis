import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {access, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {promisify} from 'node:util';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const sha = value => createHash('sha256').update(value).digest('hex');
const width = 256, height = 256;
const background = '#e7ebe1', accent = '#42645b';
const cols = 8, rows = 8, cells = cols * rows;
const web = new URL(process.env.LUIS_WEB_URL || 'http://127.0.0.1:8774/platform/web/');
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const ffprobe = process.env.FFPROBE || 'ffprobe';

async function capture(directory) {
  const {chromium} = require(process.env.LUIS_PLAYWRIGHT_MODULE || 'playwright');
  const args = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  const browser = await chromium.launch({headless: true, executablePath: process.env.LUIS_CHROME_PATH || undefined, args});
  try {
    const page = await browser.newPage({viewport: {width, height}, deviceScaleFactor: 1, serviceWorkers: 'block'});
    // The empty page imports the actual renderer and pose modules from the configured server.
    const entry = new URL('__playback_probe__.html', web).href;
    await page.route(entry, route => route.fulfill({contentType: 'text/html', body: '<!doctype html><meta charset="utf-8"><body style="margin:0"></body>'}));
    await page.goto(entry);
    const hashes = {};
    for (const file of ['pose.js', 'figure.js']) {
      const response = await page.request.get(new URL(file, entry).href);
      assert.equal(response.status(), 200, file);
      hashes[file] = sha(await response.body());
    }
    await page.exposeFunction('storeProbeFrame', async (index, data) => {
      await writeFile(join(directory, 'frame-' + String(index).padStart(3, '0') + '.png'), Buffer.from(data, 'base64'), {flag:'wx'});
    });
    const result = await page.evaluate(async ({width, height, background, accent}) => {
      const {createRenderer} = await import('./figure.js');
      const {createDemoTrace} = await import('./pose.js');
      const trace = createDemoTrace('wave', 'none');
      const canvas = document.createElement('canvas');
      canvas.width = width; canvas.height = height;
      canvas.style.width = width + 'px'; canvas.style.height = height + 'px';
      document.body.append(canvas);
      const renderer = createRenderer(canvas);
      const gl = canvas.getContext('webgl');
      if (!gl || gl.isContextLost()) throw new Error('WebGL is required for the source capture.');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const gpu = gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER);
      const matte = document.createElement('canvas');
      matte.width = width; matte.height = height;
      const ctx = matte.getContext('2d', {alpha: false, colorSpace: 'srgb'});
      renderer.fit(null);
      for (const [index, frame] of trace.frames.entries()) {
        renderer.draw(frame, trace.bones, accent, false);
        ctx.fillStyle = background; ctx.fillRect(0, 0, width, height);
        ctx.drawImage(canvas, 0, 0);
        await window.storeProbeFrame(index, matte.toDataURL('image/png').split(',')[1]);
      }
      renderer.destroy();
      return {frame_count: trace.frames.length, fps: trace.fps, start_s: trace.frames[0].t,
        last_sample_s: trace.frames.at(-1).t, webgl: gl.getParameter(gl.VERSION), renderer: gpu};
    }, {width, height, background, accent});
    return {...result, chrome: browser.version(), chromium_flags: args, served_file_sha256: hashes};
  } finally { await browser.close(); }
}

async function probe(directory) {
  const render = await capture(directory);
  const count = render.frame_count, fps = render.fps;
  assert.equal(count, 109);
  const cmds = [];
  async function run(program, argv) {
    cmds.push([program === ffmpeg ? 'ffmpeg' : 'ffprobe', ...argv]);
    return (await exec(program, argv, {cwd: directory, maxBuffer: 4 * 1024 * 1024})).stdout;
  }
  const input = ['-f','rawvideo','-pixel_format','rgba','-video_size',width+'x'+height,'-framerate',String(fps),'-i','source.rgba'];
  const frameLimit = ['-frames:v',String(count)];
  await run(ffmpeg, ['-v','error','-framerate',String(fps),'-start_number','0','-i','frame-%03d.png',...frameLimit,'-pix_fmt','rgba','-f','rawvideo','source.rgba']);
  await run(ffmpeg, ['-v','error',...input,...frameLimit,'-vf','scale=out_color_matrix=bt709:out_range=tv,format=yuv420p',
    '-c:v','libx264','-crf','18','-preset','medium','-threads','1','-g','60','-colorspace','bt709','-color_primaries','bt709','-color_trc','iec61966-2-1',
    '-color_range','tv','-an','-map_metadata','-1','-movflags','+faststart','wave.mp4']);
  await run(ffmpeg, ['-v','error',...input,'-vf','tile='+cols+'x'+rows+':nb_frames='+cells+':margin=0:padding=0:color=0x'+background.slice(1),
    '-c:v','png','-pix_fmt','rgba','-compression_level','9','-pred','mixed','-threads','1','-fps_mode','passthrough','-start_number','0','atlas-%02d.png']);
  const metadata = JSON.parse(await run(ffprobe, ['-v','error','-count_frames','-select_streams','v:0','-show_entries',
    'stream=codec_name,width,height,pix_fmt,r_frame_rate,nb_read_frames','-of','json','wave.mp4'])).streams[0];
  assert.equal(Number(metadata.nb_read_frames), count);
  assert.equal(metadata.width, width); assert.equal(metadata.height, height);
  assert.equal(metadata.r_frame_rate, fps+'/1'); assert.equal(metadata.codec_name, 'h264');
  const raw = await readFile(join(directory,'source.rgba'));
  assert.equal(raw.length, width * height * 4 * count);
  const frameBytes = width * height * 4, unique = new Set();
  for (let i=0; i<count; i++) unique.add(sha(raw.subarray(i*frameBytes,(i+1)*frameBytes)));
  assert(unique.size > count/2, 'Capture did not contain the animated character.');
  const pages = [];
  for (const name of (await readdir(directory)).filter(name => /^atlas-\d+\.png$/.test(name)).sort()) {
    const bytes = await readFile(join(directory,name));
    assert.equal(bytes.readUInt32BE(16), width*cols); assert.equal(bytes.readUInt32BE(20), height*rows);
    pages.push({name, width: width*cols, height: height*rows, bytes: bytes.length, sha256: sha(bytes)});
  }
  assert.equal(pages.length, Math.ceil(count/cells));
  await run(ffmpeg, ['-v','error','-framerate','1','-start_number','0','-i','atlas-%02d.png','-vf','untile='+cols+'x'+rows,
    ...frameLimit,'-fps_mode','passthrough','-pix_fmt','rgba','-f','rawvideo','atlas-roundtrip.rgba']);
  const roundtrip = await readFile(join(directory, 'atlas-roundtrip.rgba'));
  assert(raw.equals(roundtrip), 'Untiled atlas is not pixel-identical to the common source.');
  const manifest = Buffer.from(JSON.stringify({schema:'luis.grid-atlas-probe.v1', order:'row-major',frameCount:count,fps,
    frameWidth:width,frameHeight:height,columns:cols,rows,pages:pages.map(p=>p.name)})+'\n');
  await writeFile(join(directory,'atlas.json'),manifest,{flag:'wx'});
  const mp4 = await readFile(join(directory,'wave.mp4'));
  const pngBytes = pages.reduce((sum,page)=>sum+page.bytes,0);
  const atlasCapacity = pages.reduce((sum,page)=>sum+page.width*page.height*4,0);
  return {
    schema:'luis.playback-encoding-probe.v1',
    scope:'One opaque authored diagnostic wave, identical input pixels to both encoders. Encoding-size comparison; no inference, alpha-channel fidelity, motion-quality ranking, playback-performance or measured VRAM result.',
    render:{...render, width,height,color_space:'sRGB', background,accent, pose:'wave / none',camera:'fixed diagnostic orthographic', skeleton:false,
      pixels:'top-left origin, row-major frames, RGBA8', sample_duration_s:count/fps, source_rgba_bytes:raw.length,
      source_rgba_sha256:sha(raw), distinct_pixel_frames:unique.size},
    mp4:{file:'wave.mp4', bytes:mp4.length, sha256:sha(mp4), stream:metadata, alpha:false},
    png_atlas:{columns:cols,rows,frame_order:'row-major, zero padding/margin, final unused cells excluded from playback',
      pages,page_count:pages.length, png_download_bytes:pngBytes, manifest_utf8_bytes:manifest.length, manifest_sha256:sha(manifest),
      total_download_bytes:pngBytes+manifest.length, theoretical_rgba8_resident_bytes_all_pages_no_mips:atlasCapacity,
      decoded_valid_frame_count:roundtrip.length/frameBytes, decoded_valid_frames_sha256:sha(roundtrip)},
    tools:{node:process.version,ffmpeg:(await exec(ffmpeg,['-version'])).stdout.split('\n')[0],
      ffprobe:(await exec(ffprobe,['-version'])).stdout.split('\n')[0]},
    commands_argv_in_temporary_directory:cmds
  };
}

async function main() {
  const argv=process.argv.slice(2);
  if (argv.length!==0 && !(argv.length===2 && argv[0]==='--out')) throw Error('Usage: node playback-probe.mjs [--out NEW_FILE.json]');
  if (!['http:','https:'].includes(web.protocol) || web.username || web.password || web.search || web.hash) throw Error('Use a plain HTTP(S) LUIS_WEB_URL.');
  const output=argv.length?resolve(argv[1]):null;
  if(output && await access(output).then(()=>true,error=>{if(error.code==='ENOENT')return false;throw error;})) throw Error('Refusing to overwrite '+output);
  const directory=await mkdtemp(join(tmpdir(),'luis-playback-'));
  try {
    const result=await probe(directory), text=JSON.stringify(result,null,2)+'\n';
    if(output){await writeFile(output,text,{flag:'wx'});console.log('Wrote '+output);}
    else process.stdout.write(text);
  } finally { await rm(directory,{recursive:true,force:true}); }
}
main().catch(error=>{console.error(error);process.exitCode=1;});
