import { BasePlayer } from './BasePlayer';
import VideoConverter, { setLogger, mimeType } from 'h264-converter';
import VideoSettings from '../VideoSettings';
import Size from '../Size';
import { DisplayInfo } from '../DisplayInfo';
import { BoundedFrameQueue } from './BoundedFrameQueue';

interface QualityStats {
    timestamp: number;
    decodedFrames: number;
    droppedFrames: number;
}

type Block = {
    start: number;
    end: number;
};

export class MsePlayer extends BasePlayer {
    public static readonly storageKeyPrefix = 'MseDecoderLowLatencyV2';
    public static readonly playerFullName = 'H264 Converter';
    public static readonly playerCodeName = 'mse';
    public static readonly preferredVideoSettings: VideoSettings = new VideoSettings({
        lockedVideoOrientation: -1,
        bitrate: 524288,
        maxFps: 10,
        iFrameInterval: 5,
        bounds: new Size(480, 800),
        sendFrameMeta: false,
    });
    private static DEFAULT_FRAMES_PER_FRAGMENT = 1;
    private static DEFAULT_FRAMES_PER_SECOND = 30;

    public static createElement(id?: string): HTMLVideoElement {
        const tag = document.createElement('video') as HTMLVideoElement;
        tag.muted = true;
        tag.autoplay = true;
        tag.setAttribute('muted', 'muted');
        tag.setAttribute('autoplay', 'autoplay');
        if (typeof id === 'string') {
            tag.id = id;
        }
        tag.className = 'video-layer';
        return tag;
    }

    private converter?: VideoConverter;
    private videoStats: QualityStats[] = [];
    private noDecodedFramesSince = -1;
    private currentTimeNotChangedSince = -1;
    private bigBufferSince = -1;
    private aheadOfBufferSince = -1;
    public fpf: number = MsePlayer.DEFAULT_FRAMES_PER_FRAGMENT;
    public readonly supportsScreenshot = true;
    private sourceBuffer?: SourceBuffer;
    private waitUntilSegmentRemoved = false;
    private blocks: Block[] = [];
    private readonly frames = new BoundedFrameQueue(
        12,
        4 * 1024 * 1024,
        (frame) => BasePlayer.isIFrame(frame),
        (frame) => BasePlayer.getParameterSetType(frame),
    );
    private jumpEnd = -1;
    private lastTime = -1;
    protected canPlay = false;
    private seekingSince = -1;
    private onSeekEnd = (): void => {
        this.seekingSince = -1;
        this.tag.removeEventListener('seeked', this.onSeekEnd);
        this.tag.play();
    };
    private badStateTimer?: ReturnType<typeof setInterval>;
    private pumpTimer?: ReturnType<typeof setTimeout>;
    private sourceBufferOwner?: SourceBuffer;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    protected readonly isSafari = !!(window as unknown as any)['safari'];
    protected readonly isChrome = navigator.userAgent.includes('Chrome');
    protected readonly isMac = navigator.platform.startsWith('Mac');
    private readonly MAX_TIME_TO_RECOVER = 200; // ms
    private readonly MAX_SEEK_WAIT = 500; // ms
    private readonly MAX_BUFFER = this.isSafari ? 2 : this.isChrome && this.isMac ? 0.25 : 0.2;
    private readonly MAX_AHEAD = -0.2;

    public static isSupported(): boolean {
        return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(mimeType);
    }

    constructor(
        udid: string,
        displayInfo?: DisplayInfo,
        name = MsePlayer.playerFullName,
        protected tag: HTMLVideoElement = MsePlayer.createElement(),
    ) {
        super(udid, displayInfo, name, MsePlayer.storageKeyPrefix, tag);
        tag.oncontextmenu = function (event: MouseEvent): boolean {
            event.preventDefault();
            return false;
        };
        tag.addEventListener('error', this.onVideoError);
        tag.addEventListener('canplay', this.onVideoCanPlay);
        // eslint-disable-next-line @typescript-eslint/no-empty-function
        setLogger(() => {}, console.error);
    }

    onVideoError = (event: Event): void => {
        console.error(`[${this.name}]`, event);
    };

    onVideoCanPlay = (): void => {
        this.onCanPlayHandler();
    };

    private static createConverter(
        tag: HTMLVideoElement,
        fps: number = MsePlayer.DEFAULT_FRAMES_PER_SECOND,
        fpf: number = MsePlayer.DEFAULT_FRAMES_PER_FRAGMENT,
    ): VideoConverter {
        return new VideoConverter(tag, fps, fpf);
    }

