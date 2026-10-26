export interface DisplaySize {
    width: number;
    height: number;
}

export interface DisplayState {
    physical: DisplaySize;
    override?: DisplaySize;
    density: number;
    densityOverride?: number;
}

export interface DisplayProfileStatus {
    current: DisplayState;
    saved?: DisplaySize;
    viewport?: DisplaySize;
    updatedAt?: string;
}

export function validateViewport(viewport: DisplaySize): void {
    if (
        !viewport ||
        !Number.isFinite(viewport.width) ||
        !Number.isFinite(viewport.height) ||
        viewport.width < 240 ||
        viewport.width > 1200 ||
        viewport.height < 300 ||
        viewport.height > 1800 ||
        viewport.height / viewport.width < 1.15 ||
        viewport.height / viewport.width > 3
    ) {
        throw new Error('请竖屏并收起键盘后，再适配当前手机');
    }
}

export function calculateDisplaySize(width: number, viewport: DisplaySize): DisplaySize {
    validateViewport(viewport);
    if (!Number.isInteger(width) || width < 320 || width > 4096) {
        throw new Error('云手机宽度超出支持范围');
    }
    // Keep the Android width/DPI, leave a little height for Safari rounding,
    // and round down for the encoder. No independent X/Y scaling is needed.
    const height = Math.floor(((viewport.height - 16) * width) / viewport.width / 16) * 16;
    if (height < 320 || height > 8192) {
        throw new Error('计算出的云手机高度超出支持范围');
    }
    return { width, height };
}
