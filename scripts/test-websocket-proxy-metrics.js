const assert = require('assert');

require('ts-node/register/transpile-only');

const { WebsocketProxy } = require('../src/server/mw/WebsocketProxy');

class FakeSocket {
    CONNECTING = 0;
    OPEN = 1;
    CLOSING = 2;
    CLOSED = 3;
    readyState = this.OPEN;
    bufferedAmount = 0;
    sent = [];
    listeners = new Map();

    addEventListener(type, listener) {
        this.listeners.set(type, listener);
    }

    removeEventListener(type) {
        this.listeners.delete(type);
    }

    send(data) {
        this.sent.push(data);
        this.bufferedAmount += Buffer.byteLength(data);
    }

    close() {
        this.readyState = this.CLOSED;
    }
}

const videoFrame = (bytes, keyFrame) => {
    const frame = Buffer.alloc(bytes);
    frame.writeUInt32BE(1, 0);
    frame[4] = keyFrame ? 5 : 1;
    return frame;
};

const socket = new FakeSocket();
const proxy = new WebsocketProxy(socket);
const forward = (frame) => proxy.forwardRemoteData(frame);

forward(videoFrame(3 * 1024 * 1024, true));
for (let i = 0; i < 12; i++) {
    forward(videoFrame(400 * 1024, false));
}

let metrics = WebsocketProxy.getMetrics()[0];
assert.strictEqual(metrics.overflowCount, 1);
assert(metrics.droppedFrames >= 1);
assert.strictEqual(metrics.droppingUntilKeyFrame, true);
assert(metrics.maxQueueBytes <= 4 * 1024 * 1024);

forward(videoFrame(1024, true));
metrics = WebsocketProxy.getMetrics()[0];
assert.strictEqual(metrics.keyFrameRecoveryCount, 1);
assert.strictEqual(metrics.droppingUntilKeyFrame, false);
assert(metrics.maxBufferedAmount > 2 * 1024 * 1024);

proxy.release();
console.log('websocket proxy metrics tests passed');
