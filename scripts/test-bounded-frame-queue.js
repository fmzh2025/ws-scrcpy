const assert = require('assert');

require('ts-node/register/transpile-only');

const { BoundedFrameQueue } = require('../src/app/player/BoundedFrameQueue');

const frame = (size, keyFrame = false) => {
    const value = new Uint8Array(size);
    value[0] = keyFrame ? 1 : 0;
    return value;
};

const queue = new BoundedFrameQueue(3, 10, (value) => value[0] === 1, (value) => (value[1] === 1 ? 7 : undefined));

assert.strictEqual(queue.push(frame(4)).accepted, true);
assert.strictEqual(queue.push(frame(4)).accepted, true);
const overflow = queue.push(frame(4));
assert.strictEqual(overflow.accepted, false);
assert.strictEqual(queue.length, 0);

assert.strictEqual(queue.push(frame(2)).accepted, false);
assert.strictEqual(queue.push(frame(4, true)).accepted, true);
assert.strictEqual(queue.length, 1);

queue.push(frame(2));
queue.push(frame(2));
const latestKeyFrame = queue.push(frame(4, true));
assert.strictEqual(latestKeyFrame.accepted, true);
assert.strictEqual(latestKeyFrame.dropped, 3);
assert.strictEqual(queue.length, 1);
assert.strictEqual(queue.shift()[0], 1);
assert.strictEqual(queue.length, 0);

const recoveryQueue = new BoundedFrameQueue(
    3,
    10,
    (value) => value[0] === 1,
    (value) => (value[1] === 1 ? 7 : undefined),
);
const parameterSet = frame(2);
parameterSet[1] = 1;
recoveryQueue.push(parameterSet);
recoveryQueue.push(frame(5));
assert.strictEqual(recoveryQueue.push(frame(5)).accepted, false);
assert.strictEqual(recoveryQueue.push(frame(4, true)).accepted, true);
assert.strictEqual(recoveryQueue.length, 2);
assert.strictEqual(recoveryQueue.shift()[1], 1);
assert.strictEqual(recoveryQueue.shift()[0], 1);

console.log('bounded frame queue tests passed');
