const assert = require('assert');
require('ts-node/register/transpile-only');
const {TouchControlMessage} = require('../src/app/controlMessage/TouchControlMessage');
const Position = require('../src/app/Position').default;
const Point = require('../src/app/Point').default;
const Size = require('../src/app/Size').default;
const NativeBuffer = global.Buffer;
const BrowserBuffer = require('buffer/').Buffer;
const position = new Position(new Point(130, 386), new Size(208, 480));

try {
    for (const impl of [NativeBuffer, BrowserBuffer]) {
        global.Buffer = impl;
        for (const [pressure, expected] of [
            [0, 0], [0.5, 32768], [1, 65535], [1.01, 65535], [1.5, 65535],
            [-0.1, 0], [NaN, 0], [Infinity, 0],
        ]) {
            // A failed DOWN with a valid UP reproduces the half-sent tap symptom.
            const down = new TouchControlMessage(0, 0, position, pressure, 1).toBuffer();
            const up = new TouchControlMessage(1, 0, position, 0, 1).toBuffer();
            assert.strictEqual(down.length, 29);
            assert.strictEqual(down.readUInt8(1), 0);
            assert.strictEqual(up.readUInt8(1), 1);
            assert.strictEqual(down.readUInt16BE(22), expected, `pressure ${pressure}`);
            assert.strictEqual(up.readUInt16BE(22), 0);
            assert.strictEqual(down.readUInt32BE(10), 130);
            assert.strictEqual(down.readUInt32BE(14), 386);
            assert.strictEqual(down.readUInt16BE(18), 208);
            assert.strictEqual(down.readUInt16BE(20), 480);
        }
    }
} finally {
    global.Buffer = NativeBuffer;
}
console.log('Touch pressure: DOWN/UP serialization and range encoding pass with Node and browser Buffer.');
