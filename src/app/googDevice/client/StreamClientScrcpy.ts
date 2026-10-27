import { BaseClient } from '../../client/BaseClient';
import { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import { GoogMoreBox } from '../toolbox/GoogMoreBox';
import { GoogToolBox } from '../toolbox/GoogToolBox';
import VideoSettings from '../../VideoSettings';
import Size from '../../Size';
import { ControlMessage } from '../../controlMessage/ControlMessage';
import { ClientsStats, DisplayCombinedInfo } from '../../client/StreamReceiver';
import { CommandControlMessage } from '../../controlMessage/CommandControlMessage';
import Util from '../../Util';
import FilePushHandler from '../filePush/FilePushHandler';
import DragAndPushLogger from '../DragAndPushLogger';
import { KeyEventListener, KeyInputHandler } from '../KeyInputHandler';
import { KeyCodeControlMessage } from '../../controlMessage/KeyCodeControlMessage';
import { BasePlayer, PlayerClass } from '../../player/BasePlayer';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { ConfigureScrcpy } from './ConfigureScrcpy';
import { DeviceTracker } from './DeviceTracker';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { html } from '../../ui/HtmlTag';
import {
    FeaturedInteractionHandler,
    InteractionHandlerListener,
} from '../../interactionHandler/FeaturedInteractionHandler';
import DeviceMessage from '../DeviceMessage';
import { DisplayInfo } from '../../DisplayInfo';
import { Attribute } from '../../Attribute';
import { HostTracker } from '../../client/HostTracker';
import { ACTION } from '../../../common/Action';
import { StreamReceiverScrcpy } from './StreamReceiverScrcpy';
import { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import { ScrcpyFilePushStream } from '../filePush/ScrcpyFilePushStream';
import { InlineKeyboardOverlay } from '../InlineKeyboardOverlay';
import { AdbOverlay } from './AdbOverlay';
import { NetworkControlPanel } from './NetworkControlPanel';
import { DeviceState } from '../../../common/DeviceState';
import { TouchDiagnostics } from '../../interactionHandler/TouchDiagnostics';
import { MobileStreamView } from './MobileStreamView';

type StartParams = {
    udid: string;
    playerName?: string;
    player?: BasePlayer;
    fitToScreen?: boolean;
    videoSettings?: VideoSettings;
};

const TAG = '[StreamClientScrcpy]';

export class StreamClientScrcpy
    extends BaseClient<ParamsStreamScrcpy, never>
    implements KeyEventListener, InteractionHandlerListener
{
    public static ACTION = 'stream';
    private static players: Map<string, PlayerClass> = new Map<string, PlayerClass>();

    private controlButtons?: HTMLElement;
    private deviceName = '';
    private clientId = -1;
    private clientsCount = -1;
    private joinedStream = false;
    private requestedVideoSettings?: VideoSettings;
    private desiredVideoSettings?: VideoSettings;
    private touchHandler?: FeaturedInteractionHandler;
    private moreBox?: GoogMoreBox;
    private player?: BasePlayer;
    private filePushHandler?: FilePushHandler;
    private fitToScreen?: boolean;
    private videoResizeCleanup?: () => void;
    private videoPresentationCleanup?: () => void;
    private videoElement?: HTMLElement;
    private pasteStatusTimeout?: number;
    private inlineKeyboard?: InlineKeyboardOverlay;
    private adbOverlay?: AdbOverlay;
    private networkPanel?: NetworkControlPanel;
    private touchDiagnostics?: TouchDiagnostics;
    private mobileView?: MobileStreamView;
    private changingDisplay = false;
    private resumePlayerOnConnect = false;
    private readonly streamReceiver: StreamReceiverScrcpy;

    public static registerPlayer(playerClass: PlayerClass): void {
        if (playerClass.isSupported()) {
            this.players.set(playerClass.playerFullName, playerClass);
        }
    }

    public static getPlayers(): PlayerClass[] {
        return Array.from(this.players.values());
    }

    private static getPlayerClass(playerName: string): PlayerClass | undefined {
        let playerClass: PlayerClass | undefined;
        for (const value of StreamClientScrcpy.players.values()) {
            if (value.playerFullName === playerName || value.playerCodeName === playerName) {
                playerClass = value;
            }
        }
        return playerClass;
    }

    public static createPlayer(playerName: string, udid: string, displayInfo?: DisplayInfo): BasePlayer | undefined {
        const playerClass = this.getPlayerClass(playerName);
        if (!playerClass) {
            return;
        }
        return new playerClass(udid, displayInfo);
    }

    public static getFitToScreen(playerName: string, udid: string, displayInfo?: DisplayInfo): boolean {
        const playerClass = this.getPlayerClass(playerName);
        if (!playerClass) {
            return false;
        }
        return playerClass.getFitToScreenStatus(udid, displayInfo);
    }

    public static start(
        query: URLSearchParams | ParamsStreamScrcpy,
        streamReceiver?: StreamReceiverScrcpy,
        player?: BasePlayer,
        fitToScreen?: boolean,
        videoSettings?: VideoSettings,
    ): StreamClientScrcpy {
        if (query instanceof URLSearchParams) {
            const params = StreamClientScrcpy.parseParameters(query);
            return new StreamClientScrcpy(params, streamReceiver, player, fitToScreen, videoSettings);
        } else {
            return new StreamClientScrcpy(query, streamReceiver, player, fitToScreen, videoSettings);
        }
    }

    private static createVideoSettingsWithBounds(old: VideoSettings, newBounds: Size): VideoSettings {
        return new VideoSettings({
            crop: old.crop,
            bitrate: old.bitrate,
            bounds: newBounds,
            maxFps: old.maxFps,
            iFrameInterval: old.iFrameInterval,
            sendFrameMeta: old.sendFrameMeta,
            lockedVideoOrientation: old.lockedVideoOrientation,
            displayId: old.displayId,
            codecOptions: old.codecOptions,
            encoderName: old.encoderName,
        });
    }

    protected constructor(
        params: ParamsStreamScrcpy,
        streamReceiver?: StreamReceiverScrcpy,
        player?: BasePlayer,
        fitToScreen?: boolean,
        videoSettings?: VideoSettings,
    ) {
        super(params);
        if (streamReceiver) {
            this.streamReceiver = streamReceiver;
        } else {
            this.streamReceiver = new StreamReceiverScrcpy(this.params);
        }

        const { udid, player: playerName } = this.params;
        this.startStream({ udid, player, playerName, fitToScreen, videoSettings });
        this.setBodyClass('stream');
    }

    public static parseParameters(params: URLSearchParams): ParamsStreamScrcpy {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.STREAM_SCRCPY) {
            throw Error('Incorrect action');
        }
        return {
            ...typedParams,
            action,
            player: Util.parseString(params, 'player', true),
            udid: Util.parseString(params, 'udid', true),
            ws: Util.parseString(params, 'ws'),
            captureKeyboard: Util.parseBoolean(params, 'captureKeyboard', false),
        };
    }

    public OnDeviceMessage = (message: DeviceMessage): void => {
        if (this.moreBox) {
            this.moreBox.OnDeviceMessage(message);
        }
    };

    public onVideo = (data: ArrayBuffer): void => {
        if (!this.player) {
            return;
        }
        const STATE = BasePlayer.STATE;
        if (this.player.getState() === STATE.PAUSED) {
            this.player.play();
        }
        if (this.player.getState() === STATE.PLAYING) {
            this.player.pushFrame(new Uint8Array(data));
        }
    };

    public onClientsStats = (stats: ClientsStats): void => {
        this.deviceName = stats.deviceName;
        this.clientId = stats.clientId;
        this.setTitle(`Stream ${this.deviceName} · ${this.params.udid}`);
    };

    public onDisplayInfo = (infoArray: DisplayCombinedInfo[]): void => {
        if (!this.player) {
            return;
        }
        let desiredSettings = VideoSettings.copy(this.desiredVideoSettings || this.player.getVideoSettings());
        const displayId = desiredSettings.displayId;
        const info = infoArray.find((value) => {
            return value.displayInfo.displayId === displayId;
        });
        if (!info) {
            return;
        }
        if (this.player.getState() === BasePlayer.STATE.PAUSED) {
            this.player.play();
        }
        const { videoSettings, screenInfo } = info;
        this.player.setDisplayInfo(info.displayInfo);
        if (typeof this.fitToScreen !== 'boolean') {
            this.fitToScreen = this.player.getFitToScreenStatus();
        }
        if (this.fitToScreen) {
            const newBounds = this.getMaxSize();
            if (newBounds) {
                desiredSettings = StreamClientScrcpy.createVideoSettingsWithBounds(desiredSettings, newBounds);
                this.desiredVideoSettings = VideoSettings.copy(desiredSettings);
                this.player.setVideoSettings(desiredSettings, this.fitToScreen, false);
            }
        }
        if (!videoSettings || !screenInfo) {
            this.joinedStream = true;
            this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(desiredSettings));
            return;
        }

        this.clientsCount = info.connectionCount;
        let min = VideoSettings.copy(videoSettings);
        const oldInfo = this.player.getStreamScreenInfo();
        if (!screenInfo.equals(oldInfo)) {
            this.player.setStreamScreenInfo(screenInfo);
        }

        if (videoSettings.equals(desiredSettings)) {
            this.applyNewVideoSettings(videoSettings, videoSettings.equals(this.requestedVideoSettings));
        } else {
            const source = `${screenInfo.videoSize.width}x${screenInfo.videoSize.height}`;
            const requested = desiredSettings.bounds
                ? `${desiredSettings.bounds.width}x${desiredSettings.bounds.height}`
                : 'original';
            console.warn(
                `${TAG} source size differs from requested bounds udid=${this.params.udid} source=${source} requested=${requested}`,
            );
        }

        const bounds = desiredSettings.bounds;
        const videoSize: Size = screenInfo.videoSize;
        const onlyOneClient = this.clientsCount === 0;
        const smallerThenCurrent = bounds && (bounds.width < videoSize.width || bounds.height < videoSize.height);
        if (onlyOneClient || smallerThenCurrent || this.mobileView) {
            // Reapply this client's requested bounds after every reconnect. The
            // shared scrcpy server may briefly report its full-resolution default.
            min = desiredSettings;
        }
        const minBounds = desiredSettings.bounds?.intersect(min.bounds);
        if (minBounds && !minBounds.equals(min.bounds)) {
            min = StreamClientScrcpy.createVideoSettingsWithBounds(min, minBounds);
        }
        if (!min.equals(videoSettings) || !this.joinedStream) {
            this.joinedStream = true;
            console.info(
                `${TAG} applying video settings udid=${this.params.udid} bounds=${
                    min.bounds ? `${min.bounds.width}x${min.bounds.height}` : 'original'
                } clients=${this.clientsCount}`,
            );
            this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(min));
        }
    };

    public onDisconnected = (): void => {
        this.joinedStream = false;
        this.resumePlayerOnConnect = true;
        // A reconnected H.264 stream starts a new decoder timeline. Keeping the
        // previous MSE converter alive can leave the video parked on its last
        // decoded frame even though the replacement WebSocket is receiving data.
        this.player?.pause();
        if (this.changingDisplay) {
            // Display-profile changes deliberately rebuild the encoder. Keep the
            // controls alive while the page waits for the replacement stream.
            return;
        }
        // Keep controls and listeners alive while StreamReceiver reconnects.
        console.warn(TAG, 'Stream disconnected; waiting for transport reconnect');
    };

    public onConnected = (): void => {
        if (!this.resumePlayerOnConnect) {
            return;
        }
        this.resumePlayerOnConnect = false;
        // MsePlayer.play() creates a fresh MediaSource/converter after pause().
        // Other players simply resume and wait for the next decodable frame.
        this.player?.play();
    };

    public startStream({ udid, player, playerName, videoSettings, fitToScreen }: StartParams): void {
        if (!udid) {
            throw Error(`Invalid udid value: "${udid}"`);
        }

        this.fitToScreen = fitToScreen;
        if (!player) {
            if (typeof playerName !== 'string') {
                throw Error('Must provide BasePlayer instance or playerName');
            }
            let displayInfo: DisplayInfo | undefined;
            if (this.streamReceiver && videoSettings) {
                displayInfo = this.streamReceiver.getDisplayInfo(videoSettings.displayId);
            }
            const p = StreamClientScrcpy.createPlayer(playerName, udid, displayInfo);
            if (!p) {
                throw Error(`Unsupported player: "${playerName}"`);
            }
            if (typeof fitToScreen !== 'boolean') {
                fitToScreen = StreamClientScrcpy.getFitToScreen(playerName, udid, displayInfo);
            }
            player = p;
        }
        this.player = player;
        const mobile = MobileStreamView.isEnabled();
        if (mobile) {
            this.fitToScreen = fitToScreen = false;
        }
        this.setTouchListeners(player);

        if (!videoSettings) {
            videoSettings = player.getVideoSettings();
        }
        if (mobile) {
            videoSettings = MobileStreamView.createVideoSettings(videoSettings);
        }

        const deviceView = document.createElement('div');
        deviceView.className = 'device-view';
        const stop = (ev?: string | Event) => {
            if (ev && ev instanceof Event && ev.type === 'error') {
                console.error(TAG, ev);
            }
            let parent;
            parent = deviceView.parentElement;
            if (parent) {
                parent.removeChild(deviceView);
            }
            parent = moreBox.parentElement;
            if (parent) {
                parent.removeChild(moreBox);
            }
            this.streamReceiver.off('connected', this.onConnected);
            this.streamReceiver.off('deviceMessage', this.OnDeviceMessage);
            this.streamReceiver.off('video', this.onVideo);
            this.streamReceiver.off('clientsStats', this.onClientsStats);
            this.streamReceiver.off('displayInfo', this.onDisplayInfo);
            this.streamReceiver.off('disconnected', this.onDisconnected);
            this.streamReceiver.stop();
            if (this.player) {
                this.player.stop();
            }
            this.videoResizeCleanup?.();
            this.videoResizeCleanup = undefined;
            this.videoPresentationCleanup?.();
            this.videoPresentationCleanup = undefined;
            this.videoElement = undefined;
            this.inlineKeyboard?.release();
            this.inlineKeyboard = undefined;
            this.adbOverlay?.release();
            this.adbOverlay = undefined;
            this.networkPanel?.release();
            this.networkPanel = undefined;
            this.touchDiagnostics?.release();
            this.touchDiagnostics = undefined;
            this.mobileView?.release();
            this.mobileView = undefined;
            this.removePagePasteHandler();
        };

        const googMoreBox = (this.moreBox = new GoogMoreBox(udid, player, this));
        const moreBox = googMoreBox.getHolderElement();
        googMoreBox.setOnStop(stop);
        const googToolBox = GoogToolBox.createToolBox(udid, player, this, moreBox, {
            captureKeyboard: this.params.captureKeyboard,
        });
        this.controlButtons = googToolBox.getHolderElement();
        deviceView.appendChild(this.controlButtons);
        this.networkPanel = new NetworkControlPanel(udid);
        this.controlButtons.appendChild(this.networkPanel.getElement());
        const video = document.createElement('div');
        video.className = 'video';
        this.videoElement = video;
        deviceView.appendChild(video);
        deviceView.appendChild(moreBox);
        player.setParent(video);
        player.on('video-view-resize', this.onVideoViewResize);
        const onViewportResize = () => {
            const screenInfo = this.player?.getScreenInfo();
            if (screenInfo) {
                this.fitVideoPresentation(screenInfo.videoSize);
            }
        };
        window.addEventListener('resize', onViewportResize);
        this.videoPresentationCleanup = () => {
            player?.off('video-view-resize', this.onVideoViewResize);
            window.removeEventListener('resize', onViewportResize);
        };
        if (!mobile) {
            this.addVideoResizeHandle(video);
        }
        player.pause();

        document.body.appendChild(deviceView);
        if (mobile) {
            this.mobileView = new MobileStreamView(
                player,
                deviceView,
                video,
                this.controlButtons,
                moreBox,
                udid,
                (suspended) => this.touchHandler?.setSuspended(suspended),
                (changing) => {
                    this.changingDisplay = changing;
                },
            );
        }
        this.touchDiagnostics = TouchDiagnostics.create(player.getTouchableElement(), moreBox, player.getName());
        document.addEventListener('paste', this.onPagePaste, true);
        if (fitToScreen) {
            const newBounds = this.getMaxSize();
            if (newBounds) {
                videoSettings = StreamClientScrcpy.createVideoSettingsWithBounds(videoSettings, newBounds);
            }
        }
        this.desiredVideoSettings = VideoSettings.copy(videoSettings);
        this.applyNewVideoSettings(videoSettings, false);
        const element = player.getTouchableElement();
        const logger = new DragAndPushLogger(element);
        this.filePushHandler = new FilePushHandler(
            element,
            new ScrcpyFilePushStream(this.streamReceiver),
            (fileNames) => this.finalizeUploadedFiles(udid, fileNames),
        );
        this.filePushHandler.addEventListener(logger);

        const streamReceiver = this.streamReceiver;
        streamReceiver.on('connected', this.onConnected);
        streamReceiver.on('deviceMessage', this.OnDeviceMessage);
        streamReceiver.on('video', this.onVideo);
        streamReceiver.on('clientsStats', this.onClientsStats);
        streamReceiver.on('displayInfo', this.onDisplayInfo);
        streamReceiver.on('disconnected', this.onDisconnected);
        console.log(TAG, player.getName(), udid);
    }

    public sendMessage(message: ControlMessage): void {
        this.streamReceiver.sendEvent(message);
    }

    private async finalizeUploadedFiles(udid: string, fileNames: string[]): Promise<void> {
        const basePath = window.location.pathname.endsWith('/')
            ? window.location.pathname
            : `${window.location.pathname}/`;
        const endpoint = new URL(`${basePath}api/finalize-upload`, window.location.origin);
        const response = await fetch(endpoint.toString(), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ udid, fileNames }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) {
            throw new Error(result.output || `File processing failed (${response.status})`);
        }
    }

    public getDeviceName(): string {
        return this.deviceName;
    }

    public setHandleKeyboardEvents(enabled: boolean): void {
        if (enabled) {
            KeyInputHandler.addEventListener(this);
        } else {
            KeyInputHandler.removeEventListener(this);
        }
    }

    public onKeyEvent(event: KeyCodeControlMessage): void {
        this.sendMessage(event);
    }

    private onPagePaste = (event: ClipboardEvent): void => {
        if (event.defaultPrevented) {
            return;
        }
        const target = event.target as HTMLElement | null;
        if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable) {
            return;
        }
        const value = (event.clipboardData?.getData('text/plain') || '').replace(/\r\n/g, '\n');
        if (!value) {
            return;
        }
        event.preventDefault();
        event.stopPropagation();
        const { sent, unsupported } = InlineKeyboardOverlay.forwardText((message) => this.sendMessage(message), value);
        this.showPasteStatus(sent, unsupported);
    };

    private showPasteStatus(sent: number, unsupported: number): void {
        const id = 'stream-paste-status';
        let status = document.getElementById(id);
        if (!status) {
            status = document.createElement('p');
            status.id = id;
            status.className = 'stream-paste-status';
            status.setAttribute('aria-live', 'polite');
            document.body.appendChild(status);
        }
        status.textContent = unsupported
            ? `${sent} characters pasted; ${unsupported} unsupported characters skipped.`
            : `${sent} characters pasted.`;
        status.classList.toggle('error', unsupported > 0);
        if (this.pasteStatusTimeout) {
            clearTimeout(this.pasteStatusTimeout);
        }
        this.pasteStatusTimeout = window.setTimeout(() => status?.remove(), 3000);
    }

    private removePagePasteHandler(): void {
        document.removeEventListener('paste', this.onPagePaste, true);
        if (this.pasteStatusTimeout) {
            clearTimeout(this.pasteStatusTimeout);
            this.pasteStatusTimeout = undefined;
        }
        document.getElementById('stream-paste-status')?.remove();
    }

    public openRemoteKeyboard(anchor?: HTMLElement): void {
        if (!this.inlineKeyboard) {
            this.inlineKeyboard = new InlineKeyboardOverlay((message) => this.sendMessage(message), anchor);
        }
        this.inlineKeyboard.open();
    }

    public openAdbOverlay(anchor?: HTMLElement): void {
        if (!this.adbOverlay) {
            this.adbOverlay = new AdbOverlay(this.params.udid, anchor);
        }
        this.adbOverlay.open();
    }

    public sendNewVideoSetting(videoSettings: VideoSettings): void {
        this.requestedVideoSettings = videoSettings;
        this.desiredVideoSettings = VideoSettings.copy(videoSettings);
        this.sendMessage(CommandControlMessage.createSetVideoSettingsCommand(videoSettings));
    }

    public getClientId(): number {
        return this.clientId;
    }

    public getClientsCount(): number {
        return this.clientsCount;
    }

    public getMaxSize(): Size | undefined {
        if (!this.controlButtons) {
            return;
        }
        // Use the viewport rather than body dimensions: a flex child that is
        // being resized can temporarily make body.scrollHeight larger than
        // the visible area, which would otherwise allow a clipped video.
        const width = (window.innerWidth - this.controlButtons.clientWidth) & ~15;
        const height = window.innerHeight & ~15;
        return new Size(width, height);
    }

    private addVideoResizeHandle(video: HTMLElement): void {
        const handle = document.createElement('div');
        handle.className = 'video-resize-handle';
        handle.title = 'Drag to resize';
        handle.setAttribute('aria-label', 'Drag to resize');
        video.appendChild(handle);

        let startWidth = 0;
        let startX = 0;
        let aspectRatio = 1;
        let active = false;
        const onPointerMove = (event: PointerEvent): void => {
            if (!active) {
                return;
            }
            const bounds = this.getResizeBounds(startWidth + event.clientX - startX, aspectRatio);
            video.style.width = `${bounds.width}px`;
            video.style.height = `${bounds.height}px`;
        };
        const onPointerUp = (): void => {
            if (!active) {
                return;
            }
            active = false;
            const rect = video.getBoundingClientRect();
            this.resizeVideo(new Size(rect.width, rect.height));
        };
        const onPointerDown = (event: PointerEvent): void => {
            event.preventDefault();
            event.stopPropagation();
            const rect = video.getBoundingClientRect();
            startWidth = rect.width;
            startX = event.clientX;
            aspectRatio = rect.height ? rect.width / rect.height : 1;
            active = true;
            handle.setPointerCapture(event.pointerId);
        };
        handle.addEventListener('pointerdown', onPointerDown);
        window.addEventListener('pointermove', onPointerMove);
        window.addEventListener('pointerup', onPointerUp);
        this.videoResizeCleanup = () => {
            handle.removeEventListener('pointerdown', onPointerDown);
            window.removeEventListener('pointermove', onPointerMove);
            window.removeEventListener('pointerup', onPointerUp);
        };
    }

    private onVideoViewResize = (size: Size): void => {
        this.fitVideoPresentation(size);
    };

    private fitVideoPresentation(size: Size): void {
        const video = this.videoElement;
        if (!video || this.mobileView || MobileStreamView.isEnabled()) {
            return;
        }
        const max = this.getMaxSize();
        if (!max || !size.width || !size.height) {
            return;
        }
        const scale = Math.min(1, max.width / size.width, max.height / size.height);
        const width = Math.max(16, Math.floor(size.width * scale));
        const height = Math.max(16, Math.floor(size.height * scale));
        video.style.width = `${width}px`;
        video.style.height = `${height}px`;
        if (scale < 1) {
            console.warn(
                `${TAG} clamped oversized stream udid=${this.params.udid} source=${size.width}x${size.height} view=${width}x${height}`,
            );
        }
    }

    private getResizeBounds(requestedWidth: number, aspectRatio: number): Size {
        const max = this.getMaxSize();
        const minimumWidth = Math.max(160, 160 * aspectRatio);
        let width = Math.max(minimumWidth, requestedWidth);
        let height = width / aspectRatio;
        if (max && (width > max.width || height > max.height)) {
            const scale = Math.min(max.width / width, max.height / height);
            width *= scale;
            height *= scale;
        }
        return new Size(Math.max(16, width & ~15), Math.max(16, height & ~15));
    }

    private resizeVideo(bounds: Size): void {
        if (!this.player) {
            return;
        }
        const current = this.player.getVideoSettings();
        if (current.bounds?.equals(bounds)) {
            return;
        }
        this.sendNewVideoSetting(StreamClientScrcpy.createVideoSettingsWithBounds(current, bounds));
    }

    private setTouchListeners(player: BasePlayer): void {
        if (this.touchHandler) {
            return;
        }
        this.touchHandler = new FeaturedInteractionHandler(player, this);
    }

    private applyNewVideoSettings(videoSettings: VideoSettings, saveToStorage: boolean): void {
        let fitToScreen = false;

        // TODO: create control (switch/checkbox) instead
        if (videoSettings.bounds && videoSettings.bounds.equals(this.getMaxSize())) {
            fitToScreen = true;
        }
        if (this.player) {
            this.player.setVideoSettings(videoSettings, fitToScreen, saveToStorage);
        }
    }

    public static createEntryForDeviceList(
        descriptor: GoogDeviceDescriptor,
        blockClass: string,
        fullName: string,
        params: ParamsDeviceTracker,
    ): HTMLElement | DocumentFragment | undefined {
        if (descriptor.state === DeviceState.DEVICE) {
            const configureButtonId = `configure_${Util.escapeUdid(descriptor.udid)}`;
            const e = html`<div class="stream ${blockClass}">
                <button
                    ${Attribute.UDID}="${descriptor.udid}"
                    ${Attribute.COMMAND}="${ControlCenterCommand.CONFIGURE_STREAM}"
                    ${Attribute.FULL_NAME}="${fullName}"
                    ${Attribute.SECURE}="${params.secure}"
                    ${Attribute.HOSTNAME}="${params.hostname}"
                    ${Attribute.PORT}="${params.port}"
                    ${Attribute.PATHNAME}="${params.pathname}"
                    ${Attribute.USE_PROXY}="${params.useProxy}"
                    id="${configureButtonId}"
                    class="active action-button"
                >
                    Configure stream
                </button>
            </div>`;
            const a = e.content.getElementById(configureButtonId);
            a && (a.onclick = this.onConfigureStreamClick);
            return e.content;
        }
        return;
    }

    private static onConfigureStreamClick = (event: MouseEvent): void => {
        const button = event.currentTarget as HTMLAnchorElement;
        const udid = Util.parseStringEnv(button.getAttribute(Attribute.UDID) || '');
        const fullName = button.getAttribute(Attribute.FULL_NAME);
        const secure = Util.parseBooleanEnv(button.getAttribute(Attribute.SECURE) || undefined) || false;
        const hostname = Util.parseStringEnv(button.getAttribute(Attribute.HOSTNAME) || undefined) || '';
        const port = Util.parseIntEnv(button.getAttribute(Attribute.PORT) || undefined);
        const pathname = Util.parseStringEnv(button.getAttribute(Attribute.PATHNAME) || undefined) || '';
        const useProxy = Util.parseBooleanEnv(button.getAttribute(Attribute.USE_PROXY) || undefined);
        if (!udid) {
            throw Error(`Invalid udid value: "${udid}"`);
        }
        if (typeof port !== 'number') {
            throw Error(`Invalid port type: ${typeof port}`);
        }
        const tracker = DeviceTracker.getInstance({
            type: 'android',
            secure,
            hostname,
            port,
            pathname,
            useProxy,
        });
        const descriptor = tracker.getDescriptorByUdid(udid);
        if (!descriptor) {
            return;
        }
        event.preventDefault();
        const elements = document.getElementsByName(`${DeviceTracker.AttributePrefixInterfaceSelectFor}${fullName}`);
        if (!elements || !elements.length) {
            return;
        }
        const select = elements[0] as HTMLSelectElement;
        const optionElement = select.options[select.selectedIndex];
        const ws = optionElement.getAttribute(Attribute.URL);
        const name = optionElement.getAttribute(Attribute.NAME);
        if (!ws || !name) {
            return;
        }
        const options: ParamsStreamScrcpy = {
            udid,
            ws,
            player: '',
            action: ACTION.STREAM_SCRCPY,
            secure,
            hostname,
            port,
            pathname,
            useProxy,
        };
        const dialog = new ConfigureScrcpy(tracker, descriptor, options);
        dialog.on('closed', StreamClientScrcpy.onConfigureDialogClosed);
    };

    private static onConfigureDialogClosed = (event: { dialog: ConfigureScrcpy; result: boolean }): void => {
        event.dialog.off('closed', StreamClientScrcpy.onConfigureDialogClosed);
        if (event.result) {
            HostTracker.getInstance().destroy();
        }
    };
}
