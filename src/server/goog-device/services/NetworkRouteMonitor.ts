import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import {
    AndroidVpnStatus,
    ExternalNetworkStatus,
    NetworkProtectionStatus,
    NetworkRouteChange,
    NetworkRouteKind,
    NetworkRouteStatus,
} from '../../../types/NetworkRouteStatus';
import { Device } from '../Device';
import { ControlCenter } from './ControlCenter';
import { HostNetworkProbe, parseIpWhoIsResponse } from './HostNetworkProbe';
import { classifyNetworkRoute } from './NetworkRouteClassifier';
import Timeout = NodeJS.Timeout;

export type NetworkRouteAction =
    | 'apply-host-vpn'
    | 'lock-device-vpn'
    | 'clear-android-proxy'
    | 'lock-current'
    | 'unlock';

type StoredDevicePolicy = {
    enabled: boolean;
    expectedIp?: string;
    expectedRoute?: NetworkRouteKind;
    guardEngaged: boolean;
    drifted: boolean;
    lastChangedAt?: number;
    stoppedPackages?: number;
    message?: string;
};

type StoredState = {
    version: 1;
    devices: Record<string, StoredDevicePolicy>;
};

type Observation = {
    ip?: string;
    route: NetworkRouteKind;
    hostVpnIp?: string;
    hostVpnActive: boolean;
};

const DEFAULT_STATE_FILE = path.join(process.env.HOME || process.cwd(), '.ws-scrcpy', 'network-route-state.json');
const STATE_FILE = process.env.WS_SCRCPY_NETWORK_STATE_FILE || DEFAULT_STATE_FILE;
const MONITOR_INTERVAL_MS = Math.max(5_000, parseInt(process.env.WS_SCRCPY_NETWORK_MONITOR_MS || '', 10) || 15_000);

function emptyPolicy(): StoredDevicePolicy {
    return {
        enabled: false,
        guardEngaged: false,
        drifted: false,
    };
}

export class NetworkRouteMonitor {
    private static instance?: NetworkRouteMonitor;
    private readonly hostNetwork = HostNetworkProbe.getInstance();
    private readonly policies: Map<string, StoredDevicePolicy> = new Map();
    private readonly trackedDevices: Set<string> = new Set();
    private readonly observations: Map<string, Observation> = new Map();
    private readonly histories: Map<string, NetworkRouteChange[]> = new Map();
    private readonly statusPromises: Map<string, Promise<NetworkRouteStatus>> = new Map();
    private monitorTimer?: Timeout;

    private constructor() {
        this.loadState();
    }

    public static getInstance(): NetworkRouteMonitor {
        if (!this.instance) {
            this.instance = new NetworkRouteMonitor();
        }
        return this.instance;
    }

    public start(): void {
        this.hostNetwork.startRelay();
        if (this.monitorTimer) {
            return;
        }
        this.monitorTimer = setInterval(() => void this.poll(), MONITOR_INTERVAL_MS);
        this.monitorTimer.unref();
        setTimeout(() => void this.poll(), 1_000);
        setTimeout(() => void this.poll(), 5_000);
    }

    public stop(): void {
        if (this.monitorTimer) {
            clearInterval(this.monitorTimer);
            this.monitorTimer = undefined;
        }
        this.hostNetwork.stopRelay();
    }

    public async getStatus(device: Device, force = false): Promise<NetworkRouteStatus> {
        this.trackedDevices.add(device.udid);
        const pending = this.statusPromises.get(device.udid);
        if (pending) {
            return pending;
        }
        const promise = this.readStatus(device, force).finally(() => {
            this.statusPromises.delete(device.udid);
        });
        this.statusPromises.set(device.udid, promise);
        return promise;
    }

