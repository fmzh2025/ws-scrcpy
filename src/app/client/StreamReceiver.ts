import { ManagerClient } from './ManagerClient';
import { ControlMessage } from '../controlMessage/ControlMessage';
import DeviceMessage from '../googDevice/DeviceMessage';
import VideoSettings from '../VideoSettings';
import ScreenInfo from '../ScreenInfo';
import Util from '../Util';
import { DisplayInfo } from '../DisplayInfo';
import { ParamsStream } from '../../types/ParamsStream';
import { TouchDiagnostics } from '../interactionHandler/TouchDiagnostics';
import { TouchControlMessage } from '../controlMessage/TouchControlMessage';
import { KeyCodeControlMessage } from '../controlMessage/KeyCodeControlMessage';

const DEVICE_NAME_FIELD_LENGTH = 64;
const MAGIC_BYTES_INITIAL = Util.stringToUtf8ByteArray('scrcpy_initial');
const CONNECTION_WATCHDOG_INTERVAL_MS = 5_000;
const CONNECTION_OPEN_TIMEOUT_MS = 12_000;
const SCROLL_LOG_INTERVAL_MS = 1_000;

export type ClientsStats = {
    deviceName: string;
    clientId: number;
};

export type DisplayCombinedInfo = {
    displayInfo: DisplayInfo;
    videoSettings?: VideoSettings;
    screenInfo?: ScreenInfo;
    connectionCount: number;
};

interface StreamReceiverEvents {
    video: ArrayBuffer;
    deviceMessage: DeviceMessage;
    displayInfo: DisplayCombinedInfo[];
    clientsStats: ClientsStats;
    encoders: string[];
    connected: void;
    disconnected: CloseEvent;
}

const TAG = '[StreamReceiver]';

export class StreamReceiver<P extends ParamsStream> extends ManagerClient<ParamsStream, StreamReceiverEvents> {
    private events: ControlMessage[] = [];
    private encodersSet: Set<string> = new Set<string>();
    private clientId = -1;
    private deviceName = '';
    private readonly displayInfoMap: Map<number, DisplayInfo> = new Map();
    private readonly connectionCountMap: Map<number, number> = new Map();
    private readonly screenInfoMap: Map<number, ScreenInfo> = new Map();
    private readonly videoSettingsMap: Map<number, VideoSettings> = new Map();
    private hasInitialInfo = false;
    private reconnectTimer?: number;
    private reconnectAttempts = 0;
    private stopped = false;
    private suspended = false;
    private connected = false;
    private connectionStartedAt?: number;
    private connectionWatchdog?: number;
    private lastScrollLogAt = 0;
    private reconnectOnResume = false;

    constructor(params: P) {
        super(params);
        this.suspended = document.hidden;
        document.addEventListener('visibilitychange', this.onVisibilityChange);
        window.addEventListener('focus', this.onPageResume);
        window.addEventListener('blur', this.onPageBlur);
        window.addEventListener('pageshow', this.onPageResume);
        window.addEventListener('online', this.onNetworkOnline);
        this.connectionWatchdog = window.setInterval(this.checkConnection, CONNECTION_WATCHDOG_INTERVAL_MS);
        if (!this.suspended) {
            this.openConnection('initial');
        }
    }

    private openConnection(reason: string): void {
        if (this.stopped || this.suspended || document.hidden) {
            return;
        }
        this.clearReconnectTimer();
        if (this.connected) {
            this.notifyDisconnected(this.createCloseEvent(`Replacing stale connection: ${reason}`));
        }
        this.connectionStartedAt = Date.now();
        console.info(`${TAG} opening udid=${this.params.udid} reason=${reason} attempt=${this.reconnectAttempts + 1}`);
        try {
            const ws = this.openNewConnection();
            ws.binaryType = 'arraybuffer';
        } catch (error) {
            this.connectionStartedAt = undefined;
            const detail = error instanceof Error ? error.message : String(error);
            console.error(`${TAG} open failed udid=${this.params.udid}: ${detail}`);
            this.scheduleReconnect('open-failed');
        }
    }

