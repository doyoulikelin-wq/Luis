export async function calibration(t) {
  await t.run({id:'healthy-reference',phase:'calibration',input:'native-touch',expectedProbe:'pass',
    expectation:'正常角色接受新的手势，实际左右画面可区分，同侧复测一致。'}, async h => {
    h.check('ready', (await h.snapshot()).mode==='idle');
  });
  await t.run({id:'swallowed-input-control',phase:'calibration',input:'mixed',expectedProbe:'control-failed',
    expectation:'测试夹具吞掉按下事件。观察器应检出控制失败。'}, async h => {
    await h.page.evaluate(() => window.addEventListener('pointerdown', e=>e.stopImmediatePropagation(),true));
    h.note('injection','a capture-phase listener consumes pointerdown after the input observer');
  });
  await t.run({id:'covered-hit-surface-control',phase:'calibration',input:'mixed',expectedProbe:'surface-obstructed',
    expectation:'透明遮挡层截获浏览器命中，评测应定位到被遮挡的触摸区域。'}, async h => {
    await h.page.locator('#window-surface').evaluate(surface=>{
      const rect=surface.getBoundingClientRect();
      const overlay=document.createElement('div');
      overlay.id='benchmark-hit-overlay';
      Object.assign(overlay.style,{position:'fixed',left:rect.left+'px',top:rect.top+'px',
        width:rect.width+'px',height:rect.height+'px',zIndex:1000,touchAction:'none'});
      document.body.append(overlay);
    });
  });
  await t.run({id:'frozen-presentation-control',phase:'calibration',input:'mixed',expectedProbe:'presentation-failed',
    expectation:'手势和动画状态继续更新，屏幕覆盖一张固定帧；应仅判显示停滞。'}, async h => {
    await h.page.evaluate(() => new Promise(resolve => {
      const src=document.querySelector('#avatar');
      src.addEventListener('luis:frame',()=>{
        const copy=document.createElement('canvas');
        copy.width=src.width; copy.height=src.height;
        copy.getContext('2d').drawImage(src,0,0);
        Object.assign(copy.style,{position:'absolute',inset:'0',width:'100%',height:'100%',pointerEvents:'none',zIndex:5});
        src.parentElement.append(copy);
        resolve();
      },{once:true});
    }));
  });
}
