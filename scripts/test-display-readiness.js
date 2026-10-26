const assert = require('assert');
require('ts-node/register/transpile-only');

class Element {
    constructor() { this.style = {}; this.dataset = {}; this.children = []; this.clientWidth = 402; this.clientHeight = 639; }
    setAttribute() {}
    append(...items) { this.children.push(...items); }
    appendChild(item) { this.append(item); }
    insertBefore(item) { this.append(item); }
    querySelector() { return null; }
    addEventListener() {}
    removeEventListener() {}
    remove() {}
    getContext() { return { drawImage() {} }; }
}
let now = 0;
let nextTimer = 0;
const timers = new Map();
global.document = { createElement: () => new Element() };
global.window = {
    innerWidth: 402, innerHeight: 639,
    localStorage: { getItem: () => null },
    setTimeout: callback => { timers.set(++nextTimer, callback); return nextTimer; },
    clearTimeout: id => timers.delete(id),
};
global.location = { pathname: '/', origin: 'http://example.test' };
global.requestAnimationFrame = () => 1;
global.cancelAnimationFrame = () => {};
global.VideoDecoder = class { constructor() { this.state = 'unconfigured'; } };
global.getComputedStyle = () => ({paddingLeft: '0', paddingRight: '0', paddingTop: '0', paddingBottom: '0'});
const realNow = Date.now;
Date.now = () => now;
const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };
const tick = async () => {
    now += 100;
    const pending = [...timers.values()]; timers.clear();
    pending.forEach(callback => callback());
    await flush();
};

const { WebCodecsPlayer } = require('../src/app/player/WebCodecsPlayer');
const { MsePlayer } = require('../src/app/player/MsePlayer');
const { DisplayProfileControl } = require('../src/app/googDevice/client/DisplayProfileControl');
const ScreenInfo = require('../src/app/ScreenInfo').default;
const Rect = require('../src/app/Rect').default;
const Size = require('../src/app/Size').default;
const source = (height = 2992) => new ScreenInfo(new Rect(0, 0, 1344, height), new Size(960, 2160), 0);
const status = { current: { physical: { width: 1344, height: 2992 }, density: 480 } };
global.fetch = async () => ({ok: true, json: async () => ({success: true, status})});

(async () => {
    const player = new WebCodecsPlayer('test');
    player.setStreamScreenInfo(source());
    // WebCodecs uses the decoded size for its canvas; it must not overwrite
    // the server's Android geometry used by display-profile verification.
    player.scaleCanvas(960, 2160);
    assert.strictEqual(player.getScreenInfo().contentRect.getWidth(), 960);
    assert.strictEqual(player.getStreamScreenInfo().contentRect.getWidth(), 1344);

    const suspended = [];
    const control = new DisplayProfileControl('test', player, new Element(), new Element(), value => suspended.push(value), () => {});
    await flush();
    assert.deepStrictEqual(suspended, [true], 'No decoded frame must keep input paused');
    let closed = false;
    player.receivedFirstFrame = true;
    player.onFrameDecoded(0, 0, {displayWidth: 960, displayHeight: 2160, close() { closed = true; }});
    player.drawDecoded();
    await tick();
    assert(closed);
    assert.deepStrictEqual(suspended, [true, false], 'A presented WebCodecs frame must restore touch without a video element');
    control.release();

    // An old stream or old-size frame must still be rejected after a resize.
    player.setStreamScreenInfo(source(2080));
    const blocked = [];
    const stale = new DisplayProfileControl('test', player, new Element(), new Element(), value => blocked.push(value), () => {});
    await flush();
    player.markFramePresented(960, 2160);
    await tick();
    assert.deepStrictEqual(blocked, [true]);
    player.setStreamScreenInfo(source());
    player.markFramePresented(960, 2080);
    await tick();
    assert.deepStrictEqual(blocked, [true], 'A stale-size decoded frame must not restore touch');
    player.markFramePresented(960, 2160);
    await tick();
    assert.deepStrictEqual(blocked, [true, false]);
    stale.release();

    // MSE can show a valid still desktop at currentTime=0: advancing video
    // time is not required when HAVE_CURRENT_DATA confirms a decoded frame.
    const video = {readyState: 2, videoWidth: 960, videoHeight: 2160, currentTime: 0, error: null};
    const mse = {tag: video};
    assert.deepStrictEqual(MsePlayer.prototype.getPresentedFrameSize.call(mse), new Size(960, 2160));
    video.readyState = 1;
    assert.strictEqual(MsePlayer.prototype.getPresentedFrameSize.call(mse), undefined);
    video.readyState = 2; video.error = {code: 3};
    assert.strictEqual(MsePlayer.prototype.getPresentedFrameSize.call(mse), undefined);
    console.log('Display readiness: WebCodecs rendered frame, independent source geometry, stale-frame rejection and MSE still-frame readiness passed.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { Date.now = realNow; });