    private ensureConnection(reason: string, immediate = false): void {
        if (this.stopped || this.suspended || document.hidden) {
            return;
        }
        const ws = this.ws;
        if (ws && ws.readyState === ws.OPEN) {
            return;
        }
        if (ws && ws.readyState === ws.CONNECTING) {
            const age = this.connectionStartedAt === undefined ? Infinity : Date.now() - this.connectionStartedAt;
            if (age < CONNECTION_OPEN_TIMEOUT_MS) {
                return;
            }
            console.warn(`${TAG} reconnect udid=${this.params.udid} reason=connecting-timeout ageMs=${age}`);
            this.openConnection('connecting-timeout');
            return;
        }
        if (this.reconnectTimer) {
            if (!immediate) {
                return;
            }
            this.clearReconnectTimer();
        }
        this.openConnection(reason);
    }

    private scheduleReconnect(reason: string): void {
        if (this.stopped || this.suspended || this.reconnectTimer) {
            return;
        }
        const delay = Math.min(10_000, 1_000 * 2 ** this.reconnectAttempts++);
        console.warn(`${TAG} reconnect scheduled udid=${this.params.udid} reason=${reason} delayMs=${delay}`);
        this.reconnectTimer = window.setTimeout(() => {
            this.reconnectTimer = undefined;
            this.ensureConnection(`retry-${reason}`, true);
        }, delay);
    }

    private clearReconnectTimer(): void {
        if (this.reconnectTimer) {
            window.clearTimeout(this.reconnectTimer);
            this.reconnectTimer = undefined;
        }
    }

    private createCloseEvent(reason: string): CloseEvent {
        return new CloseEvent('close', { code: 4000, reason });
    }

    private notifyDisconnected(event: CloseEvent): void {
        if (!this.connected) {
            return;
        }
        this.connected = false;
        this.emit('disconnected', event);
    }

    private handleInitialInfo(data: ArrayBuffer): void {
        let offset = MAGIC_BYTES_INITIAL.length;
        let nameBytes = new Uint8Array(data, offset, DEVICE_NAME_FIELD_LENGTH);
        offset += DEVICE_NAME_FIELD_LENGTH;
        let rest: Buffer = Buffer.from(new Uint8Array(data, offset));
        const displaysCount = rest.readInt32BE(0);
        this.displayInfoMap.clear();
        this.connectionCountMap.clear();
        this.screenInfoMap.clear();
        this.videoSettingsMap.clear();
        rest = rest.slice(4);
        for (let i = 0; i < displaysCount; i++) {
            const displayInfoBuffer = rest.slice(0, DisplayInfo.BUFFER_LENGTH);
            const displayInfo = DisplayInfo.fromBuffer(displayInfoBuffer);
            const { displayId } = displayInfo;
            this.displayInfoMap.set(displayId, displayInfo);
            rest = rest.slice(DisplayInfo.BUFFER_LENGTH);
            this.connectionCountMap.set(displayId, rest.readInt32BE(0));
            rest = rest.slice(4);
            const screenInfoBytesCount = rest.readInt32BE(0);
            rest = rest.slice(4);
            if (screenInfoBytesCount) {
                this.screenInfoMap.set(displayId, ScreenInfo.fromBuffer(rest.slice(0, screenInfoBytesCount)));
                rest = rest.slice(screenInfoBytesCount);
            }
            const videoSettingsBytesCount = rest.readInt32BE(0);
            rest = rest.slice(4);
            if (videoSettingsBytesCount) {
                this.videoSettingsMap.set(displayId, VideoSettings.fromBuffer(rest.slice(0, videoSettingsBytesCount)));
                rest = rest.slice(videoSettingsBytesCount);
            }
        }
        this.encodersSet.clear();
        const encodersCount = rest.readInt32BE(0);
        rest = rest.slice(4);
        for (let i = 0; i < encodersCount; i++) {
            const nameLength = rest.readInt32BE(0);
            rest = rest.slice(4);
            const nameBytes = rest.slice(0, nameLength);
            rest = rest.slice(nameLength);
            const name = Util.utf8ByteArrayToString(nameBytes);
            this.encodersSet.add(name);
        }
        this.clientId = rest.readInt32BE(0);
        nameBytes = Util.filterTrailingZeroes(nameBytes);
        this.deviceName = Util.utf8ByteArrayToString(nameBytes);
        this.hasInitialInfo = true;
        this.triggerInitialInfoEvents();
    }

    private static EqualArrays(a: ArrayLike<number>, b: ArrayLike<number>): boolean {
        if (a.length !== b.length) {
            return false;
        }
        for (let i = 0, l = a.length; i < l; i++) {
            if (a[i] !== b[i]) {
                return false;
            }
        }
        return true;
    }

