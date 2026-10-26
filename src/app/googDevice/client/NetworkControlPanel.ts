import { NetworkRouteStatus } from '../../../types/NetworkRouteStatus';
import { statusDetails, statusHeadline, statusSummary, statusTone } from './NetworkStatusPresentation';

type NetworkAction = 'apply-host-vpn' | 'lock-device-vpn' | 'clear-android-proxy' | 'lock-current' | 'unlock';

type NetworkStatusResponse = {
    status?: NetworkRouteStatus;
    output?: string;
};

export class NetworkControlPanel {
    private readonly root: HTMLElement;
    private readonly trigger: HTMLButtonElement;
    private readonly popover: HTMLElement;
    private readonly status: HTMLElement;
    private readonly details: HTMLElement;
    private refreshTimer?: number;

    public constructor(private readonly udid: string) {
        this.root = document.createElement('section');
        this.root.className = 'stream-network-control';
        this.root.setAttribute('aria-label', 'Network status and proxy controls');

        this.trigger = document.createElement('button');
        this.trigger.type = 'button';
        this.trigger.className = 'stream-network-trigger';
        this.trigger.textContent = 'IP';
        this.trigger.title = 'Network status: checking...';
        this.trigger.setAttribute('aria-label', 'Show network status and proxy controls');
        this.trigger.addEventListener('click', () => {
            this.popover.classList.toggle('open');
            this.trigger.setAttribute('aria-expanded', this.popover.classList.contains('open') ? 'true' : 'false');
        });
        this.trigger.setAttribute('aria-expanded', 'false');

        this.popover = document.createElement('section');
        this.popover.className = 'stream-network-popover';
        this.popover.setAttribute('role', 'dialog');
        this.popover.setAttribute('aria-label', 'Network status and proxy controls');

        this.status = document.createElement('strong');
        this.status.className = 'stream-network-ip';
        this.status.textContent = 'IP checking...';
        this.details = document.createElement('div');
        this.details.className = 'stream-network-details';
        this.details.textContent = 'Checking region';
        let buttons: HTMLButtonElement[] = [];
        const hostVpnButton = this.createButton('应用并锁定宿主 VPN', () => this.runAction('apply-host-vpn', buttons));
        const deviceVpnButton = this.createButton('锁定手机 VPN', () => this.runAction('lock-device-vpn', buttons));
        const lockButton = this.createButton('锁定当前出口', () => this.runAction('lock-current', buttons));
        const clearButton = this.createButton('仅清 Android 代理', () =>
            this.runAction('clear-android-proxy', buttons),
        );
        const unlockButton = this.createButton('解除 IP 锁定', () => this.runAction('unlock', buttons));
        buttons = [hostVpnButton, deviceVpnButton, lockButton, clearButton, unlockButton];
        const buttonGroup = document.createElement('div');
        buttonGroup.className = 'stream-network-actions';
        buttonGroup.append(...buttons);
        this.popover.append(this.status, this.details, buttonGroup);
        this.root.append(this.trigger, this.popover);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
        void this.refresh();
        this.startRefreshTimer();
    }

    public getElement(): HTMLElement {
        return this.root;
    }

    public release(): void {
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        this.stopRefreshTimer();
        this.root.remove();
    }

    private startRefreshTimer(): void {
        this.stopRefreshTimer();
        if (!document.hidden) {
            this.refreshTimer = window.setInterval(() => void this.refresh(true), 15_000);
        }
    }

    private stopRefreshTimer(): void {
        if (this.refreshTimer) {
            window.clearInterval(this.refreshTimer);
            this.refreshTimer = undefined;
        }
    }

    private onVisibilityChange = (): void => {
        if (document.hidden) {
            this.stopRefreshTimer();
        } else {
            void this.refresh(true);
            this.startRefreshTimer();
        }
    };

    private createButton(label: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    }

    private async refresh(force = false): Promise<void> {
        try {
            const response = await fetch(
                this.endpoint(`network/status?udid=${encodeURIComponent(this.udid)}${force ? '&refresh=1' : ''}`),
                { cache: 'no-store' },
            );
            const result = (await response.json().catch(() => ({}))) as NetworkStatusResponse;
            if (!response.ok || !result.status) {
                throw new Error(result.output || `Unable to read network status (${response.status})`);
            }
            this.render(result.status);
        } catch (error: unknown) {
            this.status.textContent = '实际出口 IP：检测失败';
            this.details.textContent = error instanceof Error ? error.message : 'Network status failed';
            this.trigger.title = this.details.textContent;
            this.root.setAttribute('data-network-tone', 'danger');
        }
    }

    private render(status: NetworkRouteStatus): void {
        this.status.textContent = statusHeadline(status);
        this.trigger.title = statusDetails(status).join('\n');
        this.root.setAttribute('data-network-tone', statusTone(status));
        this.details.replaceChildren(
            ...statusDetails(status).map((line) => {
                const element = document.createElement('span');
                element.textContent = line;
                return element;
            }),
        );
        this.trigger.setAttribute('aria-label', statusSummary(status));
    }

    private async runAction(action: NetworkAction, buttons: HTMLButtonElement[]): Promise<void> {
        buttons.forEach((button) => (button.disabled = true));
        try {
            const response = await fetch(this.endpoint('network/proxy'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ udid: this.udid, action }),
            });
            const result = (await response.json().catch(() => ({}))) as NetworkStatusResponse;
            if (!response.ok) {
                throw new Error(result.output || `Unable to change proxy (${response.status})`);
            }
            if (result.status) {
                this.render(result.status);
            } else {
                await this.refresh(true);
            }
        } catch (error: unknown) {
            this.details.textContent = error instanceof Error ? error.message : 'Proxy change failed';
            this.root.setAttribute('data-network-tone', 'danger');
        } finally {
            buttons.forEach((button) => (button.disabled = false));
        }
    }

    private endpoint(path: string): string {
        const pathname = window.location.pathname.endsWith('/')
            ? window.location.pathname
            : `${window.location.pathname}/`;
        return new URL(`${pathname}api/${path}`, window.location.origin).toString();
    }
}
