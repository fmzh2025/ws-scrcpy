import { NetworkRouteStatus } from '../../../types/NetworkRouteStatus';
import {
    deviceVpnActionLabel,
    hostDirectActionLabel,
    hostVpnActionLabel,
    hostVpnTrackingMessage,
    networkStatusFailure,
    routeLabel,
    statusDetails,
    statusHeadline,
    statusSummary,
    statusTone,
    statusVerification,
} from './NetworkStatusPresentation';

type NetworkAction =
    | 'apply-host-vpn'
    | 'apply-host-direct'
    | 'lock-device-vpn'
    | 'clear-android-proxy'
    | 'lock-current'
    | 'unlock';

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
    private readonly diagnostics: HTMLElement;
    private readonly hostVpnButton: HTMLButtonElement;
    private readonly hostDirectButton: HTMLButtonElement;
    private readonly deviceVpnButton: HTMLButtonElement;
    private readonly hostVpnTracking: HTMLElement;
    private readonly actionButtons: HTMLButtonElement[];
    private statusAvailable = false;
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
            const opening = !this.popover.classList.contains('open');
            if (opening) {
                this.positionPopover();
            }
            this.popover.classList.toggle('open', opening);
            this.trigger.setAttribute('aria-expanded', opening ? 'true' : 'false');
        });
        this.trigger.setAttribute('aria-expanded', 'false');

        this.popover = document.createElement('section');
        this.popover.className = 'stream-network-popover';
        this.popover.setAttribute('role', 'dialog');
        this.popover.setAttribute('aria-label', 'Network status and proxy controls');

        this.status = document.createElement('strong');
        this.status.className = 'stream-network-ip';
        this.status.textContent = '正在读取云手机实际出口…';
        this.details = document.createElement('div');
        this.details.className = 'stream-network-summary';
        this.details.textContent = '尚未验证出口 IP，请勿先打开业务 App。';
        const diagnosticsDisclosure = document.createElement('details');
        diagnosticsDisclosure.className = 'stream-network-diagnostics';
        const diagnosticsSummary = document.createElement('summary');
        diagnosticsSummary.textContent = '查看检测详情';
        this.diagnostics = document.createElement('div');
        this.diagnostics.className = 'stream-network-details';
        diagnosticsDisclosure.append(diagnosticsSummary, this.diagnostics);

        this.hostVpnButton = this.createButton('使用宿主 VPN（验证并锁定）', () => this.runAction('apply-host-vpn'));
        this.hostVpnButton.classList.add('primary');
        this.hostVpnButton.title = '停止第三方应用，验证云手机实际出口与宿主 VPN 一致，然后锁定该出口';
        this.hostDirectButton = this.createButton('不用宿主 VPN（验证并锁定）', () =>
            this.runAction('apply-host-direct'),
        );
        this.hostDirectButton.classList.add('primary');
        this.hostDirectButton.title =
            '保持宿主 VPN 开启，但强制云手机经宿主物理网卡直连；验证真实 IP 后锁定并阻断旁路泄漏';
        this.deviceVpnButton = this.createButton('使用手机 VPN（验证并锁定）', () => this.runAction('lock-device-vpn'));
        this.deviceVpnButton.classList.add('primary');
        this.deviceVpnButton.title = '请先在云手机内启动全局 VPN，再验证并锁定手机 VPN 的实际出口';
        const lockButton = this.createButton('重新锁定当前实测 IP', () => this.runAction('lock-current'));
        lockButton.title = '把当前已经验证的出口重新设为防漂移基准';
        const clearButton = this.createButton('仅清除 Android HTTP 代理', () => this.runAction('clear-android-proxy'));
        clearButton.title = '只清除 Android HTTP 代理；不会关闭宿主 VPN，也不保证变成国内 IP';
        const unlockButton = this.createButton('关闭 IP 防漂移保护', () => this.runAction('unlock'));
        unlockButton.title = '关闭 IP 变化时的自动停应用和网络拦截';
        this.actionButtons = [
            this.hostVpnButton,
            this.hostDirectButton,
            this.deviceVpnButton,
            lockButton,
            clearButton,
            unlockButton,
        ];
        this.setActionsDisabled(true);

        const requirements = document.createElement('div');
        requirements.className = 'stream-network-requirements';
        const hostModeActions = document.createElement('div');
        hostModeActions.className = 'stream-network-mode-actions';
        hostModeActions.append(this.hostVpnButton, this.hostDirectButton);
        requirements.append(
            this.createRequirement(
                '① 选择宿主网络路径',
                '二选一：使用宿主 VPN，或绕过宿主 VPN 使用物理网络；均以云手机内部实测 IP 为准。',
                hostModeActions,
            ),
            this.createRequirement(
                '② 使用手机 VPN',
                '先在云手机内启动全局 VPN，再验证并锁定；该出口与宿主 VPN 相互隔离。',
                this.deviceVpnButton,
            ),
        );
        this.hostVpnTracking = document.createElement('p');
        this.hostVpnTracking.className = 'stream-network-requirement-description';
        this.hostVpnTracking.textContent = '等待网络状态后开始监控。';
        requirements.append(this.createRequirement('③ 宿主节点切换自动检测', this.hostVpnTracking));

        const advanced = document.createElement('details');
        advanced.className = 'stream-network-advanced';
        const advancedSummary = document.createElement('summary');
        advancedSummary.textContent = '高级操作（仅用于排障）';
        const advancedHint = document.createElement('p');
        advancedHint.textContent = '这些操作不等于“使用宿主 VPN”，一般无需点击。';
        const advancedActions = document.createElement('div');
        advancedActions.className = 'stream-network-actions';
        advancedActions.append(lockButton, clearButton, unlockButton);
        advanced.append(advancedSummary, advancedHint, advancedActions);

        this.popover.append(this.status, this.details, requirements, diagnosticsDisclosure, advanced);
        this.root.append(this.trigger, this.popover);
        document.addEventListener('visibilitychange', this.onVisibilityChange);
        window.addEventListener('resize', this.onResize);
        void this.refresh();
        this.startRefreshTimer();
    }

    public getElement(): HTMLElement {
        return this.root;
    }

    public release(): void {
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        window.removeEventListener('resize', this.onResize);
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

    private onResize = (): void => {
        if (this.popover.classList.contains('open')) {
            this.positionPopover();
        }
    };

    private positionPopover(): void {
        const rootRect = this.root.getBoundingClientRect();
        const edgePadding = 8;
        const gap = 6;
        const leftSpace = Math.max(0, rootRect.left - edgePadding - gap);
        const rightSpace = Math.max(0, window.innerWidth - rootRect.right - edgePadding - gap);
        const openLeft = leftSpace >= rightSpace;
        const availableWidth = openLeft ? leftSpace : rightSpace;

        if (availableWidth < 260) {
            this.popover.style.position = 'fixed';
            this.popover.style.left = `${edgePadding}px`;
            this.popover.style.right = `${edgePadding}px`;
            this.popover.style.bottom = `${edgePadding}px`;
            this.popover.style.width = 'auto';
            return;
        }

        this.popover.style.position = 'absolute';
        this.popover.style.bottom = '0';
        this.popover.style.width = `${Math.min(420, availableWidth)}px`;
        if (openLeft) {
            this.popover.style.left = 'auto';
            this.popover.style.right = 'calc(100% + .35rem)';
        } else {
            this.popover.style.left = 'calc(100% + .35rem)';
            this.popover.style.right = 'auto';
        }
    }

    private createButton(label: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    }

    private createRequirement(title: string, description: string | HTMLElement, action?: HTMLElement): HTMLElement {
        const requirement = document.createElement('section');
        requirement.className = 'stream-network-requirement';
        const heading = document.createElement('strong');
        heading.className = 'stream-network-requirement-title';
        heading.textContent = title;
        requirement.appendChild(heading);
        if (typeof description === 'string') {
            const paragraph = document.createElement('p');
            paragraph.className = 'stream-network-requirement-description';
            paragraph.textContent = description;
            requirement.appendChild(paragraph);
        } else {
            requirement.appendChild(description);
        }
        if (action) {
            requirement.appendChild(action);
        }
        return requirement;
    }

    private setActionsDisabled(disabled: boolean): void {
        this.actionButtons.forEach((button) => (button.disabled = disabled));
    }

    private async refresh(force = false): Promise<void> {
        try {
            const response = await fetch(
                this.endpoint(`network/status?udid=${encodeURIComponent(this.udid)}${force ? '&refresh=1' : ''}`),
                { cache: 'no-store' },
            );
            const result = (await response.json().catch(() => ({}))) as NetworkStatusResponse;
            if (!response.ok || !result.status) {
                this.renderUnavailable(response.status, result.output);
                return;
            }
            this.render(result.status);
        } catch (error: unknown) {
            this.renderUnavailable(undefined, error instanceof Error ? error.message : undefined);
        }
    }

    private render(status: NetworkRouteStatus): void {
        this.statusAvailable = true;
        this.status.textContent = `${statusHeadline(status)} · ${routeLabel(status)}`;
        this.trigger.title = statusDetails(status).join('\n');
        this.root.setAttribute('data-network-tone', statusTone(status));
        this.details.textContent = statusVerification(status);
        this.diagnostics.replaceChildren(
            ...statusDetails(status).map((line) => {
                const element = document.createElement('span');
                element.textContent = line;
                return element;
            }),
        );
        this.trigger.setAttribute('aria-label', statusSummary(status));
        this.hostVpnButton.textContent = hostVpnActionLabel(status);
        this.hostDirectButton.textContent = hostDirectActionLabel(status);
        this.deviceVpnButton.textContent = deviceVpnActionLabel(status);
        this.hostVpnTracking.textContent = hostVpnTrackingMessage(status);
        this.hostVpnTracking.setAttribute(
            'data-network-tone',
            status.protection.drifted && status.protection.expectedRoute === 'host-vpn' ? 'danger' : statusTone(status),
        );
        this.setActionsDisabled(false);
    }

    private renderUnavailable(httpStatus?: number, output?: string): void {
        const failure = networkStatusFailure(httpStatus, output);
        this.statusAvailable = false;
        this.status.textContent = failure.headline;
        this.details.textContent = failure.details;
        this.diagnostics.replaceChildren();
        this.hostVpnTracking.textContent = '自动检测暂不可用；接口恢复前无法确认宿主节点或云手机出口变化。';
        this.hostVpnTracking.setAttribute('data-network-tone', 'danger');
        this.trigger.title = `${failure.headline}\n${failure.details}`;
        this.trigger.setAttribute('aria-label', failure.headline);
        this.root.setAttribute('data-network-tone', 'danger');
        this.setActionsDisabled(true);
    }

    private async runAction(action: NetworkAction): Promise<void> {
        if (!this.statusAvailable) {
            return;
        }
        this.setActionsDisabled(true);
        try {
            const response = await fetch(this.endpoint('network/proxy'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ udid: this.udid, action }),
            });
            const result = (await response.json().catch(() => ({}))) as NetworkStatusResponse;
            if (!response.ok) {
                if (response.status === 404) {
                    this.renderUnavailable(response.status, result.output);
                } else {
                    this.details.textContent = `操作失败：${result.output || `HTTP ${response.status}`}`;
                    this.root.setAttribute('data-network-tone', 'danger');
                }
                return;
            }
            if (result.status) {
                this.render(result.status);
            } else {
                await this.refresh(true);
            }
        } catch (error: unknown) {
            this.renderUnavailable(undefined, error instanceof Error ? error.message : '网络操作请求失败');
        } finally {
            this.setActionsDisabled(!this.statusAvailable);
        }
    }

    private endpoint(path: string): string {
        const pathname = window.location.pathname.endsWith('/')
            ? window.location.pathname
            : `${window.location.pathname}/`;
        return new URL(`${pathname}api/${path}`, window.location.origin).toString();
    }
}
