import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { createHash } from 'crypto';
import { calculateDisplaySize, DisplayProfileStatus, DisplaySize, DisplayState } from '../../../common/DisplayProfile';

interface DisplayDevice {
    udid: string;
    runShellCommandAdbKit(command: string): Promise<string>;
    restartDisplayStream(): Promise<void>;
}

interface SavedProfile {
    version: 1;
    udid: string;
    original: DisplayState;
    saved?: DisplaySize;
    viewport?: DisplaySize;
    updatedAt?: string;
}

/** One durable profile per Android display, shared by all its viewers. */
export class DisplayProfiles {
    private static instance?: DisplayProfiles;
    private readonly pending = new Map<string, Promise<unknown>>();

    public constructor(
        private readonly directory = process.env.WS_SCRCPY_DISPLAY_PROFILE_DIR ||
            path.join(os.homedir(), '.config/ws-scrcpy/display-profiles'),
    ) {}

    public static getInstance(): DisplayProfiles {
        return this.instance || (this.instance = new DisplayProfiles());
    }

    private file(udid: string): string {
        return path.join(this.directory, `${createHash('sha256').update(udid).digest('hex')}.json`);
    }

    private serial<T>(udid: string, operation: () => Promise<T>): Promise<T> {
        const previous = this.pending.get(udid) || Promise.resolve();
        const next = previous.catch(() => undefined).then(operation);
        this.pending.set(udid, next);
        void next
            .finally(() => {
                if (this.pending.get(udid) === next) this.pending.delete(udid);
            })
            .catch(() => undefined);
        return next;
    }

    private async load(udid: string): Promise<SavedProfile | undefined> {
        let text: string;
        try {
            text = await fs.readFile(this.file(udid), 'utf8');
        } catch (error: unknown) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        }
        const record: SavedProfile = JSON.parse(text);
        if (record.version !== 1 || record.udid !== udid) throw new Error('Invalid display profile');
        this.validateState(record.original);
        if (record.saved) this.validateSize(record.saved);
        return record;
    }

    private validateSize(size: DisplaySize): void {
        if (
            !size ||
            !Number.isInteger(size.width) ||
            !Number.isInteger(size.height) ||
            size.width < 200 ||
            size.width > 8192 ||
            size.height < 200 ||
            size.height > 8192
        ) {
            throw new Error('Invalid display size');
        }
    }

    private validateState(state: DisplayState): void {
        this.validateSize(state.physical);
        if (state.override) this.validateSize(state.override);
        for (const density of [state.density, state.densityOverride]) {
            if (density !== undefined && (!Number.isInteger(density) || density < 72 || density > 1600)) {
                throw new Error('Invalid display density');
            }
        }
    }

    private async store(record: SavedProfile): Promise<void> {
        await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const file = this.file(record.udid);
        const temporary = `${file}.next`;
        await fs.writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
        await fs.rename(temporary, file);
    }

    private async read(device: DisplayDevice): Promise<DisplayState> {
        const size = await device.runShellCommandAdbKit('wm size');
        const density = await device.runShellCommandAdbKit('wm density');
        const physical = size.match(/Physical size:\s*(\d+)x(\d+)/);
        const override = size.match(/Override size:\s*(\d+)x(\d+)/);
        const dpi = density.match(/Physical density:\s*(\d+)/);
        const dpiOverride = density.match(/Override density:\s*(\d+)/);
        if (!physical || !dpi) throw new Error('无法读取云手机屏幕配置');
        const state: DisplayState = {
            physical: { width: +physical[1], height: +physical[2] },
            override: override ? { width: +override[1], height: +override[2] } : undefined,
            density: +dpi[1],
            densityOverride: dpiOverride ? +dpiOverride[1] : undefined,
        };
        this.validateState(state);
        return state;
    }

    private sameSize(a: DisplaySize | undefined, b: DisplaySize | undefined): boolean {
        return a?.width === b?.width && a?.height === b?.height;
    }

    private async applyState(device: DisplayDevice, target: DisplayState): Promise<DisplayState> {
        this.validateState(target);
        const before = await this.read(device);
        if (!this.sameSize(before.override, target.override)) {
            await device.runShellCommandAdbKit(
                `wm size ${target.override ? `${target.override.width}x${target.override.height}` : 'reset'}`,
            );
        }
        if (before.densityOverride !== target.densityOverride) {
            await device.runShellCommandAdbKit(
                `wm density ${target.densityOverride === undefined ? 'reset' : target.densityOverride}`,
            );
        }
        const actual = await this.read(device);
        if (!this.sameSize(actual.override, target.override) || actual.densityOverride !== target.densityOverride) {
            throw new Error('云手机未应用目标屏幕配置');
        }
        return actual;
    }

    public status(device: DisplayDevice): Promise<DisplayProfileStatus> {
        return this.serial(device.udid, async () => {
            const record = await this.load(device.udid);
            return {
                current: await this.read(device),
                saved: record?.saved,
                viewport: record?.viewport,
                updatedAt: record?.updatedAt,
            };
        });
    }

    public adapt(device: DisplayDevice, viewport: DisplaySize): Promise<DisplayProfileStatus> {
        return this.serial(device.udid, async () => {
            const before = await this.read(device);
            const previous = await this.load(device.udid);
            const width = (before.override || before.physical).width;
            const saved = calculateDisplaySize(width, viewport);
            const record: SavedProfile = previous || { version: 1, udid: device.udid, original: before };
            // Persist the recovery baseline before changing Android.
            if (!previous) await this.store(record);
            try {
                const current = await this.applyState(device, { ...before, override: saved });
                await device.restartDisplayStream();
                const updatedAt = new Date().toISOString();
                await this.store({ ...record, saved, viewport, updatedAt });
                return { current, saved, viewport, updatedAt };
            } catch (error) {
                try {
                    await this.applyState(device, before);
                    await device.restartDisplayStream();
                } catch (_) {
                    throw new Error('适配失败，自动恢复也未成功，请使用“恢复原始屏幕”');
                }
                throw error;
            }
        });
    }

    public restore(device: DisplayDevice): Promise<DisplayProfileStatus> {
        return this.serial(device.udid, async () => {
            const record = await this.load(device.udid);
            if (!record) return { current: await this.read(device) };
            const before = await this.read(device);
            try {
                const current = await this.applyState(device, record.original);
                await device.restartDisplayStream();
                await fs.unlink(this.file(device.udid));
                return { current };
            } catch (error) {
                await this.applyState(device, before);
                await device.restartDisplayStream();
                throw error;
            }
        });
    }

    public reapply(device: DisplayDevice): Promise<void> {
        return this.serial(device.udid, async () => {
            const record = await this.load(device.udid);
            if (!record?.saved) return;
            const before = await this.read(device);
            await this.applyState(device, { ...before, override: record.saved });
            await device.restartDisplayStream();
        });
    }
}