    public async applyAction(device: Device, action: NetworkRouteAction): Promise<NetworkRouteStatus> {
        this.trackedDevices.add(device.udid);
        const currentVpn = await device.getAndroidVpnStatus();
        const excludedVpnPackage = currentVpn.packageName ? [currentVpn.packageName] : [];

        switch (action) {
            case 'apply-host-vpn':
                return this.applyHostVpn(device);
            case 'lock-device-vpn':
                if (!currentVpn.active || !currentVpn.isDefault || !currentVpn.packageName) {
                    throw new Error(
                        'Start a full-device VPN app in Android first; an active default Android VPN was not detected',
                    );
                }
                return this.applyAndLock(
                    device,
                    'device-vpn',
                    undefined,
                    excludedVpnPackage,
                    '手机 VPN 出口已验证并锁定；其他应用已停止，需要时再手动打开',
                );
            case 'clear-android-proxy': {
                const stoppedPackages = await device.stopThirdPartyApps(excludedVpnPackage);
                await device.setNetworkGuard(true, excludedVpnPackage);
                await device.setGlobalProxy(undefined, false);
                const policy = emptyPolicy();
                policy.stoppedPackages = stoppedPackages;
                policy.message = '只清除了 Android HTTP 代理；真实路径仍以模拟器实测出口为准';
                this.policies.set(device.udid, policy);
                this.saveState();
                await device.setNetworkGuard(false, excludedVpnPackage);
                return this.getStatus(device, true);
            }
            case 'lock-current': {
                const status = await this.getStatus(device, true);
                if (!status.ip || status.confidence !== 'verified') {
                    throw new Error('The current emulator exit is not verified and cannot be locked');
                }
                return this.applyAndLock(
                    device,
                    status.route,
                    status.androidProxy === ':0' ? undefined : status.androidProxy,
                    status.androidVpn.packageName ? [status.androidVpn.packageName] : [],
                    '当前实测出口已锁定；接受该出口前已停止第三方应用',
                );
            }
            case 'unlock': {
                const stoppedPackages = await device.stopThirdPartyApps(excludedVpnPackage);
                await device.setNetworkGuard(false, excludedVpnPackage);
                const policy = emptyPolicy();
                policy.stoppedPackages = stoppedPackages;
                policy.message = 'IP 锁定已解除；解除保护前已停止第三方应用';
                this.policies.set(device.udid, policy);
                this.saveState();
                return this.getStatus(device, true);
            }
            default:
                throw new Error(`Unsupported network action: ${action}`);
        }
    }

    private async applyHostVpn(device: Device): Promise<NetworkRouteStatus> {
        const snapshot = await this.hostNetwork.getSnapshot(true);
        if (!snapshot.hostVpn.active || !snapshot.hostVpn.ip) {
            throw new Error(`Host VPN is not active: ${snapshot.hostVpn.error || 'no verified VPN exit IP'}`);
        }
        let targetProxy: string | undefined;
        if (snapshot.hostVpn.systemProxy.enabled) {
            if (!snapshot.hostVpn.proxyReachable) {
                throw new Error(
                    `Host VPN system proxy is enabled but unusable: ${snapshot.hostVpn.error || 'unknown error'}`,
                );
            }
            if (!this.hostNetwork.isRelayAvailable()) {
                throw new Error('The emulator-to-host VPN relay is not available');
            }
            targetProxy = this.hostNetwork.getDeviceProxy();
        }
        return this.applyAndLock(
            device,
            'host-vpn',
            targetProxy,
            [],
            '宿主 VPN 出口已验证并锁定；切换路径前已停止第三方应用',
        );
    }

