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
    statusTone,
    statusVerification,
} from './NetworkStatusPresentation';

type Field = keyof GoogDeviceDescriptor | ((descriptor: GoogDeviceDescriptor) => string);
type DescriptionColumn = { title: string; field: Field };
type NetworkAction =
    | 'apply-host-vpn'
    | 'apply-host-direct'
    | 'lock-device-vpn'
    | 'clear-android-proxy'
    | 'lock-current'
    | 'unlock';

type NetworkEntry = {
    status: HTMLElement;
    details: HTMLElement;
    hostVpnButton: HTMLButtonElement;
    hostDirectButton: HTMLButtonElement;
    deviceVpnButton: HTMLButtonElement;
    hostVpnTracking: HTMLElement;
    buttons: HTMLButtonElement[];
    statusAvailable: boolean;
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
        status.textContent = '正在读取云手机实际出口…';
        const details = document.createElement('span');
        details.className = 'network-details';
        details.textContent = '尚未验证出口 IP，请勿先打开业务 App。';

        const hostVpnButton = this.createNetworkButton('使用宿主 VPN（验证并锁定）', () =>
            this.runNetworkAction(udid, 'apply-host-vpn'),
        );
        hostVpnButton.classList.add('primary');
        hostVpnButton.title = '停止第三方应用，验证云手机实际出口与宿主 VPN 一致，然后锁定该出口';
        const hostDirectButton = this.createNetworkButton('不用宿主 VPN（验证并锁定）', () =>
            this.runNetworkAction(udid, 'apply-host-direct'),
        );
        hostDirectButton.classList.add('primary');
        hostDirectButton.title = '保持宿主 VPN 开启，但强制云手机经宿主物理网卡直连；验证真实 IP 后锁定并阻断旁路泄漏';
        const deviceVpnButton = this.createNetworkButton('使用手机 VPN（验证并锁定）', () =>
            this.runNetworkAction(udid, 'lock-device-vpn'),
        );
        deviceVpnButton.classList.add('primary');
        deviceVpnButton.title = '请先在云手机内启动全局 VPN，再验证并锁定手机 VPN 的实际出口';
        const lockButton = this.createNetworkButton('重新锁定当前实测 IP', () =>
            this.runNetworkAction(udid, 'lock-current'),
        );
        lockButton.title = '把当前已经验证的出口重新设为防漂移基准';
        const clearButton = this.createNetworkButton('仅清除 Android HTTP 代理', () =>
            this.runNetworkAction(udid, 'clear-android-proxy'),
        );
        clearButton.title = '只清除 Android HTTP 代理；不会关闭宿主 VPN，也不保证变成国内 IP';
        const unlockButton = this.createNetworkButton('关闭 IP 防漂移保护', () =>
            this.runNetworkAction(udid, 'unlock'),
        );
        unlockButton.title = '关闭 IP 变化时的自动停应用和网络拦截';
        const actionButtons = [hostVpnButton, hostDirectButton, deviceVpnButton, lockButton, clearButton, unlockButton];
        actionButtons.forEach((button) => (button.disabled = true));

        const requirements = document.createElement('div');
        requirements.className = 'network-requirements';
        const hostModeActions = document.createElement('div');
        hostModeActions.className = 'network-mode-actions';
        hostModeActions.append(hostVpnButton, hostDirectButton);
        requirements.append(
            this.createNetworkRequirement(
                '① 选择宿主网络路径',
                '二选一：使用宿主 VPN，或绕过宿主 VPN 使用物理网络；均以云手机内部实测 IP 为准。',
                hostModeActions,
            ),
            this.createNetworkRequirement(
                '② 使用手机 VPN',
                '先在云手机内启动全局 VPN，再验证并锁定；该出口与宿主 VPN 隔离。',
                deviceVpnButton,
            ),
        );
        const hostVpnTracking = document.createElement('p');
        hostVpnTracking.className = 'network-requirement-description';
        hostVpnTracking.textContent = '等待网络状态后开始监控。';
        requirements.append(this.createNetworkRequirement('③ 宿主节点切换自动检测', hostVpnTracking));

        const advanced = document.createElement('details');
        advanced.className = 'network-advanced';
        const advancedSummary = document.createElement('summary');
        advancedSummary.textContent = '高级操作（仅用于排障）';
        const advancedHint = document.createElement('p');
        advancedHint.textContent = '这些操作不等于“使用宿主 VPN”，一般无需点击。';
        const advancedActions = document.createElement('div');
        advancedActions.className = 'network-advanced-actions';
        advancedActions.append(lockButton, clearButton, unlockButton);
        advanced.append(advancedSummary, advancedHint, advancedActions);

        entry.append(status, details, requirements, advanced);
        this.networkEntries.set(udid, {
            status,
            details,
            hostVpnButton,
            hostDirectButton,
            deviceVpnButton,
            hostVpnTracking,
            buttons: actionButtons,
            statusAvailable: false,
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
        }, 15_000);
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

    private createNetworkRequirement(
        title: string,
        description: string | HTMLElement,
        action?: HTMLElement,
    ): HTMLElement {
        const requirement = document.createElement('section');
        requirement.className = 'network-requirement';
        const heading = document.createElement('strong');
        heading.className = 'network-requirement-title';
        heading.textContent = title;
        requirement.appendChild(heading);
        if (typeof description === 'string') {
            const paragraph = document.createElement('p');
            paragraph.className = 'network-requirement-description';
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

    private async refreshNetworkStatus(udid: string): Promise<void> {
        const entry = this.networkEntries.get(udid);
        if (!entry) {
            return;
        }
        try {
            const response = await fetch(this.endpoint(`network/status?udid=${encodeURIComponent(udid)}&refresh=1`), {
                cache: 'no-store',
            });
            const result = (await response.json().catch(() => ({}))) as {
                status?: NetworkRouteStatus;
                output?: string;
            };
            if (!response.ok || !result.status) {
                this.renderNetworkUnavailable(entry, response.status, result.output);
                return;
            }
            this.renderNetworkStatus(entry, result.status);
        } catch (error: unknown) {
            this.renderNetworkUnavailable(entry, undefined, error instanceof Error ? error.message : undefined);
        }
    }

    private renderNetworkStatus(entry: NetworkEntry, status: NetworkRouteStatus): void {
        entry.statusAvailable = true;
        entry.status.textContent = `${statusHeadline(status)} · ${routeLabel(status)}`;
        entry.status.title = statusDetails(status).join('\n');
        entry.details.textContent = statusVerification(status);
        entry.details.setAttribute('data-network-tone', statusTone(status));
        entry.hostVpnButton.textContent = hostVpnActionLabel(status);
        entry.hostDirectButton.textContent = hostDirectActionLabel(status);
        entry.deviceVpnButton.textContent = deviceVpnActionLabel(status);
        entry.hostVpnTracking.textContent = hostVpnTrackingMessage(status);
        entry.hostVpnTracking.setAttribute(
            'data-network-tone',
            status.protection.drifted && status.protection.expectedRoute === 'host-vpn' ? 'danger' : statusTone(status),
        );
        entry.buttons.forEach((button) => (button.disabled = false));
    }

    private renderNetworkUnavailable(entry: NetworkEntry, httpStatus?: number, output?: string): void {
        const failure = networkStatusFailure(httpStatus, output);
        entry.statusAvailable = false;
        entry.status.textContent = failure.headline;
        entry.status.title = `${failure.headline}\n${failure.details}`;
        entry.details.textContent = failure.details;
        entry.details.setAttribute('data-network-tone', 'danger');
        entry.hostVpnTracking.textContent = '自动检测暂不可用；接口恢复前无法确认宿主节点或云手机出口变化。';
        entry.hostVpnTracking.setAttribute('data-network-tone', 'danger');
        entry.buttons.forEach((button) => (button.disabled = true));
    }

    private async runNetworkAction(udid: string, action: NetworkAction): Promise<void> {
        const entry = this.networkEntries.get(udid);
        if (!entry?.statusAvailable) {
            return;
        }
        entry.buttons.forEach((button) => (button.disabled = true));
        try {
            const response = await fetch(this.endpoint('network/proxy'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ udid, action }),
            });
            const result = (await response.json().catch(() => ({}))) as {
                output?: string;
                status?: NetworkRouteStatus;
            };
            if (!response.ok) {
                if (response.status === 404) {
                    this.renderNetworkUnavailable(entry, response.status, result.output);
                } else {
                    entry.details.textContent = `操作失败：${result.output || `HTTP ${response.status}`}`;
                    entry.details.setAttribute('data-network-tone', 'danger');
                }
                return;
            }
            if (result.status) {
                this.renderNetworkStatus(entry, result.status);
            } else {
                await this.refreshNetworkStatus(udid);
            }
        } catch (error: unknown) {
            this.renderNetworkUnavailable(
                entry,
                undefined,
                error instanceof Error ? error.message : '网络操作请求失败',
            );
        } finally {
            entry.buttons.forEach((button) => (button.disabled = !entry.statusAvailable));
        }
    }

    private endpoint(path: string): string {
        const pathname = window.location.pathname.endsWith('/')
            ? window.location.pathname
            : `${window.location.pathname}/`;
        return new URL(`${pathname}api/${path}`, window.location.origin).toString();
    }
}
