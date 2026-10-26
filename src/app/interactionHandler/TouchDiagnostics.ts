import { ControlMessage } from '../controlMessage/ControlMessage';
import { TouchControlMessage } from '../controlMessage/TouchControlMessage';

const TOUCH_EVENTS = ['touchstart', 'touchmove', 'touchend', 'touchcancel'] as const;

/** On-device counters, enabled from the More menu or with touchDebug=1. */
export class TouchDiagnostics {
    private static current?: TouchDiagnostics;
    private readonly element = document.createElement('div');
    private readonly menuPanel = document.createElement('section');
    private readonly menuOutput = document.createElement('pre');
    private readonly enabledInput = document.createElement('input');
    private enabled = false;
    private readonly counts = { touchstart: 0, touchmove: 0, touchend: 0, touchcancel: 0 };
    private generatedCount = 0;
    private sentCount = 0;
    private failedCount = 0;
    private readonly generatedActions = [0, 0, 0];
    private readonly sentActions = [0, 0, 0];
    private downPressure = '-';
    private maxPressure = 0;
    private lastError = '';
    private lastTarget = '-';
    private status = '等待触摸';

    public static create(canvas: HTMLCanvasElement, menu: HTMLElement, playerName: string): TouchDiagnostics {
        const hash = new URLSearchParams(location.hash.replace(/^#!/, ''));
        const search = new URLSearchParams(location.search);
        this.current?.release();
        return (this.current = new TouchDiagnostics(
            canvas,
            menu,
            playerName,
            hash.get('touchDebug') === '1' || search.get('touchDebug') === '1',
        ));
    }

    private constructor(
        private readonly canvas: HTMLCanvasElement,
        menu: HTMLElement,
        private readonly playerName: string,
        enabled: boolean,
    ) {
        this.element.className = 'touch-diagnostics';
        this.menuPanel.className = 'touch-diagnostics-menu';
        const version = document.createElement('div');
        version.textContent = '触控版本：iPhone-v4-20261026';
        const label = document.createElement('label');
        this.enabledInput.type = 'checkbox';
        this.enabledInput.onchange = () => this.setEnabled(this.enabledInput.checked);
        label.appendChild(this.enabledInput);
        label.appendChild(document.createTextNode(' 启用触控诊断'));
        this.menuPanel.appendChild(version);
        this.menuPanel.appendChild(label);
        this.menuPanel.appendChild(this.menuOutput);
        menu.insertBefore(this.menuPanel, menu.children[1] || null);
        this.setEnabled(enabled);
    }

    private setEnabled(enabled: boolean): void {
        this.enabledInput.checked = enabled;
        if (this.enabled !== enabled) {
            this.enabled = enabled;
            if (enabled) {
                document.body.appendChild(this.element);
                TOUCH_EVENTS.forEach((name) =>
                    document.addEventListener(name, this.onTouch, { capture: true, passive: true }),
                );
            } else {
                this.element.remove();
                TOUCH_EVENTS.forEach((name) => document.removeEventListener(name, this.onTouch, true));
            }
        }
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
        if (this.current?.enabled) {
            this.current.status = reason;
            this.current.render();
        }
    }

    public static generated(messages: ControlMessage[], eventType: string): void {
        const current = this.current;
        if (!current?.enabled) {
            return;
        }
        const touches = messages.filter(
            (message) => message.type === ControlMessage.TYPE_TOUCH,
        ) as TouchControlMessage[];
        current.generatedCount += touches.length;
        touches.forEach((message) => {
            if (message.action >= 0 && message.action < current.generatedActions.length) {
                current.generatedActions[message.action]++;
            }
            if (message.action === 0) {
                current.downPressure = String(message.pressure);
                if (Number.isFinite(message.pressure)) {
                    current.maxPressure = Math.max(current.maxPressure, message.pressure);
                }
            }
        });
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
        if (!this.current?.enabled || message.type !== ControlMessage.TYPE_TOUCH) {
            return;
        }
        if (connected) {
            this.current.sentCount++;
            const action = (message as TouchControlMessage).action;
            if (action >= 0 && action < this.current.sentActions.length) {
                this.current.sentActions[action]++;
            }
        } else {
            this.current.status = '连接未就绪，消息已排队';
        }
        this.current.render();
    }

    public static failed(message: ControlMessage, error: unknown): void {
        if (!this.current?.enabled || message.type !== ControlMessage.TYPE_TOUCH) {
            return;
        }
        this.current.failedCount++;
        const touch = message as TouchControlMessage;
        const detail = error instanceof Error ? error.message : String(error);
        this.current.lastError = `发送异常 action=${touch.action} pressure=${touch.pressure}: ${detail}`;
        this.current.render();
    }

    private render(): void {
        if (!this.enabled) {
            this.menuOutput.textContent = '勾选后，关闭菜单并触摸云手机画面，再打开菜单查看计数。';
            return;
        }
        const { touchstart, touchmove, touchend, touchcancel } = this.counts;
        const text = [
            '触控诊断 · iPhone-v4-20261026',
            `播放器：${this.playerName}`,
            `收到：按 ${touchstart} 移 ${touchmove} 抬 ${touchend} 取消 ${touchcancel}`,
            `生成 ${this.generatedCount} / 已发 ${this.sentCount} / 失败 ${this.failedCount}`,
            `按下 ${this.generatedActions[0]}/${this.sentActions[0]} 抬起 ${this.generatedActions[1]}/${this.sentActions[1]}（生成/已发）`,
            `原始按压力 ${this.downPressure}，最高 ${this.maxPressure}`,
            `命中：${this.lastTarget}`,
            this.status,
            ...(this.lastError ? [this.lastError] : []),
        ].join('\n');
        this.element.textContent = this.menuOutput.textContent = text;
    }

    public release(): void {
        TOUCH_EVENTS.forEach((name) => document.removeEventListener(name, this.onTouch, true));
        this.element.remove();
        this.menuPanel.remove();
        this.enabledInput.onchange = null;
        if (TouchDiagnostics.current === this) {
            TouchDiagnostics.current = undefined;
        }
    }
}
