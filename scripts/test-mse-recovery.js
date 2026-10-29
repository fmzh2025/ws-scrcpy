const assert = require('assert');
require('ts-node/register/transpile-only');

global.window = { safari: undefined };
global.navigator = { userAgent: 'Chrome', platform: 'MacIntel' };

const { MsePlayer } = require('../src/app/player/MsePlayer');

let now = 0;
const realNow = Date.now;
Date.now = () => now;

const listeners = new Map();
const tag = {
    currentTime: 1,
    buffered: {
        length: 1,
        start: () => 0,
        end: () => 1.1,
    },
    addEventListener(name, listener) { listeners.set(name, listener); },
    removeEventListener(name) { listeners.delete(name); },
    play() { return Promise.resolve(); },
};
const player = {
    tag,
    name: 'MSE recovery test',
    momentumQualityStats: { decodedFrames: 1, droppedFrames: 0, inputFrames: 1, inputBytes: 1, timestamp: 0 },
    noDecodedFramesSince: -1,
    currentTimeNotChangedSince: -1,
    bigBufferSince: -1,
    aheadOfBufferSince: -1,
    lastTime: 1,
    seekingSince: -1,
    lastRecoveryLogAt: -1,
    MAX_TIME_TO_RECOVER: 200,
    MAX_SEEK_WAIT: 500,
    MAX_BUFFER: 0.25,
    MAX_AHEAD: -0.2,
    onSeekEnd: MsePlayer.prototype.onSeekEnd,
};

try {
    MsePlayer.prototype.checkForBadState.call(player);
    assert.strictEqual(player.currentTimeNotChangedSince, 0);
    now = 100;
    MsePlayer.prototype.checkForBadState.call(player);
    assert.strictEqual(player.currentTimeNotChangedSince, 0, 'A continuing stall must retain its original timestamp');
    now = 250;
    MsePlayer.prototype.checkForBadState.call(player);
    assert.strictEqual(tag.currentTime, 1.1, 'A stalled MSE clock with buffered video must seek to the live edge');
    assert.strictEqual(player.seekingSince, 250);
    assert(listeners.has('seeked'));
    console.log('MSE recovery: persistent stall timing and live-edge seek pass.');
} finally {
    Date.now = realNow;
}
