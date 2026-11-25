import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';
import {mkdtemp, readFile, rm, writeFile, access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const exec = promisify(execFile);
const require = createRequire(import.meta.url);
const here = fileURLToPath(new URL('.', import.meta.url));
const base = new URL(process.env.LUIS_WEB_URL || 'http://127.0.0.1:8774/platform/web/');
const asset = 'builtin:upper-body.v1';
const name = '书店店员';
const accent = '#42645b';
const shelfKey = 'luis.preview.instances.v1';
const sourceNick = '模板访客';
const originalNick = '读者青禾';
const correctedNick = '读者秋棠';
const unknown = '我还没有记下你的称呼。';
const scene = '我有点累';
const expected = {
  calm: {reply: '那就坐一会儿。我听着。', action: 'nod'},
  lively: {reply: '辛苦啦！想吐槽两句，还是一起放空一下？', action: 'wave'}
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const known = (nick) => '你希望我叫你' + nick + '。';
const executableFiles = ['index.html', 'app.js', 'viewer.js', 'figure.js', 'pose.js', 'companion.js'];

function outputPath(args) {
  if (args.length === 0) return null;
  if (args.length === 2 && args[0] === '--out') return resolve(args[1]);
  throw new Error('Usage: node benchmark/experiments/web_flow.mjs [--out NEW_FILE.json]');
}

async function download(page, button, destination) {
  const pending = page.waitForEvent('download');
  await button.click();
  const result = await pending;
  await result.saveAs(destination);
  return readFile(destination);
}

async function runCell(browser, persona, consent, temp) {
  const context = await browser.newContext({viewport: {width: 1280, height: 900}, reducedMotion: 'reduce', acceptDownloads: true, serviceWorkers: 'block'});
  try {
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      return url.origin === base.origin || ['blob:', 'data:'].includes(url.protocol) ? route.continue() : route.abort();
    });
    const page = await context.newPage();
    page.setDefaultTimeout(8_000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(base.href);
    await page.waitForFunction(() => !document.querySelector('#play')?.disabled && document.querySelector('.cp-panel'));
    const renderer = await page.locator('#character-canvas').evaluate(canvas => {
      const gl = canvas.getContext('webgl');
      if (!gl || gl.isContextLost()) throw new Error('Real WebGL canvas required; 2D fallback cannot enter this experiment.');
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      return {version: gl.getParameter(gl.VERSION), renderer: gl.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : gl.RENDERER)};
    });
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage)), [], 'refusing to operate on existing browser data');
    const webHashes = {};
    for (const file of executableFiles) {
      const response = await context.request.get(new URL(file, page.url()).href);
      assert.equal(response.status(), 200, file);
      webHashes[file] = hash(await response.body());
    }
    const panel = page.locator('#companion-panel');
    const button = label => panel.getByRole('button', {name: label, exact: true});
    const label = text => panel.locator('label').filter({has: page.getByText(text, {exact: true})}).locator('input, select');
    const visiting = () => label('当前实例');
    const allow = () => label('允许保存称呼，关闭时清除');
    const nickname = () => label('称呼');
    const readShelf = () => page.evaluate(key => JSON.parse(localStorage.getItem(key)), shelfKey);
    const reload = async () => {
      await page.reload();
      await page.locator('#tab-companion').click();
      await visiting().waitFor();
    };
    const answer = async (prompt, wanted) => {
      await button(prompt).click();
      const actual = await panel.locator('.cp-answer').textContent();
      assert.equal(actual, name + '　' + wanted);
      return actual.slice(name.length + 1);
    };
    const saveNick = async value => {
      await nickname().fill(value);
      await button('记住称呼').click();
      assert.equal(await panel.locator('.cp-note').textContent(), '本实例已记住新称呼。');
    };
    const doScene = async () => {
      const reply = await answer(scene, expected[persona].reply);
      await page.locator('#tab-motion').click();
      const action = await page.locator('button[data-action][aria-pressed=true]').getAttribute('data-action');
      assert.equal(action, expected[persona].action);
      await page.locator('#tab-companion').click();
      return {reply, action};
    };

    await page.locator('#tab-companion').click();
    await label('角色名称').fill(name);
    await label('回应风格').selectOption(persona);
    assert.equal(await label('服装色').inputValue(), accent);
    await button('应用设定').click();
    const source = await visiting().inputValue();
    await allow().check();
    await saveNick(sourceNick);
    const fileStem = persona + (consent ? '-on' : '-off');
    const packPath = join(temp, fileStem + '-pack.json');
    const packBytes = await download(page, button('导出角色包'), packPath);
    const pack = JSON.parse(packBytes);
    assert.deepEqual(pack, {schema: 'luis.character.v1', asset, name, persona, accent});
    const chooser = page.waitForEvent('filechooser');
    await button('导入角色包').click();
    await (await chooser).setFiles(packPath);
    await page.waitForFunction(id => document.querySelector('.cp-panel select').value !== id, source);
    const instance = await visiting().inputValue();
    assert.notEqual(source, instance);
    assert.equal(await allow().isChecked(), false);
    assert.equal((await readShelf()).items.length, 2);
    const initialRecall = await answer('问我的称呼', unknown);
    const firstScene = await doScene();
    let afterSave, afterCorrection, afterForget, deniedSave;
    if (consent) {
      await allow().check();
      await saveNick(originalNick);
      await reload();
      afterSave = await answer('问我的称呼', known(originalNick));
      await saveNick(correctedNick);
      await reload();
      afterCorrection = await answer('问我的称呼', known(correctedNick));
      const shelf = await readShelf();
      assert.equal(shelf.items.find(item => item.id === instance).nickname, correctedNick);
      await button('忘记称呼').click();
      await reload();
      afterForget = await answer('问我的称呼', unknown);
    } else {
      assert.equal(await nickname().isDisabled(), true);
      await button('记住称呼').click();
      deniedSave = await panel.locator('.cp-note').textContent();
      assert.equal(deniedSave, '请先开启本机记忆。');
      await reload();
      afterSave = await answer('问我的称呼', unknown);
      assert.equal(await nickname().isDisabled(), true);
    }
    const finalShelf = await readShelf();
    const target = finalShelf.items.find(item => item.id === instance);
    assert.equal(target.remember, consent);
    assert.equal(target.nickname, '');
    assert.equal(finalShelf.items.find(item => item.id === source).nickname, sourceNick);
    await visiting().selectOption(source);
    const sourceRecall = await answer('问我的称呼', known(sourceNick));
    await visiting().selectOption(instance);
    const isolatedRecall = await answer('问我的称呼', unknown);
    const secondScene = await doScene();
    assert.deepEqual(secondScene, firstScene);

    const tracePath = join(temp, fileStem + '-trace.json');
    const traceBytes = await download(page, page.locator('#export-file'), tracePath);
    const trace = JSON.parse(traceBytes);
    assert.equal(trace.schema, 'luis.motion-trace.v1');
    assert.equal(trace.action, firstScene.action);
    assert.equal(trace.fault, 'none');
    const {stdout} = await exec('python3', [join(here, '..', 'motion.py'), tracePath, '--profile', join(here, 'rig-profile.json')]);
    const report = JSON.parse(stdout);
    assert.equal(report.calibration_source, 'external_profile');
    assert.equal(report.verdict, 'pass');
    assert.equal(report.frame_count, trace.frames.length);
    assert(Object.values(report.checks).every(check => check.verdict === 'pass'));

    // Reopen the actual browser download using the public trace importer.
    const traceChooser = page.waitForEvent('filechooser');
    await page.locator('#import-file').click();
    await (await traceChooser).setFiles(tracePath);
    await page.waitForFunction(() => document.querySelector('#source-kind').textContent === '导入轨迹');
    assert.equal(await page.locator('#frame-total').textContent(), String(report.frame_count));
    assert.deepEqual(errors, []);
    return {
      renderer, webHashes,
      cell: {
        persona, consent, verdict: 'pass', pack_sha256: hash(packBytes), instance_count: finalShelf.items.length,
        scene: firstScene, memory: {
          imported_instance_before_consent: initialRecall,
          recall_after_save_and_reload: afterSave,
          ...(consent ? {corrected_after_reload: afterCorrection, forgotten_after_reload: afterForget} : {disabled_write_feedback: deniedSave}),
          source_after_target_changes: sourceRecall, target_after_switch_back: isolatedRecall,
          final_stored_private_record: {remember: target.remember, nickname: target.nickname}
        },
        trace: {action: trace.action, frames: report.frame_count, fps: trace.fps, file_sha256: hash(traceBytes),
          fixed_profile_verdict: report.verdict, passed_checks: Object.keys(report.checks).length, reopened_in_app: true}
      }
    };
  } finally { await context.close(); }
}