    protected buildDirectWebSocketUrl(): URL {
        const localUrl = super.buildDirectWebSocketUrl();
        if (this.supportMultiplexing()) {
            return localUrl;
        }
        localUrl.searchParams.set('udid', this.params.udid);
        return localUrl;
    }

    protected onSocketClose(ev: CloseEvent): void {
        this.connectionStartedAt = undefined;
        console.warn(`${TAG} disconnected udid=${this.params.udid} code=${ev.code} reason=${ev.reason || 'none'}`);
        this.notifyDisconnected(ev);
        this.scheduleReconnect('socket-close');
    }

    protected onSocketMessage(event: MessageEvent): void {
        if (event.data instanceof ArrayBuffer) {
            // works only because MAGIC_BYTES_INITIAL and MAGIC_BYTES_MESSAGE have same length
            if (event.data.byteLength > MAGIC_BYTES_INITIAL.length) {
                const magicBytes = new Uint8Array(event.data, 0, MAGIC_BYTES_INITIAL.length);
                if (StreamReceiver.EqualArrays(magicBytes, MAGIC_BYTES_INITIAL)) {
                    this.handleInitialInfo(event.data);
                    return;
                }
                if (StreamReceiver.EqualArrays(magicBytes, DeviceMessage.MAGIC_BYTES_MESSAGE)) {
                    const message = DeviceMessage.fromBuffer(event.data);
                    this.emit('deviceMessage', message);
                    return;
                }
            }

            this.emit('video', new Uint8Array(event.data));
        }
    }

    protected onSocketOpen(): void {
        this.connectionStartedAt = undefined;
        this.reconnectAttempts = 0;
        this.connected = true;
        console.info(`${TAG} connected udid=${this.params.udid}`);
        this.emit('connected', void 0);
        let e = this.events.shift();
        while (e) {
            if (!this.sendControlMessage(e)) {
                this.events.unshift(e);
                break;
            }
            e = this.events.shift();
        }
    }

    public sendEvent(event: ControlMessage): void {
        const isConnected = !!(this.ws && this.ws.readyState === this.ws.OPEN);
        this.logOperation(event, isConnected);
        if (!isConnected || !this.sendControlMessage(event)) {
            this.events.push(event);
            TouchDiagnostics.sent(event, false);
            this.ensureConnection('control-event', true);
        }
    }

    private sendControlMessage(event: ControlMessage): boolean {
        const ws = this.ws;
        if (!ws || ws.readyState !== ws.OPEN) {
            return false;
        }
        try {
            ws.send(event.toBuffer());
            TouchDiagnostics.sent(event, true);
            return true;
        } catch (error) {
            TouchDiagnostics.failed(event, error);
            const detail = error instanceof Error ? error.message : String(error);
            console.error(`${TAG} control send failed udid=${this.params.udid}: ${detail}`);
            if (ws.readyState !== ws.CLOSING && ws.readyState !== ws.CLOSED) {
                ws.close(4001, 'control-send-failed');
            }
            return false;
        }
    }

    private logOperation(event: ControlMessage, isConnected: boolean): void {
        const connection = isConnected ? 'sent' : 'queued';
        if (event.type === ControlMessage.TYPE_TOUCH) {
            const touch = event as TouchControlMessage;
            const action = touch.action === 0 ? 'down' : touch.action === 1 ? 'up' : touch.action === 3 ? 'cancel' : '';
            if (action) {
                const { point } = touch.position;
                console.info(
                    `[CloudPhoneOperation] touch-${action} x=${Math.round(point.x)} y=${Math.round(
                        point.y,
                    )} connection=${connection}`,
                );
            }
            return;
        }
        if (event.type === ControlMessage.TYPE_KEYCODE) {
            const key = event as KeyCodeControlMessage;
            console.info(
                `[CloudPhoneOperation] key-${
                    key.action === 0 ? 'down' : 'up'
                } connection=${connection} content=redacted`,
            );
            return;
        }
        if (event.type === ControlMessage.TYPE_SCROLL) {
            const now = Date.now();
            if (now - this.lastScrollLogAt >= SCROLL_LOG_INTERVAL_MS) {
                this.lastScrollLogAt = now;
                console.info(`[CloudPhoneOperation] scroll connection=${connection}`);
            }
            return;
        }
        const operationNames: Record<number, string> = {
            [ControlMessage.TYPE_TEXT]: 'text-input content=redacted',
            [ControlMessage.TYPE_BACK_OR_SCREEN_ON]: 'back-or-screen-on',
            [ControlMessage.TYPE_EXPAND_NOTIFICATION_PANEL]: 'expand-notifications',
            [ControlMessage.TYPE_EXPAND_SETTINGS_PANEL]: 'expand-settings',
            [ControlMessage.TYPE_COLLAPSE_PANELS]: 'collapse-panels',
            [ControlMessage.TYPE_GET_CLIPBOARD]: 'get-clipboard content=redacted',
            [ControlMessage.TYPE_SET_CLIPBOARD]: 'set-clipboard content=redacted',
            [ControlMessage.TYPE_SET_SCREEN_POWER_MODE]: 'screen-power',
            [ControlMessage.TYPE_ROTATE_DEVICE]: 'rotate-device',
        };
        const name = operationNames[event.type];
        if (name) {
            console.info(`[CloudPhoneOperation] ${name} connection=${connection}`);
        }
    }

