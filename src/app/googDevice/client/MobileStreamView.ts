import { BasePlayer } from '../../player/BasePlayer';
import Size from '../../Size';
import VideoSettings from '../../VideoSettings';
import { DisplayProfileControl } from './DisplayProfileControl';

/** Size the presentation independently of the encoded video. */
export class MobileStreamView {
    private readonly toggle = document.createElement('button');
    private readonly closeMenu = document.createElement('button');
    private readonly displayControl: DisplayProfileControl;
    private frame?: number;

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
        udid: string,
        suspend: (suspended: boolean) => void,
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
        // Ignore the previous release's saved fill preference: all mobile video
        // now keeps its proportions. Android's display is adapted explicitly.
        this.displayControl = new DisplayProfileControl(udid, player, view, video, menu, suspend);
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
        this.player.getTouchableElement().dataset.videoFit = 'contain';
        const size = this.player.getScreenInfo()?.videoSize;
        if (!size || !size.width || !size.height) {
            return;
        }
        const style = getComputedStyle(this.view);
        const width = this.view.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
        const height = this.view.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom);
        const scale = Math.min(width / size.width, height / size.height);
        this.video.style.width = `${Math.max(1, size.width * scale)}px`;
        this.video.style.height = `${Math.max(1, size.height * scale)}px`;
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
        this.displayControl.release();
        delete this.player.getTouchableElement().dataset.videoFit;
    }
}
