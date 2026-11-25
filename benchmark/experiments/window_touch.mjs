import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LUIS_PLAYWRIGHT_MODULE || 'playwright');
const url = new URL(process.env.LUIS_WINDOW_URL || 'http://127.0.0.1:8774/platform/web/window/');
url.searchParams.set('inspect', '1');

const browser = await chromium.launch({
  executablePath: process.env.LUIS_CHROME_PATH || undefined,
  args: ['--enable-unsafe-swiftshader'],
});

try {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true,
  });
  const page = await context.newPage();
  page.setDefaultTimeout(12_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 200;
    canvas.height = 160;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    window.touchSamples = [];
    document.addEventListener('luis:frame', event => {
      const pose = event.detail;
      context.drawImage(event.target, 0, 0, canvas.width, canvas.height);
      const rgb = context.getImageData(0, 0, canvas.width, canvas.height).data;
      // Centroid of the bright cyan portion of each iris in the approved blue-haired artwork.
      function center(left, right, top, bottom, select) {
        let sum = 0;
        let count = 0;
        for (let y = top; y < bottom; y++) {
          for (let x = left; x < right; x++) {
            const i = 4 * (y * canvas.width + x);
            if (select(rgb[i], rgb[i + 1], rgb[i + 2])) {
              sum += x;
              count++;
            }
          }
        }
        return count >= 4 ? sum / count : null;
      }
      const iris = (r, g, b) => b > 145 && g > 110 && g - r > 42 && b - r > 70;
      const white = (r, g, b) => r > 180 && g > 165 && b > 160 && Math.max(r, g, b) - Math.min(r, g, b) < 48;
      const skin = (r, g, b) => r > 180 && g > 125 && r - b > 20 && g > b;
      window.touchSamples.push({
        eye: pose.eyeX, head: pose.headX, blink: pose.blink, mode: pose.mode,
        eyePixels: [center(52, 100, 92, 138, iris), center(105, 148, 92, 138, iris)],
        headdress: center(45, 158, 17, 47, white),
        fingertips: [center(62, 91, 145, 150, skin), center(112, 146, 145, 150, skin)], t: performance.now(),
      });
    }, true);
  });
  await page.goto(url.href);
  const surface = page.locator('#window-surface');
  await page.waitForFunction(() => window.touchSamples.some(frame => frame.eyePixels.every(Number.isFinite)));
  const box = await surface.boundingBox();
  assert(box && box.width > 200 && box.height > 150, 'visible interaction surface');
  const client = await context.newCDPSession(page);
  const point = (x, y) => ({ x: box.x + box.width * x, y: box.y + box.height * y, id: 1 });
  const touch = (type, p) => client.send('Input.dispatchTouchEvent', { type, touchPoints: p ? [p] : [] });
  const mode = value => page.waitForFunction(value => document.querySelector('#window-surface').dataset.gesture === value, value);
  const left = point(.15, .5);
  const right = point(.85, .5);
  const latest = () => page.evaluate(() => window.touchSamples.at(-1));

  await touch('touchStart', left);
  await mode('press');
  await touch('touchEnd');
  await mode('tap');
  await mode('idle');

  await touch('touchStart', right);
  await mode('hold');
  await touch('touchEnd');
  await mode('idle');

  await touch('touchStart', right);
  await mode('hold');
  const holding = await latest();
  await touch('touchMove', left);
  await mode('drag');
  await page.waitForFunction(() => {
    const frame = window.touchSamples.at(-1);
    return frame.eye < -.65 && frame.head < -.65 && frame.blink < .1 && frame.eyePixels.every(Number.isFinite);
  });
  const lookingLeft = await latest();
  const cut = await page.evaluate(() => window.touchSamples.length);
  await touch('touchMove', right);
  await page.waitForFunction(() => {
    const frame = window.touchSamples.at(-1);
    return frame.eye > .65 && frame.head > .65 && frame.blink < .1 && frame.eyePixels.every(Number.isFinite);
  });
  const lookingRight = await latest();
  const reversal = await page.evaluate(cut => window.touchSamples.slice(cut), cut);
  const eyeCrossing = reversal.findIndex(frame => frame.eye > 0);
  const headCrossing = reversal.findIndex(frame => frame.head > 0);
  assert(eyeCrossing >= 0 && eyeCrossing < headCrossing, 'eyes cross the midpoint before the head on reversal');
  const shifts = lookingRight.eyePixels.map((v, i) => v - lookingLeft.eyePixels[i]);
  assert([lookingLeft.headdress, lookingRight.headdress].every(Number.isFinite), 'white headdress visible in both samples');
  const headShift = lookingRight.headdress - lookingLeft.headdress;
  assert(headShift > .6, 'rendered headdress moves in the requested direction');
  for (const frame of [lookingLeft, lookingRight]) {
    assert(holding.fingertips.every(Number.isFinite) && frame.fingertips.every(Number.isFinite), 'two visible fingertips on the sill');
    assert(frame.fingertips.every((x, index) => Math.abs(x - holding.fingertips[index]) < 1), 'fingertips stay anchored during tracking');
  }
  assert(shifts.every(pixels => pixels > 1), 'both rendered cyan irises shift right by more than one sample pixel');
  await touch('touchMove', point(1.07, .62));
  await mode('drag');
  await touch('touchEnd');
  await mode('idle');
  await page.waitForFunction(() => {
    const frame = window.touchSamples.at(-1);
    return Math.abs(frame.eye) < .12 && Math.abs(frame.head) < .12;
  });

  await touch('touchStart', left);
  await touch('touchMove', right);
  await mode('swipe');
  await touch('touchEnd');
  await mode('idle');
  await touch('touchStart', left);
  await mode('hold');
  await touch('touchMove', right);
  await mode('drag');
  await touch('touchCancel');
  await mode('idle');
  assert.deepEqual(errors, []);
  if (process.env.LUIS_WINDOW_SCREENSHOT) await page.screenshot({ path: process.env.LUIS_WINDOW_SCREENSHOT });
  console.log(JSON.stringify({
    browser: browser.version(), viewport: [390, 844], gestures: ['tap', 'hold', 'drag', 'swipe'],
    reversal: { eyeCrossingFrame: eyeCrossing, headCrossingFrame: headCrossing, renderedIrisDeltaAt200px: shifts, headdressDeltaAt200px: headShift },
    anchoredFingertips: true, dragOutsideReleased: true, cancelledDragReset: true,
  }, null, 2));
} finally {
  await browser.close();
}