    private getVideoPlaybackQuality(): QualityStats | null {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const video = this.tag as any;
        if (typeof video.mozDecodedFrames !== 'undefined') {
            return null;
        }
        const now = Date.now();
        if (typeof this.tag.getVideoPlaybackQuality == 'function') {
            const temp = this.tag.getVideoPlaybackQuality();
            return {
                timestamp: now,
                decodedFrames: temp.totalVideoFrames,
                droppedFrames: temp.droppedVideoFrames,
            };
        }

        // Webkit-specific properties
        if (typeof video.webkitDecodedFrameCount !== 'undefined') {
            return {
                timestamp: now,
                decodedFrames: video.webkitDecodedFrameCount,
                droppedFrames: video.webkitDroppedFrameCount,
            };
        }
        return null;
    }

    protected onCanPlayHandler(): void {
        this.canPlay = true;
        this.tag.play();
        this.tag.removeEventListener('canplay', this.onVideoCanPlay);
        this.checkVideoResize();
    }

    protected calculateMomentumStats(): void {
        const stat = this.getVideoPlaybackQuality();
        if (!stat) {
            return;
        }

        const timestamp = Date.now();
        const oneSecondBefore = timestamp - 1000;
        this.videoStats.push(stat);

        while (this.videoStats.length && this.videoStats[0].timestamp < oneSecondBefore) {
            this.videoStats.shift();
        }
        while (this.inputBytes.length && this.inputBytes[0].timestamp < oneSecondBefore) {
            this.inputBytes.shift();
        }
        let inputBytes = 0;
        this.inputBytes.forEach((item) => {
            inputBytes += item.bytes;
        });
        const inputFrames = this.inputBytes.length;
        if (this.videoStats.length) {
            const oldest = this.videoStats[0];
            const decodedFrames = stat.decodedFrames - oldest.decodedFrames;
            const droppedFrames = stat.droppedFrames - oldest.droppedFrames;
            // const droppedFrames = inputFrames - decodedFrames;
            this.momentumQualityStats = {
                decodedFrames,
                droppedFrames,
                inputBytes,
                inputFrames,
                timestamp,
            };
        }
    }

    protected resetStats(): void {
        super.resetStats();
        this.videoStats = [];
    }

    public getImageDataURL(): string {
        const canvas = document.createElement('canvas');
        canvas.width = this.tag.clientWidth;
        canvas.height = this.tag.clientHeight;
        const ctx = canvas.getContext('2d');
        if (ctx) {
            ctx.drawImage(this.tag, 0, 0, canvas.width, canvas.height);
        }

        return canvas.toDataURL();
    }

    public play(): void {
        super.play();
        if (this.getState() !== BasePlayer.STATE.PLAYING) {
            return;
        }
        if (!this.converter) {
            let fps = MsePlayer.DEFAULT_FRAMES_PER_SECOND;
            if (this.videoSettings) {
                fps = this.videoSettings.maxFps;
            }
            this.converter = MsePlayer.createConverter(this.tag, fps, this.fpf);
            this.canPlay = false;
            this.resetStats();
        }
        this.converter.play();
        if (!this.badStateTimer) {
            this.badStateTimer = setInterval(() => this.checkForBadState(), 100);
        }
    }

    public pause(): void {
        super.pause();
        this.stopBadStateWatchdog();
        this.stopConverter();
    }

    public stop(): void {
        super.stop();
        this.stopBadStateWatchdog();
        this.stopConverter();
    }

    public setVideoSettings(videoSettings: VideoSettings, fitToScreen: boolean, saveToStorage: boolean): void {
        if (this.videoSettings && this.videoSettings.maxFps !== videoSettings.maxFps) {
            const state = this.getState();
            if (this.converter) {
                this.stop();
                this.converter = MsePlayer.createConverter(this.tag, videoSettings.maxFps, this.fpf);
                this.canPlay = false;
            }
            if (state === BasePlayer.STATE.PLAYING) {
                this.play();
            }
        }
        super.setVideoSettings(videoSettings, fitToScreen, saveToStorage);
    }

    public getPreferredVideoSetting(): VideoSettings {
        return MsePlayer.preferredVideoSettings;
    }

