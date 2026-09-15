export type FrameQueuePushResult = {
    accepted: boolean;
    dropped: number;
};

export class BoundedFrameQueue {
    private readonly frames: Uint8Array[] = [];
    private totalBytes = 0;
    private droppingUntilKeyFrame = false;

    public constructor(
        private readonly maxFrames: number,
        private readonly maxBytes: number,
        private readonly isKeyFrame: (frame: Uint8Array) => boolean,
        private readonly getParameterSetType: (frame: Uint8Array) => number | undefined,
    ) {}

    public get length(): number {
        return this.frames.length;
    }

    public push(frame: Uint8Array): FrameQueuePushResult {
        const keyFrame = this.isKeyFrame(frame);
        const parameterSetType = this.getParameterSetType(frame);
        if (parameterSetType !== undefined && !keyFrame) {
            this.rememberParameterSet(parameterSetType, frame);
        }
        if (this.droppingUntilKeyFrame && !keyFrame) {
            return { accepted: false, dropped: 1 };
        }

        let dropped = 0;
        const wouldExceedLimit =
            this.frames.length >= this.maxFrames || this.totalBytes + frame.byteLength > this.maxBytes;

        if (keyFrame) {
            const recovering = this.droppingUntilKeyFrame || wouldExceedLimit;
            if (recovering) {
                dropped += this.clear();
                if (parameterSetType === undefined) {
                    this.parameterSets.forEach((parameter) => this.append(parameter.frame));
                }
            }
            this.droppingUntilKeyFrame = false;
        } else if (wouldExceedLimit) {
            dropped += this.clear();
            this.droppingUntilKeyFrame = true;
            return { accepted: false, dropped: dropped + 1 };
        }

        this.frames.push(frame);
        this.totalBytes += frame.byteLength;
        return { accepted: true, dropped };
    }

    public shift(): Uint8Array | undefined {
        const frame = this.frames.shift();
        if (frame) {
            this.totalBytes -= frame.byteLength;
        }
        return frame;
    }

    public unshift(frame: Uint8Array): void {
        this.frames.unshift(frame);
        this.totalBytes += frame.byteLength;
    }

    public clear(): number {
        const count = this.frames.length;
        this.frames.length = 0;
        this.totalBytes = 0;
        return count;
    }

    private readonly parameterSets: { type: number; frame: Uint8Array }[] = [];

    private rememberParameterSet(type: number, frame: Uint8Array): void {
        const existing = this.parameterSets.findIndex((item) => item.type === type);
        if (existing >= 0) {
            this.parameterSets[existing].frame = frame;
            return;
        }
        this.parameterSets.push({ type, frame });
        if (this.parameterSets.length > 2) {
            this.parameterSets.shift();
        }
    }

    private append(frame: Uint8Array): void {
        this.frames.push(frame);
        this.totalBytes += frame.byteLength;
    }
}
