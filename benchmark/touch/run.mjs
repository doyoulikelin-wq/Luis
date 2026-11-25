import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {parseArgs} from 'node:util';
import {chromium, profile, attach, probeRecovery, ModeTimeout, Unverified} from './harness.mjs';

async function main() {
  const {values} = parseArgs({options:{
    suite:{type:'string'}, case:{type:'string'}, repeat:{type:'string',default:'1'}, out:{type:'string'}, frames:{type:'string'}, list:{type:'boolean'},
  }});
  const suiteNames=['calibration','entry','gestures','contacts','arbitration','terminals','lifecycle','repairs'];
  const selected=values.suite ? values.suite.split(',') : suiteNames;
  if (selected.some(name=>!suiteNames.includes(name))) throw new Error('Unknown suite');
  const repeat=Number(values.repeat);
  if (!Number.isInteger(repeat) || repeat<1) throw new Error('--repeat must be a positive integer');
  const cases=[];
  for (const suite of selected) {
    const module=await import('./'+suite+'.mjs');
    await module[suite]({run(spec,execute) { cases.push({spec:{suite,oracle:'contract',...spec},execute}); }});
  }
  if (new Set(cases.map(c=>c.spec.id)).size!==cases.length) throw new Error('Duplicate case id');
  const requestedIds=values.case?.split(',');
  const active=cases.filter(c=>!requestedIds || requestedIds.includes(c.spec.id));
  if (!active.length || requestedIds?.some(id=>!active.some(c=>c.spec.id===id))) throw new Error('No matching cases for one or more requested IDs');
  if (values.list) { console.table(active.map(c=>c.spec)); process.exit(0); }

  const url=new URL(process.env.LUIS_WINDOW_URL || 'http://127.0.0.1:8774/platform/web/window/');
  url.searchParams.set('inspect','1');
  const browser=await chromium.launch({executablePath:process.env.LUIS_CHROME_PATH || undefined,
    args:['--enable-unsafe-swiftshader'],ignoreDefaultArgs:['--disable-back-forward-cache']});
  const results=[];
  const report={schema:'luis.touch-liveness.v1',testedAt:new Date().toISOString(),url:url.href,browser:browser.version(),profile,repeat,assets:{},results};
  let infrastructureError=false;
  try {
    const fetcher=await browser.newContext();
    try {
      for (const file of ['index.html','main.js','interaction.js','actor.js','window.css','fonts/noto-sans-sc-ui.woff2','assets/blue-companion.webp']) {
        const res=await fetcher.request.get(new URL(file,url).href);
        if (!res.ok()) throw new Error('Asset unavailable: '+file+' HTTP '+res.status());
        report.assets[file]=createHash('sha256').update(await res.body()).digest('hex');
      }
    } finally { await fetcher.close(); }

    for (let iteration=1;iteration<=repeat;iteration++) {
      for (const {spec,execute} of active) {
        const ctx=await browser.newContext({viewport:profile.viewport,deviceScaleFactor:profile.deviceScaleFactor,isMobile:true,hasTouch:true});
        const row={...spec,iteration,checks:[],evidence:{}};
        results.push(row);
        let h;
        try {
          const page=await ctx.newPage();
          h=await attach(ctx,page,url.href);
          const pageErrors=[];
          page.on('pageerror',e=>pageErrors.push(e.message));
          row.checks=h.checks; row.evidence=h.notes;
          try { await execute(h); }
          catch (e) {
            if (e instanceof ModeTimeout) h.check(e.message,false);
            else if (e instanceof Unverified) row.unverified=e.message;
            else throw e;
          }
          const end=await h.snapshot();
          row.endMode=end.mode;
          row.lastInputs=end.events.slice(-18);
          row.observedModes=end.modes;
          row.pageErrors=pageErrors;
          const frames=[];
          if (values.frames) h.onProbeScreenshot=(ordinal,png)=>{ frames[ordinal]=png; };
          row.probe=await probeRecovery(h);
          if (frames.length) {
            const folder=join(spec.id,String(iteration));
            await mkdir(join(values.frames,folder),{recursive:true});
            row.frameFiles=[];
            for (const [i,png] of frames.entries()) {
              const name=join(folder,['a-left.png','b-right.png','a-left-repeat.png'][i]);
              await writeFile(join(values.frames,name),png);
              row.frameFiles.push(name);
            }
          }
          const observed=row.probe.outcome, expected=spec.expectedProbe || 'pass';
          if (row.checks.some(c=>!c.ok) || pageErrors.length) row.status='fail';
          else if (row.unverified || observed.startsWith('unverified')) row.status='unverified';
          else row.status=observed===expected?'pass':'fail';
        } catch (e) {
          row.status='error';
          row.error=String(e.message || e);
          infrastructureError=true;
        } finally { await ctx.close(); }
        console.log(iteration,row.status.padEnd(10),spec.id,row.probe?.outcome || row.error);
      }
    }
  } finally { await browser.close(); }
  report.counts=Object.fromEntries(['pass','fail','unverified','error'].map(s=>[s,results.filter(r=>r.status===s).length]));
  console.log(JSON.stringify(report.counts));
  if (values.out) await writeFile(values.out,JSON.stringify(report,null,2)+'\n');
  process.exitCode=infrastructureError?2:results.some(r=>r.status!=='pass')?1:0;
}

main().catch(error=>{
  console.error(error);
  process.exitCode=2;
});