    checkVideoResize = (): void => {
        if (!this.tag) {
            return;
        }
        const { videoHeight, videoWidth } = this.tag;
        if (this.videoHeight !== videoHeight || this.videoWidth !== videoWidth) {
            this.calculateScreenInfoForBounds(videoWidth, videoHeight);
        }
    };
    cleanSourceBuffer = (): void => {
        if (!this.sourceBuffer) {
            return;
        }
        if (this.sourceBuffer.updating) {
            return;
        }
        if (this.blocks.length < 10) {
            return;
        }
        try {
            this.sourceBuffer.removeEventListener('updateend', this.cleanSourceBuffer);
            this.waitUntilSegmentRemoved = false;
            const removeStart = this.blocks[0].start;
            const removeEnd = this.blocks[4].end;
            this.blocks = this.blocks.slice(5);
            this.sourceBuffer.remove(removeStart, removeEnd);
        } catch (error: any) {
            console.error(`[${this.name}]`, 'Failed to clean source buffer');
        }
    };

    private schedulePump(): void {
        if (this.pumpTimer || !this.frames.length) {
            return;
        }
        this.pumpTimer = setTimeout(() => {
            this.pumpTimer = undefined;
            this.pumpFrames();
        }, 16);
    }

    private pumpFrames = (): void => {
        if (!this.converter) {
            return;
        }
        this.sourceBuffer = this.converter.sourceBuffer;
        if (!this.sourceBuffer) {
            this.schedulePump();
            return;
        }
        if (this.sourceBufferOwner !== this.sourceBuffer) {
            this.sourceBufferOwner?.removeEventListener('updateend', this.pumpFrames);
            this.sourceBufferOwner = this.sourceBuffer;
            this.sourceBuffer.addEventListener('updateend', this.pumpFrames);
        }
        if (this.sourceBuffer.updating || this.waitUntilSegmentRemoved) {
            return;
        }

        let processed = 0;
        while (processed < 32 && !this.sourceBuffer.updating && !this.waitUntilSegmentRemoved) {
            const frame = this.frames.shift();
            if (!frame) {
                return;
            }
            if (!this.checkForIFrame(frame)) {
                this.frames.unshift(frame);
                return;
            }
            processed++;
        }
        this.schedulePump();
    };

    jumpToEnd = (): void => {
        if (!this.sourceBuffer) {
            return;
        }
        if (this.sourceBuffer.updating) {
            return;
        }
        if (!this.tag.buffered.length) {
            return;
        }
        const end = this.tag.buffered.end(this.tag.seekable.length - 1);
        console.log(`[${this.name}]`, `Jumping to the end (${this.jumpEnd}, ${end - this.jumpEnd}).`);
        this.tag.currentTime = end;
        this.jumpEnd = -1;
        this.sourceBuffer.removeEventListener('updateend', this.jumpToEnd);
    };

    public pushFrame(frame: Uint8Array): void {
        super.pushFrame(frame);

        const result = this.frames.push(frame);
        if (result.dropped) {
            this.videoStats.push({
                decodedFrames: 0,
                droppedFrames: result.dropped,
                timestamp: Date.now(),
            });
        }
        this.pumpFrames();
        this.checkForBadState();
    }

