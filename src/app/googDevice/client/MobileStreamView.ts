import { BasePlayer } from '../../player/BasePlayer';
import Size from '../../Size';
import VideoSettings from '../../VideoSettings';

/** Size the presentation independently of the encoded video. */
export class MobileStreamView {
    private readonly toggle = document.createElement('button');
    private readonly closeMenu = document.createElement('button');
    private readonly fitControl = document.createElement('label');
    private readonly fitSelect = document.createElement('select');
    private fit: 'fill' | 'contain' = 'fill';
    private frame?: number;
    private static readonly fitStorageKey = 'ws-scrcpy:mobile-video-fit';

    public static isEnabled(): boolean {
        const override = new URLSearchParams(location.search).get('mobile');
        if (override === '1' || override === '0') {
            return override === '1';
        }
        return window.matchMedia('(max-width: 600px), (max-width: 1024px) and (pointer: coarse)').matches;
    }

    public static createVideoSettings(current: VideoSettings): VideoSettings {
        return new VideoSettings({
            ...current.toJSON(),
            // Retina displays need a larger source, even when the CSS viewport is small.
            // A square bound also preserves quality when Android rotates.
            bounds: new Size(2160, 2160),
            bitrate: Math.max(current.bitrate, 4000000),
        });
    }

    constructor(
        private readonly player: BasePlayer,
        private readonly view: HTMLElement,
        private readonly video: HTMLElement,
        private readonly controls: HTMLElement,
        private readonly menu: HTMLElement,
    ) {
        view.classList.add('mobile-stream-view');
        this.toggle.className = 'mobile-controls-toggle';
        this.toggle.textContent = '⋯';
        this.toggle.type = 'button';
        this.toggle.setAttribute('aria-label', '显示控制栏');
        this.toggle.setAttribute('aria-expanded', 'false');
        this.toggle.onclick = () => {
            const open = view.classList.toggle('mobile-controls-open');
            this.toggle.setAttribute('aria-expanded', String(open));
            this.toggle.setAttribute('aria-label', open ? '收起控制栏' : '显示控制栏');
            if (!open) {
                this.hideMenu();
            }
        };
        view.appendChild(this.toggle);
        this.closeMenu.className = 'mobile-menu-close';
        this.closeMenu.type = 'button';
        this.closeMenu.textContent = '关闭菜单';
        this.closeMenu.onclick = () => this.hideMenu();
        menu.insertBefore(this.closeMenu, menu.firstChild);
        try {
            if (localStorage.getItem(MobileStreamView.fitStorageKey) === 'contain') {
                this.fit = 'contain';
            }
        } catch (_) {
            // A restricted Safari storage policy must not block the stream.
        }
        this.fitControl.className = 'mobile-video-fit';
        this.fitControl.textContent = '画面适配 ';
        this.fitSelect.setAttribute('aria-label', '画面适配');
        for (const [value, text] of [
            ['fill', '完整铺满'],
            ['contain', '保持原比例'],
        ]) {
            const option = document.createElement('option');
            option.value = value;
            option.textContent = text;
            this.fitSelect.appendChild(option);
        }
        this.fitSelect.value = this.fit;
        this.fitSelect.onchange = () => {
            this.fit = this.fitSelect.value === 'contain' ? 'contain' : 'fill';
            try {
                localStorage.setItem(MobileStreamView.fitStorageKey, this.fit);
            } catch (_) {
                // The current page can still change its presentation.
            }
            this.layout();
        };
        this.fitControl.appendChild(this.fitSelect);
        menu.insertBefore(this.fitControl, this.closeMenu.nextSibling);
        player.on('video-view-resize', this.layout);
        window.addEventListener('resize', this.scheduleLayout);
        window.visualViewport?.addEventListener('resize', this.scheduleLayout);
        window.visualViewport?.addEventListener('scroll', this.scheduleLayout);
        this.layout();
    }

    private hideMenu(): void {
        this.menu.style.display = 'none';
        const checkbox = this.controls.querySelector<HTMLInputElement>('input[id^="input_show_more_"]');
        if (checkbox) {
            checkbox.checked = false;
        }
    }

    private scheduleLayout = (): void => {
        if (typeof this.frame !== 'number') {
            this.frame = requestAnimationFrame(() => {
                this.frame = undefined;
                this.layout();
            });
        }
    };

    private layout = (): void => {
        const viewport = window.visualViewport;
        this.view.style.height = `${viewport?.height || window.innerHeight}px`;
        this.view.style.top = `${viewport?.offsetTop || 0}px`;
        // The input layer must use the same fit mode as the rendered pixels.
        this.player.getTouchableElement().dataset.videoFit = this.fit;
        const size = this.player.getScreenInfo()?.videoSize;
        if (!size || !size.width || !size.height) {
            return;
        }
        const style = getComputedStyle(this.view);
        const width = this.view.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const height = this.view.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        const scale = Math.min(width / size.width, height / size.height);
        this.video.style.width = `${Math.max(1, this.fit === 'fill' ? width : size.width * scale)}px`;
        this.video.style.height = `${Math.max(1, this.fit === 'fill' ? height : size.height * scale)}px`;
    };

    public release(): void {
        this.player.off('video-view-resize', this.layout);
        window.removeEventListener('resize', this.scheduleLayout);
        window.visualViewport?.removeEventListener('resize', this.scheduleLayout);
        window.visualViewport?.removeEventListener('scroll', this.scheduleLayout);
        if (typeof this.frame === 'number') {
            cancelAnimationFrame(this.frame);
        }
        this.toggle.remove();
        this.closeMenu.remove();
        this.fitControl.remove();
        delete this.player.getTouchableElement().dataset.videoFit;
    }
}
