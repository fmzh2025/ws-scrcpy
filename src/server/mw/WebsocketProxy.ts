import { Mw, RequestParameters } from './Mw';
import WS from 'ws';
import { ACTION } from '../../common/Action';
import { Multiplexer } from '../../packages/multiplexer/Multiplexer';

type ProxyData = string | Buffer | ArrayBuffer | ArrayBufferView;

type VideoPacket = {
    data: ProxyData;
    bytes: number;
    isKeyFrame: boolean;
    hasParameterSet: boolean;
    receivedAt: number;
};

export type WebsocketProxyMetrics = {
    id: number;
    name: string;
    readyState: number;
    ageMs: number;
    lastPacketAgeMs?: number;
    queueDepth: number;
    queueBytes: number;
    maxQueueDepth: number;
    maxQueueBytes: number;
    bufferedAmount: number;
    maxBufferedAmount: number;
    receivedFrames: number;
    sentFrames: number;
    receivedBytes: number;
    sentBytes: number;
    droppedFrames: number;
    overflowCount: number;
    keyFrameRecoveryCount: number;
    sendLatencyMs?: number;
    maxSendLatencyMs: number;
    droppingUntilKeyFrame: boolean;
};

export class WebsocketProxy extends Mw {
    public static readonly TAG = 'WebsocketProxy';
    private static readonly instances = new Set<WebsocketProxy>();
    private static nextId = 1;
    private remoteSocket?: WS;
    private released = false;
    private storage: WS.MessageEvent[] = [];
    private readonly videoQueue: VideoPacket[] = [];
    private videoQueueBytes = 0;
    private videoDroppingUntilKeyFrame = false;
    private parameterSet?: VideoPacket;
    private videoFlushTimer?: NodeJS.Timeout;
    private readonly id = WebsocketProxy.nextId++;
    private readonly createdAt = Date.now();
    private lastPacketAt?: number;
    private queueMaxDepth = 0;
    private queueMaxBytes = 0;
    private currentBufferedAmount = 0;
    private maxBufferedAmount = 0;
    private receivedFrames = 0;
    private sentFrames = 0;
    private receivedBytes = 0;
    private sentBytes = 0;
    private droppedFrames = 0;
    private overflowCount = 0;
    private keyFrameRecoveryCount = 0;
    private lastSendLatencyMs?: number;
    private maxSendLatencyMs = 0;

    private static readonly VIDEO_HIGH_WATER_MARK = 2 * 1024 * 1024;
    private static readonly VIDEO_LOW_WATER_MARK = 512 * 1024;
    private static readonly VIDEO_QUEUE_MAX_FRAMES = 12;
    private static readonly VIDEO_QUEUE_MAX_BYTES = 4 * 1024 * 1024;

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    public static processRequest(ws: WS, params: RequestParameters): WebsocketProxy | undefined {
        const { action, url } = params;
        if (action !== ACTION.PROXY_WS) {
            return;
        }
        const wsString = url.searchParams.get('ws');
        if (!wsString) {
            ws.close(4003, `[${this.TAG}] Invalid value "${ws}" for "ws" parameter`);
            return;
        }
        return this.createProxy(ws, wsString);
    }

    public static createProxy(ws: WS | Multiplexer, remoteUrl: string): WebsocketProxy {
        const service = new WebsocketProxy(ws);
        service.init(remoteUrl).catch((e) => {
            const msg = `[${this.TAG}] Failed to start service: ${e.message}`;
            console.error(msg);
            ws.close(4005, msg);
        });
        return service;
    }

    constructor(ws: WS | Multiplexer) {
        super(ws);
        WebsocketProxy.instances.add(this);
    }

    public async init(remoteUrl: string): Promise<void> {
        this.name = `[${WebsocketProxy.TAG}{$${remoteUrl}}]`;
        const remoteSocket = new WS(remoteUrl);
        remoteSocket.onopen = () => {
            this.remoteSocket = remoteSocket;
            this.flush();
        };
        remoteSocket.onmessage = (event) => {
            if (this.ws && this.ws.readyState === this.ws.OPEN) {
                this.forwardRemoteData(event.data);
            }
        };
        remoteSocket.onclose = (e) => {
            if (this.ws.readyState === this.ws.OPEN) {
                this.ws.close(e.wasClean ? 1000 : 4010);
            }
        };
        remoteSocket.onerror = (e) => {
            if (this.ws.readyState === this.ws.OPEN) {
                this.ws.close(4011, e.message);
            }
        };
    }

