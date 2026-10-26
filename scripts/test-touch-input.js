const assert = require('assert');

require('ts-node/register/transpile-only');
require.extensions['.png'] = (module) => { module.exports = 'touch-point.png'; };

class Target {
    constructor() { this.listeners = new Map(); this.clientWidth = 320; this.clientHeight = 720; this.left = 0; this.top = 0; }
    addEventListener(name, listener, options) {
        const list = this.listeners.get(name) || [];
        list.push({listener, options}); this.listeners.set(name, list);
    }
    removeEventListener(name, listener) {
        this.listeners.set(name, (this.listeners.get(name) || []).filter(item => item.listener !== listener));
    }
    dispatch(event) { for (const {listener} of this.listeners.get(event.type) || []) listener(event); }
    getContext() { return null; }
    getBoundingClientRect() { return {left: this.left, top: this.top, width: this.clientWidth, height: this.clientHeight}; }
}

global.MouseEvent = class MouseEvent {};
global.Image = class Image {};
global.window = {
    addEventListener(_name, _listener, options) { if (options) void options.passive; },
    removeEventListener() {},
};
// Touch events must work even when a browser does not expose a TouchEvent constructor.
global.document = {
    body: new Target(),
    createElement() { return {attributes: {}, setAttribute(name, value) { this.attributes[name] = value; }}; },
};

const {FeaturedInteractionHandler} = require('../src/app/interactionHandler/FeaturedInteractionHandler');
const {MsePlayer} = require('../src/app/player/MsePlayer');
const ScreenInfo = require('../src/app/ScreenInfo').default;
const Rect = require('../src/app/Rect').default;
const Size = require('../src/app/Size').default;
const tag = new Target();
const sent = [];
let streamedSize = new Size(320, 720);
const handler = new FeaturedInteractionHandler({
    getTouchableElement: () => tag,
    getScreenInfo: () => new ScreenInfo(new Rect(0, 0, 1344, 2992), streamedSize, 0),
}, {sendMessage: message => sent.push(message)});

const touch = (identifier, x, y) => ({identifier, target: tag, clientX: x, clientY: y, force: 0.5});
function emit(type, changedTouches) {
    const event = {type, changedTouches, target: tag, cancelable: true,
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() {}};
    tag.dispatch(event);
    assert.strictEqual(event.defaultPrevented, true, `${type} must suppress native browser gestures`);
}

assert.strictEqual(tag.listeners.get('touchstart')[0].options.passive, false);
assert.strictEqual(document.body.listeners.has('touchstart'), false);
assert.strictEqual(document.body.listeners.get('mousemove').length, 1);
emit('touchstart', [touch(10, 160, 360)]);
emit('touchend', [touch(10, 160, 360)]);
assert.deepStrictEqual(sent.map(message => message.action), [0, 1]);
assert.deepStrictEqual(sent.map(message => [message.position.point.x, message.position.point.y]), [[160, 360], [160, 360]]);
sent.forEach(message => assert(Buffer.isBuffer(message.toBuffer())));

sent.length = 0;
emit('touchstart', [touch(20, 100, 200)]);
emit('touchstart', [touch(21, 200, 200)]);
emit('touchmove', [touch(20, 90, 200), touch(21, 210, 200)]);
emit('touchend', [touch(20, 90, 200)]);
emit('touchcancel', [touch(21, 210, 200)]);
assert.deepStrictEqual(sent.map(message => message.action), [0, 0, 2, 2, 1, 1]);
assert.deepStrictEqual(sent.map(message => message.pointerId), [0, 1, 0, 1, 0, 1]);
assert.strictEqual(handler.storedFromTouchEvent.size, 0);

// A high-resolution stream displayed at a smaller CSS size must retain accurate
// tap and drag coordinates, including after rotation and with side/top margins.
sent.length = 0;
streamedSize = new Size(960, 2160);
Object.assign(tag, {clientWidth: 336, clientHeight: 756, left: 33, top: 30});
emit('touchstart', [touch(30, 201, 408)]);
emit('touchmove', [touch(30, 117, 219)]);
emit('touchend', [touch(30, 117, 219)]);
assert.deepStrictEqual(sent.map(message => [message.position.point.x, message.position.point.y]),
    [[480, 1080], [240, 540], [240, 540]]);
sent.forEach(message => {
    assert.strictEqual(message.position.screenSize.width, 960);
    assert.strictEqual(message.position.screenSize.height, 2160);
    assert(Buffer.isBuffer(message.toBuffer()));
});
sent.length = 0;
streamedSize = new Size(2160, 960);
Object.assign(tag, {clientWidth: 756, clientHeight: 336, left: 20, top: 8});
emit('touchstart', [touch(31, 398, 176)]);
emit('touchend', [touch(31, 398, 176)]);
assert.deepStrictEqual(sent.map(message => [message.position.point.x, message.position.point.y]),
    [[1080, 480], [1080, 480]]);

handler.release();
assert.strictEqual(tag.listeners.get('touchstart').length, 0);
assert.strictEqual(document.body.listeners.get('mousemove').length, 0);
const video = MsePlayer.createElement();
assert.strictEqual(video.playsInline, true);
assert('playsinline' in video.attributes);
assert('webkit-playsinline' in video.attributes);
console.log('Touch input: tap, move, multi-touch, scaled HD/rotated coordinates, cancellation, cleanup, inline playback passed.');
