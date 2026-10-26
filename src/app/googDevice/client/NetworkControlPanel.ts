type NetworkStatus = {
    ip?: string;
    country?: string;
    countryCode?: string;
    region?: string;
    city?: string;
    checkedAt: number;
    ipSource?: string;
    proxy: string;
    proxyWarning: boolean;
    hostVpn: {
        available: boolean;
        proxy: string;
        ip?: string;
        country?: string;
        region?: string;
        city?: string;
        error?: string;
    };
};

type NetworkStatusResponse = {
    status?: NetworkStatus;
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
        });

        this.popover = document.createElement('section');
        this.popover.className = 'stream-network-popover';
        this.popover.setAttribute('role', 'dialog');
        this.popover.setAttribute('aria-label', 'Network status and proxy controls');

        this.status = document.createElement('strong');
        this.status.className = 'stream-network-ip';
        this.status.textContent = 'IP checking...';
        this.details = document.createElement('span');
        this.details.className = 'stream-network-details';
        this.details.textContent = 'Checking region';
        let buttons: HTMLButtonElement[] = [];
        const clearButton = this.createButton('Clear proxy', () => this.changeProxy('clear', buttons));
        const rebootButton = this.createButton('Restart + apply host VPN', () =>
            this.changeProxy('host-vpn', buttons, true),
        );
        buttons = [clearButton, rebootButton];
        this.popover.append(this.status, this.details, clearButton, rebootButton);
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
            this.refreshTimer = window.setInterval(() => void this.refresh(), 60_000);
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
            void this.refresh();
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

    private async refresh(): Promise<void> {
        try {
            const response = await fetch(this.endpoint(`network/status?udid=${encodeURIComponent(this.udid)}`));
            const result = (await response.json().catch(() => ({}))) as NetworkStatusResponse;
            if (!response.ok || !result.status) {
                throw new Error(result.output || `Unable to read network status (${response.status})`);
            }
            const status = result.status;
            const verified = status.ipSource === 'emulator-network' && !!status.ip;
            this.status.textContent = verified ? `Emulator IP: ${status.ip}` : 'Emulator IP not verified';
            const location = [status.country, status.region, status.city].filter(Boolean).join(' / ');
            const proxy =
                status.proxy && status.proxy !== ':0' ? `Android proxy: ${status.proxy}` : 'Android proxy: off';
            const checked = new Date(status.checkedAt).toLocaleTimeString();
            const summary = `${verified ? status.ip : 'IP not verified'} | ${
                location || 'Unknown region'
            } | ${proxy} | ${verified ? 'verified in emulator' : 'verification failed'}`;
            this.trigger.title = summary;
            const vpnLocation = [status.hostVpn.country, status.hostVpn.region, status.hostVpn.city]
                .filter(Boolean)
                .join(' / ');
            const vpnText = status.hostVpn.available
                ? `Host VPN exit: ${status.hostVpn.ip || 'IP unavailable'}${vpnLocation ? `, ${vpnLocation}` : ''}`
                : `Host VPN: off (${status.hostVpn.error || 'unavailable'})`;
            this.details.textContent = `${location || 'Unknown region'} | ${proxy} | ${vpnText} | ${
                verified ? 'verified in emulator' : 'IP not verified'
            } | checked ${checked}`;
            this.details.classList.toggle('network-warning', !verified || status.proxyWarning);
        } catch (error: unknown) {
            this.status.textContent = 'Emulator IP unavailable';
            this.details.textContent = error instanceof Error ? error.message : 'Network status failed';
            this.trigger.title = this.details.textContent;
            this.details.classList.add('network-warning');
        }
    }

    private async changeProxy(mode: 'clear' | 'host-vpn', buttons: HTMLButtonElement[], reboot = false): Promise<void> {
        buttons.forEach((button) => (button.disabled = true));
        try {
            const response = await fetch(this.endpoint('network/proxy'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ udid: this.udid, mode, reboot }),
            });
            const result = (await response.json().catch(() => ({}))) as NetworkStatusResponse & { rebooting?: boolean };
            if (!response.ok) {
                throw new Error(result.output || `Unable to change proxy (${response.status})`);
            }
            this.details.textContent = result.rebooting
                ? 'Device restarting; waiting to verify proxy...'
                : 'Apps stopped; proxy applied';
            if (result.rebooting) {
                [12_000, 24_000, 36_000].forEach((delay) => {
                    window.setTimeout(() => void this.refresh(), delay);
                });
            } else {
                await this.refresh();
            }
        } catch (error: unknown) {
            this.details.textContent = error instanceof Error ? error.message : 'Proxy change failed';
            this.details.classList.add('network-warning');
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