    private flush(): void {
        if (this.remoteSocket) {
            while (this.storage.length) {
                const event = this.storage.shift();
                if (event && event.data) {
                    this.remoteSocket.send(event.data);
                }
            }
            if (this.released) {
                this.remoteSocket.close();
            }
        }
        this.storage.length = 0;
    }

    protected onSocketMessage(event: WS.MessageEvent): void {
        if (this.remoteSocket) {
            this.remoteSocket.send(event.data);
        } else {
            this.storage.push(event);
        }
    }

    private forwardRemoteData(data: ProxyData | ProxyData[]): void {
        if (Array.isArray(data)) {
            data.forEach((item) => this.forwardRemoteData(item));
            return;
        }
        const packet = this.toVideoPacket(data);
        if (!packet) {
            this.noteBufferedAmount();
            this.ws.send(data);
            this.noteBufferedAmount();
            return;
        }
        this.lastPacketAt = Date.now();
        this.receivedFrames++;
        this.receivedBytes += packet.bytes;
        this.noteBufferedAmount();
        this.forwardVideoPacket(packet);
    }

    private forwardVideoPacket(packet: VideoPacket): void {
        if (packet.hasParameterSet && !packet.isKeyFrame) {
            this.parameterSet = packet;
        }

        if (!this.videoQueue.length && this.currentBufferedAmount <= WebsocketProxy.VIDEO_HIGH_WATER_MARK) {
            this.sendVideoPacket(packet);
            return;
        }

        if (packet.isKeyFrame) {
            if (this.videoDroppingUntilKeyFrame) {
                this.keyFrameRecoveryCount++;
            }
            this.droppedFrames += this.videoQueue.length;
            this.clearVideoQueue();
            this.videoDroppingUntilKeyFrame = false;
            if (!packet.hasParameterSet && this.parameterSet) {
                this.pushVideoPacket(this.parameterSet);
            }
            this.pushVideoPacket(packet);
        } else if (!this.videoDroppingUntilKeyFrame) {
            this.pushVideoPacket(packet);
        } else {
            this.droppedFrames++;
        }

        this.flushVideoQueue();
        this.scheduleVideoFlush();
    }

    private pushVideoPacket(packet: VideoPacket): void {
        const wouldExceedLimit =
            this.videoQueue.length >= WebsocketProxy.VIDEO_QUEUE_MAX_FRAMES ||
            this.videoQueueBytes + packet.bytes > WebsocketProxy.VIDEO_QUEUE_MAX_BYTES;
        if (wouldExceedLimit && !packet.isKeyFrame) {
            this.overflowCount++;
            this.droppedFrames += this.videoQueue.length + 1;
            this.clearVideoQueue();
            this.videoDroppingUntilKeyFrame = true;
            return;
        }
        if (wouldExceedLimit && packet.isKeyFrame) {
            this.overflowCount++;
            this.droppedFrames += this.videoQueue.length;
            this.clearVideoQueue();
        }
        this.videoQueue.push(packet);
        this.videoQueueBytes += packet.bytes;
        this.queueMaxDepth = Math.max(this.queueMaxDepth, this.videoQueue.length);
        this.queueMaxBytes = Math.max(this.queueMaxBytes, this.videoQueueBytes);
    }

    private flushVideoQueue(): void {
        while (
            this.videoQueue.length &&
            this.ws.readyState === this.ws.OPEN &&
            this.currentBufferedAmount <= WebsocketProxy.VIDEO_LOW_WATER_MARK
        ) {
            const packet = this.videoQueue.shift();
            if (!packet) {
                break;
            }
            this.videoQueueBytes -= packet.bytes;
            this.sendVideoPacket(packet);
        }
    }

    private scheduleVideoFlush(): void {
        if (!this.videoQueue.length || this.videoFlushTimer) {
            return;
        }
        this.videoFlushTimer = setTimeout(() => {
            this.videoFlushTimer = undefined;
            if (this.ws.readyState !== this.ws.OPEN) {
                return;
            }
            this.flushVideoQueue();
            this.scheduleVideoFlush();
        }, 16);
    }

    private clearVideoQueue(): void {
        this.videoQueue.length = 0;
        this.videoQueueBytes = 0;
    }

