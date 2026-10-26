import '../../../style/devicelist.css';
import { BaseDeviceTracker } from '../../client/BaseDeviceTracker';
import { SERVER_PORT } from '../../../common/Constants';
import { ACTION } from '../../../common/Action';
import GoogDeviceDescriptor from '../../../types/GoogDeviceDescriptor';
import { ControlCenterCommand } from '../../../common/ControlCenterCommand';
import { StreamClientScrcpy } from './StreamClientScrcpy';
import { StreamReceiverScrcpy } from './StreamReceiverScrcpy';
import SvgImage from '../../ui/SvgImage';
import { html } from '../../ui/HtmlTag';
import Util from '../../Util';
import { Attribute } from '../../Attribute';
import { DeviceState } from '../../../common/DeviceState';
import { Message } from '../../../types/Message';
import { ParamsDeviceTracker } from '../../../types/ParamsDeviceTracker';
import { HostItem } from '../../../types/Configuration';
import { ChannelCode } from '../../../common/ChannelCode';
import { Tool } from '../../client/Tool';

type Field = keyof GoogDeviceDescriptor | ((descriptor: GoogDeviceDescriptor) => string);
type DescriptionColumn = { title: string; field: Field };
type NetworkStatus = {
    ip?: string;
    country?: string;
    countryCode?: string;
    region?: string;
    city?: string;
    isp?: string;
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

type NetworkEntry = {
    status: HTMLElement;
    details: HTMLElement;
    buttons: HTMLButtonElement[];
};

const DESC_COLUMNS: DescriptionColumn[] = [
    {
        title: 'Net Interface',
        field: 'interfaces',
    },
    {
        title: 'Server PID',
        field: 'pid',
    },
];

export class DeviceTracker extends BaseDeviceTracker<GoogDeviceDescriptor, never> {
    public static readonly ACTION = ACTION.GOOG_DEVICE_LIST;
    public static readonly CREATE_DIRECT_LINKS = true;
    private static instancesByUrl: Map<string, DeviceTracker> = new Map();
    protected static tools: Set<Tool> = new Set();
    protected tableId = 'goog_device_list';
    private readonly networkEntries: Map<string, NetworkEntry> = new Map();
    private networkRefreshTimer?: number;

    public static start(hostItem: HostItem): DeviceTracker {
        const url = this.buildUrlForTracker(hostItem).toString();
        let instance = this.instancesByUrl.get(url);
        if (!instance) {
            instance = new DeviceTracker(hostItem, url);
        }
        return instance;
    }

    public static getInstance(hostItem: HostItem): DeviceTracker {
        return this.start(hostItem);
    }

    protected constructor(params: HostItem, directUrl: string) {
        super({ ...params, action: DeviceTracker.ACTION }, directUrl);
        DeviceTracker.instancesByUrl.set(directUrl, this);
        this.buildDeviceTable();
        this.openNewConnection();
        document.addEventListener('visibilitychange', this.onVisibilityChange);
        this.startNetworkRefreshTimer();
    }

    protected onSocketOpen(): void {
        // nothing here;
    }

    protected setIdAndHostName(id: string, hostName: string): void {
        super.setIdAndHostName(id, hostName);
        for (const value of DeviceTracker.instancesByUrl.values()) {
            if (value.id === id && value !== this) {
                console.warn(
                    `Tracker with url: "${this.url}" has the same id(${this.id}) as tracker with url "${value.url}"`,
                );
                console.warn(`This tracker will shut down`);
                this.destroy();
            }
        }
    }

    onInterfaceSelected = (event: Event): void => {
        const selectElement = event.currentTarget as HTMLSelectElement;
        const option = selectElement.selectedOptions[0];
        const url = decodeURI(option.getAttribute(Attribute.URL) || '');
        const name = option.getAttribute(Attribute.NAME) || '';
        const fullName = decodeURIComponent(selectElement.getAttribute(Attribute.FULL_NAME) || '');
        const udid = selectElement.getAttribute(Attribute.UDID) || '';
        this.updateLink({ url, name, fullName, udid, store: true });
    };

    private updateLink(params: { url: string; name: string; fullName: string; udid: string; store: boolean }): void {
        const { url, name, fullName, udid, store } = params;
        const playerTds = document.getElementsByName(
            encodeURIComponent(`${DeviceTracker.AttributePrefixPlayerFor}${fullName}`),
        );
        if (typeof udid !== 'string') {
            return;
        }
        if (store) {
            const localStorageKey = DeviceTracker.getLocalStorageKey(fullName || '');
            if (localStorage && name) {
                localStorage.setItem(localStorageKey, name);
            }
        }
        const action = ACTION.STREAM_SCRCPY;
        playerTds.forEach((item) => {
            item.innerHTML = '';
            const playerFullName = item.getAttribute(DeviceTracker.AttributePlayerFullName);
            const playerCodeName = item.getAttribute(DeviceTracker.AttributePlayerCodeName);
            if (!playerFullName || !playerCodeName) {
                return;
            }
            const streamParams = {
                action,
                udid,
                player: decodeURIComponent(playerCodeName),
                ...(StreamReceiverScrcpy.isSameOriginProxyUrl(url, udid) ? {} : { ws: url }),
            };
            const link = DeviceTracker.buildLink(streamParams, decodeURIComponent(playerFullName), this.params);
            item.appendChild(link);
        });
    }

    onActionButtonClick = (event: MouseEvent): void => {
        const button = event.currentTarget as HTMLButtonElement;
        const udid = button.getAttribute(Attribute.UDID);
        const pidString = button.getAttribute(Attribute.PID) || '';
        const command = button.getAttribute(Attribute.COMMAND) as string;
        const pid = parseInt(pidString, 10);
        const data: Message = {
            id: this.getNextId(),
            type: command,
            data: {
                udid: typeof udid === 'string' ? udid : undefined,
                pid: isNaN(pid) ? undefined : pid,
            },
        };

        if (this.ws && this.ws.readyState === this.ws.OPEN) {
            this.ws.send(JSON.stringify(data));
        }
    };

    private static getLocalStorageKey(udid: string): string {
        return `device_list::${udid}::interface`;
    }

    protected static createUrl(params: ParamsDeviceTracker, udid = ''): URL {
        const secure = !!params.secure;
        const hostname = params.hostname || location.hostname;
        const port = typeof params.port === 'number' ? params.port : secure ? 443 : 80;
        const pathname = params.pathname || location.pathname;
        const urlObject = this.buildUrl({ ...params, secure, hostname, port, pathname });
        if (udid) {
            urlObject.searchParams.set('action', ACTION.PROXY_ADB);
            urlObject.searchParams.set('remote', `tcp:${SERVER_PORT.toString(10)}`);
            urlObject.searchParams.set('udid', udid);
        }
        return urlObject;
    }

    protected static createInterfaceOption(name: string, url: string): HTMLOptionElement {
        const optionElement = document.createElement('option');
        optionElement.setAttribute(Attribute.URL, url);
        optionElement.setAttribute(Attribute.NAME, name);
        optionElement.innerText = `proxy over adb`;
        return optionElement;
    }

    private static titleToClassName(title: string): string {
        return title.toLowerCase().replace(/\s/g, '_');
    }

    protected buildDeviceRow(tbody: Element, device: GoogDeviceDescriptor): void {
        let selectedInterfaceUrl = '';
        let selectedInterfaceName = '';
        const blockClass = 'desc-block';
        const fullName = `${this.id}_${Util.escapeUdid(device.udid)}`;
        const isActive = device.state === DeviceState.DEVICE;
        let hasPid = false;
        const servicesId = `device_services_${fullName}`;
        const row = html`<div class="device ${isActive ? 'active' : 'not-active'}">
            <div class="device-header">
                <div class="device-name">${device['ro.product.manufacturer']} ${device['ro.product.model']}</div>
                <div class="device-serial">${device.udid}</div>
                <div class="device-version">
                    <div class="release-version">${device['ro.build.version.release']}</div>
                    <div class="sdk-version">${device['ro.build.version.sdk']}</div>
                </div>
                <div class="device-state" title="State: ${device.state}"></div>
            </div>
            <div id="${servicesId}" class="services"></div>
        </div>`.content;
        const services = row.getElementById(servicesId);
        if (!services) {
            return;
        }

        const networkEntry = this.createNetworkEntry(device.udid);
        services.appendChild(networkEntry);

        DeviceTracker.tools.forEach((tool) => {
            const entry = tool.createEntryForDeviceList(device, blockClass, this.params);
            if (entry) {
                if (Array.isArray(entry)) {
                    entry.forEach((item) => {
                        item && services.appendChild(item);
                    });
                } else {
                    services.appendChild(entry);
                }
            }
        });

        const streamEntry = StreamClientScrcpy.createEntryForDeviceList(device, blockClass, fullName, this.params);
        streamEntry && services.appendChild(streamEntry);

        DESC_COLUMNS.forEach((item) => {
            const { title } = item;
            const fieldName = item.field;
            let value: string;
            if (typeof item.field === 'string') {
                value = '' + device[item.field];
            } else {
                value = item.field(device);
            }
            const td = document.createElement('div');
            td.classList.add(DeviceTracker.titleToClassName(title), blockClass);
            services.appendChild(td);
            if (fieldName === 'pid') {
                hasPid = value !== '-1';
                const actionButton = document.createElement('button');
                actionButton.className = 'action-button kill-server-button';
                actionButton.setAttribute(Attribute.UDID, device.udid);
                actionButton.setAttribute(Attribute.PID, value);
                let command: string;
                if (isActive) {
                    actionButton.classList.add('active');
                    actionButton.onclick = this.onActionButtonClick;
                    if (hasPid) {
                        command = ControlCenterCommand.KILL_SERVER;
                        actionButton.title = 'Kill server';
                        actionButton.appendChild(SvgImage.create(SvgImage.Icon.CANCEL));
                    } else {
                        command = ControlCenterCommand.START_SERVER;
                        actionButton.title = 'Start server';
                        actionButton.appendChild(SvgImage.create(SvgImage.Icon.REFRESH));
                    }
                    actionButton.setAttribute(Attribute.COMMAND, command);
                } else {
                    const timestamp = device['last.update.timestamp'];
                    if (timestamp) {
                        const date = new Date(timestamp);
                        actionButton.title = `Last update on ${date.toLocaleDateString()} at ${date.toLocaleTimeString()}`;
                    } else {
                        actionButton.title = `Not active`;
                    }
                    actionButton.appendChild(SvgImage.create(SvgImage.Icon.OFFLINE));
                }
                const span = document.createElement('span');
                span.innerText = value;
                actionButton.appendChild(span);
                td.appendChild(actionButton);
            } else if (fieldName === 'interfaces') {
                const proxyInterfaceUrl = DeviceTracker.createUrl(this.params, device.udid).toString();
                const proxyInterfaceName = 'proxy';
                const localStorageKey = DeviceTracker.getLocalStorageKey(fullName);
                const lastSelected = localStorage && localStorage.getItem(localStorageKey);
                const selectElement = document.createElement('select');
                selectElement.setAttribute(Attribute.UDID, device.udid);
                selectElement.setAttribute(Attribute.FULL_NAME, fullName);
                selectElement.setAttribute(
                    'name',
                    encodeURIComponent(`${DeviceTracker.AttributePrefixInterfaceSelectFor}${fullName}`),
                );
                /// #if SCRCPY_LISTENS_ON_ALL_INTERFACES
                device.interfaces.forEach((value) => {
                    const params = {
                        ...this.params,
                        secure: false,
                        hostname: value.ipv4,
                        port: SERVER_PORT,
                    };
                    const url = DeviceTracker.createUrl(params).toString();
                    const optionElement = DeviceTracker.createInterfaceOption(value.name, url);
                    optionElement.innerText = `${value.name}: ${value.ipv4}`;
                    selectElement.appendChild(optionElement);
                    if (lastSelected) {
                        if (lastSelected === value.name || !selectedInterfaceName) {
                            optionElement.selected = true;
                            selectedInterfaceUrl = url;
                            selectedInterfaceName = value.name;
                        }
                    } else if (device['wifi.interface'] === value.name) {
                        optionElement.selected = true;
                    }
                });
                /// #else
                selectedInterfaceUrl = proxyInterfaceUrl;
                selectedInterfaceName = proxyInterfaceName;
                td.classList.add('hidden');
                /// #endif
                if (isActive) {
                    const adbProxyOption = DeviceTracker.createInterfaceOption(proxyInterfaceName, proxyInterfaceUrl);
                    if (lastSelected === proxyInterfaceName || !selectedInterfaceName) {
                        adbProxyOption.selected = true;
                        selectedInterfaceUrl = proxyInterfaceUrl;
                        selectedInterfaceName = proxyInterfaceName;
                    }
                    selectElement.appendChild(adbProxyOption);
                    const actionButton = document.createElement('button');
                    actionButton.className = 'action-button update-interfaces-button active';
                    actionButton.title = `Update information`;
                    actionButton.appendChild(SvgImage.create(SvgImage.Icon.REFRESH));
                    actionButton.setAttribute(Attribute.UDID, device.udid);
                    actionButton.setAttribute(Attribute.COMMAND, ControlCenterCommand.UPDATE_INTERFACES);
                    actionButton.onclick = this.onActionButtonClick;
                    td.appendChild(actionButton);
                }
                selectElement.onchange = this.onInterfaceSelected;
                td.appendChild(selectElement);
            } else {
                td.innerText = value;
            }
        });

        if (DeviceTracker.CREATE_DIRECT_LINKS) {
            const name = `${DeviceTracker.AttributePrefixPlayerFor}${fullName}`;
            StreamClientScrcpy.getPlayers().forEach((playerClass) => {
                const { playerCodeName, playerFullName } = playerClass;
                const playerTd = document.createElement('div');
                playerTd.classList.add(blockClass);
                playerTd.setAttribute('name', encodeURIComponent(name));
                playerTd.setAttribute(DeviceTracker.AttributePlayerFullName, encodeURIComponent(playerFullName));
                playerTd.setAttribute(DeviceTracker.AttributePlayerCodeName, encodeURIComponent(playerCodeName));
                services.appendChild(playerTd);
            });
        }

        tbody.appendChild(row);
        if (DeviceTracker.CREATE_DIRECT_LINKS && isActive && selectedInterfaceUrl) {
            this.updateLink({
                url: selectedInterfaceUrl,
                name: selectedInterfaceName,
                fullName,
                udid: device.udid,
                store: false,
            });
        }
    }

    protected getChannelCode(): string {
        return ChannelCode.GTRC;
    }

    public destroy(): void {
        if (this.networkRefreshTimer) {
            window.clearInterval(this.networkRefreshTimer);
            this.networkRefreshTimer = undefined;
        }
        document.removeEventListener('visibilitychange', this.onVisibilityChange);
        this.networkEntries.clear();
        super.destroy();
        DeviceTracker.instancesByUrl.delete(this.url.toString());
        if (!DeviceTracker.instancesByUrl.size) {
            const holder = document.getElementById(BaseDeviceTracker.HOLDER_ELEMENT_ID);
            if (holder && holder.parentElement) {
                holder.parentElement.removeChild(holder);
            }
        }
    }

    private createNetworkEntry(udid: string): HTMLElement {
        const entry = document.createElement('div');
        entry.className = 'network-status desc-block';

        const status = document.createElement('strong');
        status.className = 'network-ip';
        status.textContent = 'IP checking...';
        const details = document.createElement('span');
        details.className = 'network-details';
        details.textContent = 'Checking region';

        let actionButtons: HTMLButtonElement[] = [];
        const clearButton = this.createNetworkButton('Clear proxy', () =>
            this.changeProxy(udid, 'clear', actionButtons),
        );
        const rebootButton = this.createNetworkButton('Restart + apply', () =>
            this.changeProxy(udid, 'host-vpn', actionButtons, true),
        );
        actionButtons = [clearButton, rebootButton];

        entry.append(status, details, clearButton, rebootButton);
        this.networkEntries.set(udid, {
            status,
            details,
            buttons: [clearButton, rebootButton],
        });
        void this.refreshNetworkStatus(udid);
        return entry;
    }

    private startNetworkRefreshTimer(): void {
        if (this.networkRefreshTimer || document.hidden) {
            return;
        }
        this.networkRefreshTimer = window.setInterval(() => {
            this.networkEntries.forEach((_entry, udid) => void this.refreshNetworkStatus(udid));
        }, 60_000);
    }

    private onVisibilityChange = (): void => {
        if (document.hidden) {
            if (this.networkRefreshTimer) {
                window.clearInterval(this.networkRefreshTimer);
                this.networkRefreshTimer = undefined;
            }
            return;
        }
        this.networkEntries.forEach((_entry, udid) => void this.refreshNetworkStatus(udid));
        this.startNetworkRefreshTimer();
    };

    private createNetworkButton(label: string, onClick: () => void): HTMLButtonElement {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'network-action';
        button.textContent = label;
        button.addEventListener('click', onClick);
        return button;
    }

    private async refreshNetworkStatus(udid: string): Promise<void> {
        const entry = this.networkEntries.get(udid);
        if (!entry) {
            return;
        }
        try {
            const response = await fetch(this.endpoint(`network/status?udid=${encodeURIComponent(udid)}`));
            const result = (await response.json().catch(() => ({}))) as { status?: NetworkStatus; output?: string };
            if (!response.ok || !result.status) {
                throw new Error(result.output || `Unable to read network status (${response.status})`);
            }
            const status = result.status;
            const verified = status.ipSource === 'emulator-network' && !!status.ip;
            entry.status.textContent = verified ? `Emulator IP: ${status.ip}` : 'Emulator IP not verified';
            const location = [status.country, status.region, status.city].filter(Boolean).join(' / ');
            const checkedAt = new Date(status.checkedAt).toLocaleTimeString();
            const proxy =
                status.proxy && status.proxy !== ':0' ? `Android proxy: ${status.proxy}` : 'Android proxy: off';
            const vpnLocation = [status.hostVpn.country, status.hostVpn.region, status.hostVpn.city]
                .filter(Boolean)
                .join(' / ');
            const vpnText = status.hostVpn.available
                ? `Host VPN exit: ${status.hostVpn.ip || 'IP unavailable'}${vpnLocation ? `, ${vpnLocation}` : ''}`
                : `Host VPN: off (${status.hostVpn.error || 'unavailable'})`;
            entry.details.textContent = `${location || 'Unknown region'} | ${proxy} | ${vpnText} | ${
                verified ? 'verified in emulator' : 'IP not verified'
            } | checked ${checkedAt}`;
            entry.details.classList.toggle('network-warning', !verified || status.proxyWarning);
        } catch (error: unknown) {
            entry.status.textContent = 'Emulator IP unavailable';
            entry.details.textContent = error instanceof Error ? error.message : 'Network status failed';
            entry.details.classList.add('network-warning');
        }
    }

    private async changeProxy(
        udid: string,
        mode: 'clear' | 'host-vpn',
        buttons: HTMLButtonElement[],
        reboot = false,
    ): Promise<void> {
        buttons.forEach((button) => (button.disabled = true));
        try {
            const response = await fetch(this.endpoint('network/proxy'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ udid, mode, reboot }),
            });
            const result = (await response.json().catch(() => ({}))) as { output?: string; rebooting?: boolean };
            if (!response.ok) {
                throw new Error(result.output || `Unable to change proxy (${response.status})`);
            }
            const entry = this.networkEntries.get(udid);
            if (entry) {
                entry.details.textContent = result.rebooting
                    ? 'Device restarting; waiting to verify proxy...'
                    : 'Apps stopped; proxy applied';
            }
            if (result.rebooting) {
                [12_000, 24_000, 36_000].forEach((delay) => {
                    window.setTimeout(() => void this.refreshNetworkStatus(udid), delay);
                });
            } else {
                await this.refreshNetworkStatus(udid);
            }
        } catch (error: unknown) {
            const entry = this.networkEntries.get(udid);
            if (entry) {
                entry.details.textContent = error instanceof Error ? error.message : 'Proxy change failed';
                entry.details.classList.add('network-warning');
            }
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