    public stop(): void {
        this.stopped = true;
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        window.removeEventListener('focus', this.onPageResume);
        window.removeEventListener('blur', this.onPageBlur);
        window.removeEventListener('pageshow', this.onPageResume);
        window.removeEventListener('online', this.onNetworkOnline);
        this.clearReconnectTimer();
        if (this.connectionWatchdog) {
            window.clearInterval(this.connectionWatchdog);
            this.connectionWatchdog = undefined;
        }
        if (this.ws && this.ws.readyState !== this.ws.CLOSED && this.ws.readyState !== this.ws.CLOSING) {
            this.ws.close(1000, 'stream-stopped');
        }
        this.events.length = 0;
    }

    private onVisibilityChange = (): void => {
        if (this.stopped) {
            return;
        }
        if (document.hidden) {
            this.suspendConnection('page-hidden');
            return;
        }
        this.resumeConnection('page-visible');
    };

    private onPageResume = (): void => {
        if (this.stopped || document.hidden) {
            return;
        }
        this.resumeConnection('page-resume');
    };

    private onPageBlur = (): void => {
        if (!this.stopped) {
            this.suspendConnection('page-blur');
        }
    };

    private suspendConnection(reason: string): void {
        this.suspended = true;
        this.reconnectOnResume = true;
        this.clearReconnectTimer();
        console.info(`${TAG} suspended udid=${this.params.udid} reason=${reason}`);
        if (this.ws && this.ws.readyState !== this.ws.CLOSED && this.ws.readyState !== this.ws.CLOSING) {
            this.ws.close(1000, reason);
        }
    }

    private resumeConnection(reason: string): void {
        const mustReplaceConnection = this.reconnectOnResume;
        this.suspended = false;
        this.reconnectOnResume = false;
        this.reconnectAttempts = 0;
        if (mustReplaceConnection) {
            // Some embedded browsers omit visibilitychange and retain a stale
            // OPEN state. Always create a fresh socket after a real blur/return.
            this.openConnection(reason);
        } else {
            this.ensureConnection(reason, true);
        }
    }

    private onNetworkOnline = (): void => {
        this.ensureConnection('browser-online', true);
    };

    private checkConnection = (): void => {
        this.ensureConnection('watchdog');
    };

    public getEncoders(): string[] {
        return Array.from(this.encodersSet.values());
    }

    public getDeviceName(): string {
        return this.deviceName;
    }

    public triggerInitialInfoEvents(): void {
        if (this.hasInitialInfo) {
            const encoders = this.getEncoders();
            this.emit('encoders', encoders);
            const { clientId, deviceName } = this;
            this.emit('clientsStats', { clientId, deviceName });
            const infoArray: DisplayCombinedInfo[] = [];
            this.displayInfoMap.forEach((displayInfo: DisplayInfo, displayId: number) => {
                const connectionCount = this.connectionCountMap.get(displayId) || 0;
                infoArray.push({
                    displayInfo,
                    videoSettings: this.videoSettingsMap.get(displayId),
                    screenInfo: this.screenInfoMap.get(displayId),
                    connectionCount,
                });
            });
            this.emit('displayInfo', infoArray);
        }
    }

    public getDisplayInfo(displayId: number): DisplayInfo | undefined {
        return this.displayInfoMap.get(displayId);
    }
}