    private sendVideoPacket(packet: VideoPacket): void {
        if (this.ws.readyState !== this.ws.OPEN) {
            return;
        }
        const sentAt = Date.now();
        this.ws.send(packet.data);
        this.sentFrames++;
        this.sentBytes += packet.bytes;
        this.lastSendLatencyMs = Math.max(0, sentAt - packet.receivedAt);
        this.maxSendLatencyMs = Math.max(this.maxSendLatencyMs, this.lastSendLatencyMs);
        this.noteBufferedAmount();
    }

    private noteBufferedAmount(): void {
        const socket = this.ws instanceof Multiplexer ? this.ws.ws : this.ws;
        const value = typeof socket.bufferedAmount === 'number' ? socket.bufferedAmount : 0;
        this.currentBufferedAmount = value;
        this.maxBufferedAmount = Math.max(this.maxBufferedAmount, value);
    }

    public static getMetrics(): WebsocketProxyMetrics[] {
        return Array.from(WebsocketProxy.instances, (proxy) => proxy.getMetrics());
    }

    private getMetrics(): WebsocketProxyMetrics {
        this.noteBufferedAmount();
        const now = Date.now();
        return {
            id: this.id,
            name: this.name,
            readyState: this.ws.readyState,
            ageMs: now - this.createdAt,
            lastPacketAgeMs: this.lastPacketAt === undefined ? undefined : now - this.lastPacketAt,
            queueDepth: this.videoQueue.length,
            queueBytes: this.videoQueueBytes,
            maxQueueDepth: this.queueMaxDepth,
            maxQueueBytes: this.queueMaxBytes,
            bufferedAmount: this.currentBufferedAmount,
            maxBufferedAmount: this.maxBufferedAmount,
            receivedFrames: this.receivedFrames,
            sentFrames: this.sentFrames,
            receivedBytes: this.receivedBytes,
            sentBytes: this.sentBytes,
            droppedFrames: this.droppedFrames,
            overflowCount: this.overflowCount,
            keyFrameRecoveryCount: this.keyFrameRecoveryCount,
            sendLatencyMs: this.lastSendLatencyMs,
            maxSendLatencyMs: this.maxSendLatencyMs,
            droppingUntilKeyFrame: this.videoDroppingUntilKeyFrame,
        };
    }

    private toVideoPacket(data: ProxyData): VideoPacket | undefined {
        const bytes = WebsocketProxy.toBytes(data);
        if (!bytes || bytes.byteLength < 5) {
            return;
        }
        let hasVideoNal = false;
        let isKeyFrame = false;
        let hasParameterSet = false;
        for (let index = 0; index + 3 < bytes.length; index++) {
            let headerIndex = -1;
            if (bytes[index] === 0 && bytes[index + 1] === 0 && bytes[index + 2] === 1) {
                headerIndex = index + 3;
            } else if (
                index + 4 < bytes.length &&
                bytes[index] === 0 &&
                bytes[index + 1] === 0 &&
                bytes[index + 2] === 0 &&
                bytes[index + 3] === 1
            ) {
                headerIndex = index + 4;
            }
            if (headerIndex < 0 || headerIndex >= bytes.length) {
                continue;
            }
            const type = bytes[headerIndex] & 31;
            if (type >= 1 && type <= 23) {
                hasVideoNal = true;
                isKeyFrame = isKeyFrame || type === 5;
                hasParameterSet = hasParameterSet || type === 7 || type === 8;
            }
        }
        if (!hasVideoNal) {
            return;
        }
        return { data, bytes: bytes.byteLength, isKeyFrame, hasParameterSet, receivedAt: Date.now() };
    }

    private static toBytes(data: ProxyData): Uint8Array | undefined {
        if (typeof data === 'string') {
            return;
        }
        if (Buffer.isBuffer(data)) {
            return data;
        }
        if (data instanceof ArrayBuffer) {
            return new Uint8Array(data);
        }
        if (ArrayBuffer.isView(data)) {
            return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
        }
        return;
    }

    public release(): void {
        if (this.released) {
            return;
        }
        super.release();
        this.released = true;
        if (this.videoFlushTimer) {
            clearTimeout(this.videoFlushTimer);
            this.videoFlushTimer = undefined;
        }
        this.clearVideoQueue();
        WebsocketProxy.instances.delete(this);
        this.flush();
    }

    protected get isReleased(): boolean {
        return this.released;
    }
}
