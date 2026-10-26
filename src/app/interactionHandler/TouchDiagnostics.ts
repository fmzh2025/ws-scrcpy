import { ControlMessage } from '../controlMessage/ControlMessage';
import { TouchControlMessage } from '../controlMessage/TouchControlMessage';

const TOUCH_EVENTS = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const;

/** Optional on-device counters, enabled by touchDebug=1 in the stream URL. */
export class TouchDiagnostics {
    private static current?: TouchDiagnostics;
    private readonly element = document.createElement('div');
    private readonly counts = { touchstart: 0, touchmove: 0, touchend: 0, touchcancel: 0 };
    private generatedCount = 0;
    private sentCount = 0;
    private lastTarget = '-';
    private status = '等待触摸';

    public static create(canvas: HTMLCanvasElement): TouchDiagnostics | undefined {
        const hash = new URLSearchParams(location.hash.replace(/^#!/, ''));
        const search = new URLSearchParams(location.search);
        if (hash.get('touchDebug') !== '1' && search.get('touchDebug') !== '1') {
            return;
        }
        this.current?.release();
        return (this.current = new TouchDiagnostics(canvas));
    }

    private constructor(private readonly canvas: HTMLCanvasElement) {
        this.element.className = 'touch-diagnostics';
        document.body.appendChild(this.element);
        TOUCH_EVENTS.forEach((name) => document.addEventListener(name, this.onTouch, { capture: true, passive: true }));
        this.render();
    }

    private onTouch = (event: TouchEvent): void => {
        this.counts[event.type as keyof typeof this.counts]++;
        const target = event.target as Element | null;
        const touch = event.changedTouches[0];
        this.lastTarget = `${target?.tagName || '-'}${target === this.canvas ? ' 控制层' : ' 其他层'}`;
        if (touch) {
            this.lastTarget += ` ${Math.round(touch.clientX)},${Math.round(touch.clientY)}`;
        }
        this.render();
    };

    public static ignored(reason: string): void {
        if (this.current) {
            this.current.status = reason;
            this.current.render();
        }
    }

    public static generated(messages: ControlMessage[], eventType: string): void {
        const current = this.current;
        if (!current) {
            return;
        }
        const touches = messages.filter(
            (message) => message.type === ControlMessage.TYPE_TOUCH,
        ) as TouchControlMessage[];
        current.generatedCount += touches.length;
        if (touches.length) {
            const last = touches[touches.length - 1];
            const { point, screenSize } = last.position;
            current.status = `坐标 ${Math.round(point.x)},${Math.round(point.y)} / ${screenSize.width}×${
                screenSize.height
            }`;
        } else if (eventType.startsWith('touch')) {
            current.status = '未生成消息：检查触点范围或按下/抬起状态';
        }
        current.render();
    }

    public static sent(message: ControlMessage, connected: boolean): void {
        if (!this.current || message.type !== ControlMessage.TYPE_TOUCH) {
            return;
        }
        if (connected) {
            this.current.sentCount++;
        } else {
            this.current.status = '连接未就绪，消息已排队';
        }
        this.current.render();
    }

    private render(): void {
        const { touchstart, touchmove, touchend, touchcancel } = this.counts;
        this.element.textContent = [
            '触控诊断 · iPhone-v1-20261026',
            `收到：按 ${touchstart} 移 ${touchmove} 抬 ${touchend} 取消 ${touchcancel}`,
            `生成 ${this.generatedCount} / 已发 ${this.sentCount}`,
            `命中：${this.lastTarget}`,
            this.status,
        ].join('\n');
    }

    public release(): void {
        TOUCH_EVENTS.forEach((name) => document.removeEventListener(name, this.onTouch, true));
        this.element.remove();
        if (TouchDiagnostics.current === this) {
            TouchDiagnostics.current = undefined;
        }
    }
}