    private async applyAndLock(
        device: Device,
        expectedRoute: NetworkRouteKind,
        androidProxy: string | undefined,
        excludedPackages: string[],
        successMessage: string,
    ): Promise<NetworkRouteStatus> {
        const stoppedPackages = await device.stopThirdPartyApps(excludedPackages);
        const guard = await device.setNetworkGuard(true, excludedPackages);
        const pendingPolicy: StoredDevicePolicy = {
            enabled: true,
            expectedRoute,
            guardEngaged: guard.enabled,
            drifted: true,
            lastChangedAt: Date.now(),
            stoppedPackages,
            message: '正在验证新路径；第三方应用保持停止状态',
        };
        this.policies.set(device.udid, pendingPolicy);
        this.saveState();
        try {
            await device.setGlobalProxy(androidProxy, false);
            const status = await this.getStatus(device, true);
            if (!status.ip || status.route !== expectedRoute || status.confidence !== 'verified') {
                throw new Error(
                    `Route verification failed: expected ${expectedRoute}, measured ${status.route} (${
                        status.ip || 'no IP'
                    })`,
                );
            }
            const releasedGuard = await device.setNetworkGuard(false, excludedPackages);
            const policy: StoredDevicePolicy = {
                enabled: true,
                expectedIp: status.ip,
                expectedRoute,
                guardEngaged: releasedGuard.enabled,
                drifted: false,
                lastChangedAt: Date.now(),
                stoppedPackages,
                message: successMessage,
            };
            this.policies.set(device.udid, policy);
            this.saveState();
            return this.getStatus(device, true);
        } catch (error: unknown) {
            pendingPolicy.message = error instanceof Error ? error.message : 'Route verification failed';
            this.policies.set(device.udid, pendingPolicy);
            this.saveState();
            throw error;
        }
    }

    private async readStatus(device: Device, force: boolean): Promise<NetworkRouteStatus> {
        const [androidProxyResult, emulatorResult, androidVpn, hostSnapshot, guardActive] = await Promise.all([
            device.getGlobalProxy().catch(() => ':0'),
            device
                .getExternalNetworkStatus()
                .then((body) => parseIpWhoIsResponse(body, 'Emulator network probe'))
                .catch(
                    (error: unknown): ExternalNetworkStatus => ({
                        checkedAt: Date.now(),
                        error: error instanceof Error ? error.message : 'Emulator network probe failed',
                    }),
                ),
            device.getAndroidVpnStatus(),
            this.hostNetwork.getSnapshot(force),
            device.isNetworkGuardEnabled(),
        ]);
        const classification = classifyNetworkRoute({
            actualIp: emulatorResult.ip,
            androidProxy: androidProxyResult,
            androidVpn,
            hostDefault: hostSnapshot.hostDefault,
            hostVpn: hostSnapshot.hostVpn,
        });
        const changes = this.recordObservation(
            device.udid,
            emulatorResult.ip,
            classification.route,
            hostSnapshot.hostVpn.ip,
            hostSnapshot.hostVpn.active,
        );
        const protection = await this.enforcePolicy(
            device,
            emulatorResult,
            classification.route,
            androidVpn,
            guardActive,
        );
        return {
            ...emulatorResult,
            ipSource: 'emulator-network',
            route: classification.route,
            confidence: classification.confidence,
            routeReason: classification.reason,
            androidProxy: androidProxyResult,
            hostDefault: hostSnapshot.hostDefault,
            hostVpn: hostSnapshot.hostVpn,
            androidVpn,
            protection,
            changed: changes.emulator,
            hostVpnChanged: changes.hostVpn,
            recentChanges: this.histories.get(device.udid) || [],
        };
    }

    private async enforcePolicy(
        device: Device,
        actual: ExternalNetworkStatus,
        route: NetworkRouteKind,
        androidVpn: AndroidVpnStatus,
        guardActive: boolean,
    ): Promise<NetworkProtectionStatus> {
        const policy = this.policies.get(device.udid) || emptyPolicy();
        if (!policy.enabled) {
            if (guardActive) {
                await device.setNetworkGuard(false);
            }
            return { ...policy };
        }
        policy.guardEngaged = guardActive;
        const mismatch = !actual.ip || actual.ip !== policy.expectedIp || route !== policy.expectedRoute;
        if (mismatch && (!policy.drifted || !guardActive)) {
            const excludedPackages =
                policy.expectedRoute === 'device-vpn' && androidVpn.packageName ? [androidVpn.packageName] : [];
            const stoppedPackages = await device.stopThirdPartyApps(excludedPackages);
            const guard = await device.setNetworkGuard(true, excludedPackages);
            policy.drifted = true;
            policy.guardEngaged = guard.enabled;
            policy.lastChangedAt = Date.now();
            policy.stoppedPackages = stoppedPackages;
            policy.message = guard.supported
                ? '检测到 IP 或路径漂移；第三方应用已停止，且其网络已被拦截'
                : `检测到 IP 或路径漂移；应用已停止，但 root 网络拦截失败（${guard.error || 'unknown error'}）`;
            this.policies.set(device.udid, policy);
            this.saveState();
        } else if (!mismatch && !policy.drifted && guardActive) {
            const guard = await device.setNetworkGuard(false);
            policy.guardEngaged = guard.enabled;
            this.policies.set(device.udid, policy);
            this.saveState();
        }
        return { ...policy, drifted: policy.drifted || mismatch };
    }

