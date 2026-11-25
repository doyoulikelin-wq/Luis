// Independent escalation experiment. The standard runner still scores the first fresh contact.
import {writeFile} from 'node:fs/promises';
import {parseArgs} from 'node:util';
import {attach, chromium, probeRecovery, profile, Unverified} from './harness.mjs';
import {contacts} from './contacts.mjs';
import {lifecycle} from './lifecycle.mjs';

const fixtureIds = ['missing-up-and-capture-loss', 'navigate-back-during-contact'];

async function sample(h) {
  return h.page.evaluate(() => ({
    origin:performance.timeOrigin, at:Math.round(performance.now()), focused:document.hasFocus(),
    visible:!document.hidden, mode:document.querySelector('#window-surface')?.dataset.gesture,
    targetX:window.__luisTouchTrace?.frame?.targetX,
  }));
}

async function tabRoundTrip(h) {
  const before = await sample(h);
  await h.page.evaluate(() => {
    window.__luisLadderFocus = [];
    for (const type of ['focus','blur']) {
      window.addEventListener(type, e => {
        if (e.target === window) window.__luisLadderFocus.push({
          type, trusted:e.isTrusted, at:performance.now(), hidden:document.hidden,
        });
      });
    }
  });
  // Playwright presents all tabs as focused by default. Only remove its override
  // after both ordinary probes so the seed and first two attempts match the suite.
  await h.cdp.send('Emulation.setFocusEmulationEnabled', {enabled:false});
  await h.page.bringToFront();
  const prepared = await sample(h);
  const beforeSwitch = await h.page.evaluate(() => window.__luisLadderFocus.length);
  const other = await h.context.newPage();
  let away;
  try {
    await other.goto('about:blank');
    await other.bringToFront();
    away = await sample(h);
    await h.page.bringToFront();
  } finally {
    await other.close();
  }
  const after = await sample(h);
  const signals = await h.page.evaluate(() => window.__luisLadderFocus);
  const prepBlur = signals.slice(0,beforeSwitch).some(e => e.type === 'blur' && e.trusted);
  const during = signals.slice(beforeSwitch);
  const blurAt = during.findIndex(e => e.type === 'blur' && e.trusted);
  const returnFocus = blurAt >= 0 && during.slice(blurAt+1).some(e => e.type === 'focus' && e.trusted);
  const verified = !prepBlur && before.origin === after.origin && before.mode === prepared.mode
    && prepared.focused && !away.focused && blurAt >= 0 && after.focused && returnFocus;
  return {verified, before, prepared, away, after, beforeSwitch, signals};
}

async function reload(h) {
  const before = await sample(h);
  await h.page.reload({waitUntil:'domcontentloaded'});
  await h.page.waitForFunction(() => window.__luisTouchTrace?.frameCount >= 2);
  const after = await sample(h);
  const verified = before.origin !== after.origin && await h.page.evaluate(() =>
    performance.getEntriesByType('navigation')[0]?.type === 'reload');
  return {verified, before, after};
}

async function runLadder(h, row) {
  async function attempt(stage, intervention={verified:true}) {
    const probe = await probeRecovery(h);
    const step = {stage, intervention, probe};
    row.steps.push(step);
    return step;
  }

  for (const stage of ['fresh-contact-1','fresh-contact-2']) {
    const {probe} = await attempt(stage);
    if (probe.outcome === 'pass') return stage;
    if (probe.outcome.startsWith('unverified')) {
      row.unverified = 'Ordinary contact result inconclusive at '+stage+': '+probe.outcome;
      return null;
    }
  }
  const tab = await attempt('tab-blur-return', await tabRoundTrip(h));
  if (tab.intervention.verified && tab.probe.outcome === 'pass') return tab.stage;

  const refreshed = await attempt('reload', await reload(h));
  if (refreshed.intervention.verified && refreshed.probe.outcome === 'pass') return refreshed.stage;
  return null;
}

async function main() {
  const {values} = parseArgs({options:{
    out:{type:'string', default:'/tmp/luis-touch-recovery-ladder.json'},
    repeat:{type:'string', default:'2'}, case:{type:'string'},
  }});
  const repeat = Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat < 1) throw new Error('--repeat must be a positive integer');
  if (values.case && !fixtureIds.includes(values.case)) throw new Error('Unknown recovery fixture');
  const cases = [];
  const registry = {run(spec, execute) {
    if (fixtureIds.includes(spec.id) && (!values.case || spec.id === values.case)) cases.push({spec, execute});
  }};
  await contacts(registry);
  await lifecycle(registry);
  if (cases.length !== (values.case ? 1 : fixtureIds.length)) throw new Error('Missing recovery fixture');
  const url = new URL(process.env.LUIS_WINDOW_URL || 'http://127.0.0.1:8774/platform/web/window/');
  url.searchParams.set('inspect', '1');
  const browser = await chromium.launch({
    executablePath:process.env.LUIS_CHROME_PATH || undefined,
    args:['--enable-unsafe-swiftshader'], ignoreDefaultArgs:['--disable-back-forward-cache'],
  });
  const report = {schema:'luis.touch-recovery-ladder.v1', testedAt:new Date().toISOString(), browser:browser.version(),
    url:url.href, profile, repeat, results:[]};
  try {
    for (let iteration=1; iteration<=repeat; iteration++) {
      for (const {spec, execute} of cases) {
        const row = {id:spec.id, input:spec.input, iteration, steps:[]};
        report.results.push(row);
        const ctx = await browser.newContext({
          viewport:profile.viewport, deviceScaleFactor:profile.deviceScaleFactor, isMobile:true, hasTouch:true,
        });
        try {
          const h = await attach(ctx, await ctx.newPage(), url.href);
          row.fixture = {checks:h.checks, notes:h.notes};
          await execute(h);
          if (spec.id === 'navigate-back-during-contact') {
            h.require(h.notes.restoration?.path === 'bfcache', 'The active document did not return from BFCache');
          }
          row.seed = await sample(h);
          row.firstVerifiedRecovery = await runLadder(h, row);
          row.status = row.firstVerifiedRecovery ? 'recovered' : (row.unverified ? 'unverified' : 'no-verified-recovery');
        } catch (e) {
          row.status = e instanceof Unverified ? 'unverified' : 'error';
          row.detail = e.message;
        } finally {
          await ctx.close();
        }
        console.log(iteration, spec.id, row.status, row.firstVerifiedRecovery || row.detail || '');
      }
    }
  } finally {
    await browser.close();
  }
  await writeFile(values.out, JSON.stringify(report,null,2)+'\n');
  process.exitCode = report.results.some(r => r.status === 'error') ? 2 :
    report.results.some(r => r.status !== 'recovered') ? 1 : 0;
}

main().catch(e => { console.error(e); process.exitCode=2; });