    protected checkForBadState(): void {
        // Workaround for stalled playback (`stalled` event is not fired, but the image freezes)
        const { currentTime } = this.tag;
        const now = Date.now();
        // let reasonToJump = '';
        let hasReasonToJump = false;
        if (this.momentumQualityStats) {
            if (this.momentumQualityStats.decodedFrames === 0 && this.momentumQualityStats.inputFrames > 0) {
                if (this.noDecodedFramesSince === -1) {
                    this.noDecodedFramesSince = now;
                } else {
                    const time = now - this.noDecodedFramesSince;
                    if (time > this.MAX_TIME_TO_RECOVER) {
                        // reasonToJump = `No frames decoded for ${time} ms.`;
                        hasReasonToJump = true;
                    }
                }
            } else {
                this.noDecodedFramesSince = -1;
            }
        }
        if (currentTime === this.lastTime && this.currentTimeNotChangedSince === -1) {
            this.currentTimeNotChangedSince = now;
        } else {
            this.currentTimeNotChangedSince = -1;
        }
        this.lastTime = currentTime;
        if (this.tag.buffered.length) {
            const lastBufferedRange = this.tag.buffered.length - 1;
            const end = this.tag.buffered.end(lastBufferedRange);
            const hasBufferedGap =
                lastBufferedRange > 0 && this.tag.buffered.start(lastBufferedRange) - currentTime > 0.05;
            const buffered = end - currentTime;

            if (buffered > this.MAX_BUFFER || hasBufferedGap) {
                if (this.bigBufferSince === -1) {
                    this.bigBufferSince = now;
                } else {
                    const time = now - this.bigBufferSince;
                    if (time > this.MAX_TIME_TO_RECOVER) {
                        // reasonToJump = `Buffer is bigger then ${this.MAX_BUFFER} (${buffered.toFixed(
                        //     3,
                        // )}) for ${time} ms.`;
                        hasReasonToJump = true;
                    }
                }
            } else {
                this.bigBufferSince = -1;
            }
            if (buffered < this.MAX_AHEAD) {
                if (this.aheadOfBufferSince === -1) {
                    this.aheadOfBufferSince = now;
                } else {
                    const time = now - this.aheadOfBufferSince;
                    if (time > this.MAX_TIME_TO_RECOVER) {
                        // reasonToJump = `Current time is ahead of end (${buffered}) for ${time} ms.`;
                        hasReasonToJump = true;
                    }
                }
            } else {
                this.aheadOfBufferSince = -1;
            }
            if (this.currentTimeNotChangedSince !== -1) {
                const time = now - this.currentTimeNotChangedSince;
                if (time > this.MAX_TIME_TO_RECOVER) {
                    // reasonToJump = `Current time not changed for ${time} ms.`;
                    hasReasonToJump = true;
                }
            }
            if (!hasReasonToJump) {
                return;
            }
            let waitingForSeekEnd = 0;
            if (this.seekingSince !== -1) {
                waitingForSeekEnd = now - this.seekingSince;
                if (waitingForSeekEnd < this.MAX_SEEK_WAIT) {
                    return;
                }
                this.tag.removeEventListener('seeked', this.onSeekEnd);
                this.seekingSince = -1;
            }
            // console.info(`${reasonToJump} Jumping to the end. ${waitingForSeekEnd}`);

            if (Math.abs(end - currentTime) <= 0.05) {
                return;
            }
            this.seekingSince = now;
            this.tag.addEventListener('seeked', this.onSeekEnd);
            this.tag.currentTime = end;
        }
    }

    private stopBadStateWatchdog(): void {
        if (this.badStateTimer) {
            clearInterval(this.badStateTimer);
            this.badStateTimer = undefined;
        }
    }

    protected checkForIFrame(frame: Uint8Array): boolean {
        if (!this.converter) {
            return false;
        }
        this.sourceBuffer = this.converter.sourceBuffer;
        if (!this.sourceBuffer) {
            return false;
        }
        if (BasePlayer.isIFrame(frame)) {
            let start = 0;
            let end = 0;
            if (this.tag.buffered && this.tag.buffered.length) {
                start = this.tag.buffered.start(0);
                end = this.tag.buffered.end(0);
            }
            if (end !== 0 && start < end) {
                const block: Block = {
                    start,
                    end,
                };
                this.blocks.push(block);
                if (this.blocks.length > 10) {
                    this.waitUntilSegmentRemoved = true;
                    this.cleanSourceBuffer();
                    return false;
                }
            }
            if (this.sourceBuffer) {
                this.sourceBuffer.onupdateend = this.checkVideoResize;
            }
        }
        if (this.waitUntilSegmentRemoved) {
            return false;
        }

        this.converter.appendRawData(frame);
        return true;
    }

    private stopConverter(): void {
        this.tag.removeEventListener('seeked', this.onSeekEnd);
        this.seekingSince = -1;
        if (this.pumpTimer) {
            clearTimeout(this.pumpTimer);
            this.pumpTimer = undefined;
        }
        if (this.converter) {
            this.converter.appendRawData(new Uint8Array([]));
            this.converter.pause();
            this.sourceBufferOwner?.removeEventListener('updateend', this.pumpFrames);
            this.sourceBufferOwner?.removeEventListener('updateend', this.cleanSourceBuffer);
            delete this.converter;
        }
        this.sourceBuffer = undefined;
        this.sourceBufferOwner = undefined;
        this.frames.clear();
        this.blocks = [];
        this.waitUntilSegmentRemoved = false;
    }

    public getFitToScreenStatus(): boolean {
        return MsePlayer.getFitToScreenStatus(this.udid, this.displayInfo);
    }

    public loadVideoSettings(): VideoSettings {
        return MsePlayer.loadVideoSettings(this.udid, this.displayInfo);
    }
}