async function main() {
  const output = outputPath(process.argv.slice(2));
  if (output) {
    const exists = await access(output).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error; });
    if (exists) throw new Error('Refusing to overwrite ' + output);
  }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
    throw new Error('LUIS_WEB_URL must be a plain HTTP(S) app URL.');
  }
  const {chromium} = require(process.env.LUIS_PLAYWRIGHT_MODULE || 'playwright');
  const temp = await mkdtemp(join(tmpdir(), 'luis-web-flow-'));
  let browser;
  try {
    browser = await chromium.launch({headless: true, executablePath: process.env.LUIS_CHROME_PATH || undefined,
      args: ['--enable-unsafe-swiftshader']});
    let sources, renderer;
    const cells = [];
    for (const persona of ['calm', 'lively']) {
      for (const consent of [false, true]) {
        const row = await runCell(browser, persona, consent, temp);
        if (sources) assert.deepEqual(row.webHashes, sources, 'web app changed between cells');
        if (renderer) assert.deepEqual(row.renderer, renderer, 'renderer changed between cells');
        sources = row.webHashes; renderer = row.renderer; cells.push(row.cell);
      }
      const [off, on] = cells.slice(-2);
      assert.equal(off.pack_sha256, on.pack_sha256);
      assert.equal(off.trace.file_sha256, on.trace.file_sha256);
    }
    const result = {
      schema: 'luis.web-flow-experiment.v1', measured_at: new Date().toISOString(), browser: browser.version(), webgl: renderer,
      design: 'Scripted 2×2 integration check on a single synthetic template; four isolated ephemeral browser contexts, one observation per condition.',
      scope: 'Browser UI, public pack export/import, per-instance local nickname, scripted dialogue/action and exported numeric motion. No generative-model, human preference or real-device quality score.',
      frozen: {asset, name, accent, scene, source_private_nickname: sourceNick, requested_nicknames: [originalNick, correctedNick],
        web_file_sha256: sources, evaluator_file_sha256: hash(await readFile(join(here, '..', 'motion.py'))),
        experiment_file_sha256: hash(await readFile(fileURLToPath(import.meta.url))), rig_profile_file_sha256: hash(await readFile(join(here, 'rig-profile.json')))},
      observations: cells
    };
    const json = JSON.stringify(result, null, 2) + '\n';
    if (output) { await writeFile(output, json, {flag:'wx'}); console.log('4/4 conditions passed; wrote ' + output); }
    else process.stdout.write(json);
  } finally {
    try { if (browser) await browser.close(); } finally { await rm(temp, {recursive: true, force: true}); }
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
