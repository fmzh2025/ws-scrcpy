import { BasePlayer } from '../../player/BasePlayer';
import { DisplayProfileStatus, DisplaySize, validateViewport } from '../../../common/DisplayProfile';

export class DisplayProfileControl {
    private readonly root = document.createElement('section');
    private readonly adapt = document.createElement('button');
    private readonly restore = document.createElement('button');
    private readonly reconnect = document.createElement('button');
    private readonly message = document.createElement('p');
    private readonly abort = new AbortController();
    private busy = false;
    private released = false;
    private timer?: number;
    private cancelWait?: () => void;

    public constructor(
        private readonly udid: string,
        private readonly player: BasePlayer,
        private readonly view: HTMLElement,
        private readonly videoContainer: HTMLElement,
        menu: HTMLElement,
        private readonly suspend: (suspended: boolean) => void,
        private readonly changing: (changing: boolean) => void,
    ) {
        this.root.className = 'mobile-display-profile';
        this.adapt.textContent = '适配当前手机';
        this.restore.textContent = '恢复原始屏幕';
        this.reconnect.textContent = '重新连接画面';
        this.reconnect.hidden = true;
        this.message.setAttribute('role', 'status');
        this.message.setAttribute('aria-live', 'polite');
        this.message.textContent = '适配一次后保存，换手机时再点一次。';
        for (const button of [this.adapt, this.restore, this.reconnect]) button.type = 'button';
        this.adapt.onclick = () => void this.change('adapt');
        this.restore.onclick = () => void this.change('restore');
        this.reconnect.onclick = () => location.reload();
        this.root.append(this.adapt, this.restore, this.reconnect, this.message);
        menu.insertBefore(this.root, menu.querySelector('.mobile-menu-close')?.nextSibling || null);
        void this.initialize();
    }

    private async initialize(): Promise<void> {
        this.busy = true;
        this.adapt.disabled = this.restore.disabled = true;
        this.suspend(true);
        try {
            const status = await this.request();
            await this.waitForFrame(status.current.override || status.current.physical);
            if (!this.released) {
                this.suspend(false);
                this.describe(status);
            }
        } catch (error: unknown) {
            if (!this.released) {
                this.message.textContent = error instanceof Error ? error.message : '屏幕配置暂不可用';
                this.reconnect.hidden = false;
            }
        } finally {
            this.busy = false;
            if (!this.released) this.adapt.disabled = this.restore.disabled = false;
        }
    }

    private endpoint(): URL {
        const pathname = location.pathname.replace(/\/[^/]+\.html$/, '/');
        const base = pathname.endsWith('/') ? pathname : `${pathname}/`;
        return new URL(`${base}api/display-profile`, location.origin);
    }

    private async request(operation?: string, viewport?: DisplaySize): Promise<DisplayProfileStatus> {
        const url = this.endpoint();
        url.searchParams.set('udid', this.udid);
        const response = await fetch(
            url.toString(),
            operation
                ? {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ udid: this.udid, operation, viewport }),
                      signal: this.abort.signal,
                  }
                : { cache: 'no-store', signal: this.abort.signal },
        );
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.success) throw new Error(result.output || '屏幕配置请求失败');
        return result.status;
    }

    private viewport(): DisplaySize {
        const viewport = window.visualViewport;
        const style = getComputedStyle(this.view);
        const size = {
            width: this.view.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
            height:
                (viewport?.height || window.innerHeight) -
                parseFloat(style.paddingTop) -
                parseFloat(style.paddingBottom),
        };
        validateViewport(size);
        if ((viewport?.scale || 1) > 1.05 || size.height < window.innerHeight * 0.75) {
            throw new Error('请取消网页放大并收起键盘后再适配');
        }
        return size;
    }

    private describe(status: DisplayProfileStatus): void {
        const size = status.current.override || status.current.physical;
        this.message.textContent = status.saved
            ? `已保存适配：${size.width}×${size.height}。换手机时再点一次。`
            : `当前屏幕：${size.width}×${size.height}。适配后自动保存。`;
    }

    private waitForFrame(target: DisplaySize): Promise<void> {
        const deadline = Date.now() + 20000;
        const video = this.videoContainer.querySelector<HTMLVideoElement>('video');
        const initialTime = video?.currentTime;
        return new Promise((resolve, reject) => {
            this.cancelWait = () => reject(new Error('画面已断开'));
            const check = () => {
                if (this.released) {
                    reject(new Error('画面已断开'));
                    return;
                }
                const info = this.player.getScreenInfo();
                const rect = info?.contentRect;
                const sourceMatches =
                    rect &&
                    ((rect.getWidth() === target.width && rect.getHeight() === target.height) ||
                        (rect.getHeight() === target.width && rect.getWidth() === target.height));
                const decodedMatches =
                    video &&
                    info &&
                    video.readyState >= 2 &&
                    !video.error &&
                    Math.abs(video.videoWidth - info.videoSize.width) <= 2 &&
                    Math.abs(video.videoHeight - info.videoSize.height) <= 2 &&
                    Math.abs(video.currentTime - (initialTime || 0)) > 0.001;
                if (sourceMatches && decodedMatches) {
                    this.cancelWait = undefined;
                    resolve();
                } else if (Date.now() >= deadline) {
                    this.cancelWait = undefined;
                    reject(new Error('配置已更新，但新画面尚未就绪，请重新连接画面'));
                } else {
                    this.timer = window.setTimeout(check, 100);
                }
            };
            check();
        });
    }

    private async change(operation: 'adapt' | 'restore'): Promise<void> {
        if (this.busy) return;
        let viewport: DisplaySize | undefined;
        try {
            if (operation === 'adapt') viewport = this.viewport();
        } catch (error: unknown) {
            this.message.textContent = error instanceof Error ? error.message : '屏幕配置失败';
            return;
        }
        this.busy = true;
        this.adapt.disabled = this.restore.disabled = true;
        this.reconnect.hidden = true;
        this.message.textContent = operation === 'adapt' ? '正在适配并保存，等待新画面…' : '正在恢复原始屏幕…';
        this.suspend(true);
        this.changing(true);
        try {
            const status = await this.request(operation, viewport);
            if (!this.released) {
                this.describe(status);
                this.message.textContent += ' 正在重新连接画面…';
                // The bundled scrcpy fork caches display geometry. Its server
                // is rebuilt by the API; reconnect with a fresh MSE decoder.
                location.reload();
            }
        } catch (error: unknown) {
            if (!this.released) {
                this.message.textContent = error instanceof Error ? error.message : '屏幕配置失败';
                this.reconnect.hidden = false;
                this.message.textContent += '；触控已暂停，请重新连接画面。';
            }
        } finally {
            this.busy = false;
            this.changing(false);
            if (!this.released) this.adapt.disabled = this.restore.disabled = false;
        }
    }

    public release(): void {
        this.released = true;
        this.abort.abort();
        window.clearTimeout(this.timer);
        this.cancelWait?.();
        this.root.remove();
    }
}