    private recordObservation(
        udid: string,
        ip: string | undefined,
        route: NetworkRouteKind,
        hostVpnIp: string | undefined,
        hostVpnActive: boolean,
    ): { emulator: boolean; hostVpn: boolean } {
        const previous = this.observations.get(udid);
        const emulatorChanged = !!previous && (previous.ip !== ip || previous.route !== route);
        const hostVpnChanged =
            !!previous && (previous.hostVpnIp !== hostVpnIp || previous.hostVpnActive !== hostVpnActive);
        const history = this.histories.get(udid) || [];
        if (emulatorChanged && previous) {
            history.unshift({
                scope: 'emulator',
                fromIp: previous.ip,
                toIp: ip,
                fromRoute: previous.route,
                toRoute: route,
                changedAt: Date.now(),
            });
        }
        if (hostVpnChanged && previous) {
            history.unshift({
                scope: 'host-vpn',
                fromIp: previous.hostVpnIp,
                toIp: hostVpnIp,
                fromRoute: previous.hostVpnActive ? 'host-vpn' : 'host-direct',
                toRoute: hostVpnActive ? 'host-vpn' : 'host-direct',
                changedAt: Date.now(),
            });
        }
        if (emulatorChanged || hostVpnChanged) {
            this.histories.set(udid, history.slice(0, 10));
        }
        this.observations.set(udid, { ip, route, hostVpnIp, hostVpnActive });
        return { emulator: emulatorChanged, hostVpn: hostVpnChanged };
    }

    private async poll(): Promise<void> {
        const controlCenter = ControlCenter.getInstance();
        controlCenter.getDevices().forEach(({ udid, state }) => {
            if (state === 'device') {
                this.trackedDevices.add(udid);
            }
        });
        await Promise.all(
            Array.from(this.trackedDevices, async (udid) => {
                const device = controlCenter.getDevice(udid);
                if (!device?.isConnected()) {
                    return;
                }
                try {
                    await this.getStatus(device, true);
                } catch (error: unknown) {
                    console.error(
                        `Network route monitor failed for ${udid}: ${
                            error instanceof Error ? error.message : 'unknown error'
                        }`,
                    );
                }
            }),
        );
    }

    private loadState(): void {
        try {
            const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as StoredState;
            if (state.version !== 1 || !state.devices) {
                return;
            }
            Object.keys(state.devices).forEach((udid) => {
                this.policies.set(udid, state.devices[udid]);
                this.trackedDevices.add(udid);
            });
        } catch (_error) {
            // No saved policy is the normal first-run state.
        }
    }

    private saveState(): void {
        const state: StoredState = { version: 1, devices: {} };
        this.policies.forEach((policy, udid) => {
            state.devices[udid] = policy;
        });
        const directory = path.dirname(STATE_FILE);
        const temporary = `${STATE_FILE}.tmp`;
        try {
            fs.mkdirSync(directory, { recursive: true });
            fs.writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
            fs.renameSync(temporary, STATE_FILE);
        } catch (error: unknown) {
            console.error(
                `Unable to save network route state: ${error instanceof Error ? error.message : 'unknown error'}`,
            );
        }
    }
}
