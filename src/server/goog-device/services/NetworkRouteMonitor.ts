import * as fs from 'fs';
import * as path from 'path';
import * as process from 'process';
import {
    AndroidVpnStatus,
    ExternalNetworkStatus,
    NetworkProtectionStatus,
    NetworkRouteChange,
    NetworkRouteConfidence,
    NetworkRouteKind,
    NetworkRouteStatus,
} from '../../../types/NetworkRouteStatus';
import { Device, NetworkGuardState } from '../Device';
import { ControlCenter } from './ControlCenter';
import { HostNetworkProbe, parseIpWhoIsResponse } from './HostNetworkProbe';
import { evaluateNetworkProtection } from './NetworkProtectionDecision';
import { classifyNetworkRoute } from './NetworkRouteClassifier';
import Timeout = NodeJS.Timeout;

export type NetworkRouteAction =
    | 'apply-host-vpn'
    | 'apply-host-direct'
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
    guardMode?: 'block-all' | 'proxy-only';
    allowedProxy?: string;
    warning?: 'domestic-host-direct-ip-change';
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
    private readonly switchingDevices: Set<string> = new Set();
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
        if (this.switchingDevices.has(device.udid)) {
            throw new Error('该云手机正在切换网络路径，请等待当前操作完成');
        }
        this.switchingDevices.add(device.udid);
        try {
            this.trackedDevices.add(device.udid);
            const currentVpn = await device.getAndroidVpnStatus();
            const excludedVpnPackage = currentVpn.packageName ? [currentVpn.packageName] : [];

            switch (action) {
                case 'apply-host-vpn':
                    return this.applyHostVpn(device);
                case 'apply-host-direct':
                    return this.applyHostDirect(device);
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
                    return this.getFreshStatus(device);
                }
                case 'lock-current': {
                    const status = await this.getFreshStatus(device);
                    if (!status.ip || status.confidence !== 'verified') {
                        throw new Error('The current emulator exit is not verified and cannot be locked');
                    }
                    return this.applyAndLock(
                        device,
                        status.route,
                        status.androidProxy === ':0' ? undefined : status.androidProxy,
                        status.androidVpn.packageName ? [status.androidVpn.packageName] : [],
                        '当前实测出口已锁定；接受该出口前已停止第三方应用',
                        status.route === 'host-direct' && status.androidProxy === status.hostDirect.deviceProxy,
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
                    return this.getFreshStatus(device);
                }
                default:
                    throw new Error(`Unsupported network action: ${action}`);
            }
        } finally {
            this.switchingDevices.delete(device.udid);
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

    private async applyHostDirect(device: Device): Promise<NetworkRouteStatus> {
        const snapshot = await this.hostNetwork.getSnapshot(true);
        if (!snapshot.hostDirect.available || !snapshot.hostDirect.ip) {
            throw new Error(`宿主物理直连出口不可用：${snapshot.hostDirect.error || '未取得可信的物理网络出口 IP'}`);
        }
        if (!this.hostNetwork.isDirectRelayAvailable()) {
            throw new Error('宿主直连中继不可用，不能保证云手机绕过宿主 VPN');
        }
        if (snapshot.hostVpn.active && snapshot.hostVpn.ip === snapshot.hostDirect.ip) {
            throw new Error('宿主 VPN 与物理直连探测得到相同 IP，当前无法安全区分两条路径');
        }
        const directProxy = this.hostNetwork.getDirectDeviceProxy();
        return this.applyAndLock(
            device,
            'host-direct',
            directProxy,
            [],
            '宿主物理直连出口已验证并锁定；宿主 VPN 保持开启但云手机未使用它',
            true,
        );
    }

    private async applyAndLock(
        device: Device,
        expectedRoute: NetworkRouteKind,
        androidProxy: string | undefined,
        excludedPackages: string[],
        successMessage: string,
        keepProxyGuard = false,
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
            guardMode: 'block-all',
        };
        this.policies.set(device.udid, pendingPolicy);
        this.saveState();
        try {
            if (keepProxyGuard && (!guard.supported || !guard.enabled || !androidProxy)) {
                throw new Error('云手机防泄漏规则不可用，已拒绝启用宿主直连模式');
            }
            await device.setGlobalProxy(androidProxy, false);
            const status = await this.getFreshStatus(device);
            if (!status.ip || status.route !== expectedRoute || status.confidence !== 'verified') {
                throw new Error(
                    `Route verification failed: expected ${expectedRoute}, measured ${status.route} (${
                        status.ip || 'no IP'
                    })`,
                );
            }
            const releasedGuard = keepProxyGuard
                ? await device.setNetworkGuard(true, excludedPackages, androidProxy)
                : await device.setNetworkGuard(false, excludedPackages);
            if (
                keepProxyGuard &&
                (!releasedGuard.supported || !releasedGuard.enabled || releasedGuard.allowedProxy !== androidProxy)
            ) {
                throw new Error('宿主直连出口已验证，但云手机防泄漏规则未能生效');
            }
            const policy: StoredDevicePolicy = {
                enabled: true,
                expectedIp: status.ip,
                expectedRoute,
                guardEngaged: releasedGuard.enabled,
                drifted: false,
                lastChangedAt: Date.now(),
                stoppedPackages,
                message: successMessage,
                guardMode: keepProxyGuard ? 'proxy-only' : undefined,
                allowedProxy: keepProxyGuard ? androidProxy : undefined,
            };
            this.policies.set(device.udid, policy);
            this.saveState();
            return this.getFreshStatus(device);
        } catch (error: unknown) {
            const blockedGuard = await device.setNetworkGuard(true, excludedPackages);
            pendingPolicy.guardEngaged = blockedGuard.enabled;
            pendingPolicy.message = error instanceof Error ? error.message : 'Route verification failed';
            this.policies.set(device.udid, pendingPolicy);
            this.saveState();
            throw error;
        }
    }

    private async readStatus(device: Device, force: boolean): Promise<NetworkRouteStatus> {
        const enforcementSuspended = this.switchingDevices.has(device.udid);
        const androidProxyPromise = device.getGlobalProxy().catch(() => ':0');
        const [androidProxyResult, emulatorResult, androidVpn, hostSnapshot, guardState] = await Promise.all([
            androidProxyPromise,
            androidProxyPromise
                .then((proxy) => device.getExternalNetworkStatus(proxy))
                .then((body) => parseIpWhoIsResponse(body, 'Emulator network probe'))
                .catch(
                    (error: unknown): ExternalNetworkStatus => ({
                        checkedAt: Date.now(),
                        error: error instanceof Error ? error.message : 'Emulator network probe failed',
                    }),
                ),
            device.getAndroidVpnStatus(),
            this.hostNetwork.getSnapshot(force),
            device.getNetworkGuardState(),
        ]);
        const classification = classifyNetworkRoute({
            actualIp: emulatorResult.ip,
            androidProxy: androidProxyResult,
            androidVpn,
            hostDefault: hostSnapshot.hostDefault,
            hostDirect: hostSnapshot.hostDirect,
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
            classification.confidence,
            androidVpn,
            guardState,
            enforcementSuspended,
        );
        return {
            ...emulatorResult,
            ipSource: 'emulator-network',
            route: classification.route,
            confidence: classification.confidence,
            routeReason: classification.reason,
            androidProxy: androidProxyResult,
            hostDefault: hostSnapshot.hostDefault,
            hostDirect: hostSnapshot.hostDirect,
            hostVpn: hostSnapshot.hostVpn,
            androidVpn,
            protection,
            changed: changes.emulator,
            hostVpnChanged: changes.hostVpn,
            recentChanges: this.histories.get(device.udid) || [],
        };
    }

    private async getFreshStatus(device: Device): Promise<NetworkRouteStatus> {
        const pending = this.statusPromises.get(device.udid);
        if (pending) {
            await pending.catch(() => undefined);
        }
        return this.getStatus(device, true);
    }

    private async enforcePolicy(
        device: Device,
        actual: ExternalNetworkStatus,
        route: NetworkRouteKind,
        routeConfidence: NetworkRouteConfidence,
        androidVpn: AndroidVpnStatus,
        guardState: NetworkGuardState,
        enforcementSuspended: boolean,
    ): Promise<NetworkProtectionStatus> {
        const policy = this.policies.get(device.udid) || emptyPolicy();
        if (enforcementSuspended || this.switchingDevices.has(device.udid)) {
            return {
                ...policy,
                message: '正在安全切换网络路径；自动漂移处理暂缓到切换完成',
                guardStatus: guardState.status,
                guardError: guardState.error,
            };
        }
        if (!policy.enabled) {
            if (guardState.status !== 'unavailable' && guardState.enabled) {
                const guard = await device.setNetworkGuard(false);
                return {
                    ...policy,
                    guardEngaged: guard.enabled,
                    guardStatus: guard.supported ? 'missing' : 'unavailable',
                    guardError: guard.error,
                };
            }
            return { ...policy, guardStatus: guardState.status, guardError: guardState.error };
        }
        const decision = evaluateNetworkProtection({
            expectedIp: policy.expectedIp,
            expectedRoute: policy.expectedRoute,
            actualIp: actual.ip,
            actualCountryCode: actual.countryCode,
            actualRoute: route,
            routeConfidence,
            alreadyDrifted: policy.drifted,
            allowedProxy: policy.allowedProxy,
            guardStatus: guardState.status,
            guardEnabled: guardState.enabled,
            guardAllowedProxy: guardState.allowedProxy,
        });
        const excludedPackages =
            policy.expectedRoute === 'device-vpn' && androidVpn.packageName ? [androidVpn.packageName] : [];

        if (decision.domesticHostDirectIpChange && actual.ip) {
            const previousIp = policy.expectedIp || '未知';
            let currentGuardState = guardState;
            if (
                policy.allowedProxy &&
                !decision.guardReadFailed &&
                (decision.proxyGuardMismatch || decision.blockingGuardActive)
            ) {
                const guard = await device.setNetworkGuard(true, excludedPackages, policy.allowedProxy);
                currentGuardState = {
                    enabled: guard.enabled,
                    status: guard.supported && guard.enabled ? 'active' : 'unavailable',
                    allowedProxy: guard.allowedProxy,
                    error: guard.error,
                };
            }
            policy.expectedIp = actual.ip;
            policy.drifted = false;
            policy.guardEngaged = currentGuardState.enabled;
            policy.guardMode = policy.allowedProxy ? 'proxy-only' : undefined;
            policy.lastChangedAt = Date.now();
            policy.warning = 'domestic-host-direct-ip-change';
            policy.message = `警告：宿主物理直连国内公网 IP 已从 ${previousIp} 变为 ${actual.ip}；路径仍为 host-direct，已自动更新基准，未停止 App、未全断网`;
            this.policies.set(device.udid, policy);
            this.saveState();
            return {
                ...policy,
                guardStatus: currentGuardState.status,
                guardError: currentGuardState.error,
            };
        }

        if (decision.confirmedDrift) {
            policy.warning = undefined;
            const mismatchReasons = [
                decision.ipDrift ? `IP ${actual.ip}（期望 ${policy.expectedIp || '未知'}）` : '',
                decision.routeDrift ? `路径 ${route}（期望 ${policy.expectedRoute || '未知'}）` : '',
            ].filter(Boolean);
            if (!decision.shouldStopApps) {
                if (!decision.guardReadFailed && !decision.blockingGuardActive) {
                    const guard = await device.setNetworkGuard(true, excludedPackages);
                    policy.guardEngaged = guard.enabled;
                    policy.guardMode = 'block-all';
                    if (!guard.supported) {
                        policy.message = `已确认出口漂移：${mismatchReasons.join(
                            '；',
                        )}；应用此前已停止，但网络拦截恢复失败（${guard.error || 'unknown error'}）`;
                    }
                    this.policies.set(device.udid, policy);
                    this.saveState();
                    return {
                        ...policy,
                        drifted: true,
                        guardStatus: guard.supported && guard.enabled ? 'active' : 'unavailable',
                        guardError: guard.error,
                    };
                }
                return {
                    ...policy,
                    drifted: true,
                    guardStatus: guardState.status,
                    guardError: guardState.error,
                };
            }
            const stoppedPackages = await device.stopThirdPartyApps(excludedPackages);
            const guard = await device.setNetworkGuard(true, excludedPackages);
            policy.drifted = true;
            policy.guardEngaged = guard.enabled;
            policy.guardMode = 'block-all';
            policy.lastChangedAt = Date.now();
            policy.stoppedPackages = stoppedPackages;
            policy.message = guard.supported
                ? `已确认实际出口漂移：${mismatchReasons.join('；')}；第三方应用已停止，且其网络已被拦截`
                : `已确认实际出口漂移；应用已停止，但 root 网络拦截失败（${guard.error || 'unknown error'}）`;
            this.policies.set(device.udid, policy);
            this.saveState();
            return {
                ...policy,
                guardStatus: guard.supported && guard.enabled ? 'active' : 'unavailable',
                guardError: guard.error,
            };
        }

        if (decision.guardReadFailed) {
            return {
                ...policy,
                message: `防泄漏规则读取失败，保留上次保护状态并将在下轮复查；未停止业务 App（${
                    guardState.error || 'unknown error'
                }）`,
                guardStatus: 'unavailable',
                guardError: guardState.error,
            };
        }

        if (policy.drifted && !decision.expectedPathVerified && !decision.blockingGuardActive) {
            const guard = await device.setNetworkGuard(true, excludedPackages);
            policy.guardEngaged = guard.enabled;
            policy.guardMode = 'block-all';
            if (!guard.supported) {
                policy.message = `出口仍在等待重新验证，网络拦截恢复失败；未再次停止业务 App（${
                    guard.error || 'unknown error'
                }）`;
            }
            this.policies.set(device.udid, policy);
            this.saveState();
            return {
                ...policy,
                guardStatus: guard.supported && guard.enabled ? 'active' : 'unavailable',
                guardError: guard.error,
            };
        }

        if (decision.shouldRepairProxyGuard && policy.allowedProxy) {
            const guard = await device.setNetworkGuard(true, excludedPackages, policy.allowedProxy);
            const repaired = guard.supported && guard.enabled && guard.allowedProxy === policy.allowedProxy;
            if (repaired) {
                const recoveredFromDrift = policy.drifted && decision.expectedPathVerified;
                policy.drifted = false;
                policy.guardEngaged = true;
                policy.guardMode = 'proxy-only';
                policy.lastChangedAt = Date.now();
                policy.message = recoveredFromDrift
                    ? '实际 IP 和路径已恢复到锁定值，防泄漏规则已自动恢复；未再次停止业务 App'
                    : '实际 IP 和路径未漂移，防泄漏规则已自动恢复；未停止业务 App';
                this.policies.set(device.udid, policy);
                this.saveState();
                return { ...policy, guardStatus: 'active' };
            }
            return {
                ...policy,
                guardEngaged: false,
                message: `实际 IP 和路径未确认漂移，但防泄漏规则自动恢复失败；未停止业务 App（${
                    guard.error || 'unknown error'
                }）`,
                guardStatus: guard.supported ? 'missing' : 'unavailable',
                guardError: guard.error,
            };
        }

        if (policy.drifted && decision.expectedPathVerified) {
            if (decision.expectsProxyGuard) {
                policy.guardEngaged = guardState.enabled;
                policy.guardMode = 'proxy-only';
            } else if (guardState.enabled) {
                const guard = await device.setNetworkGuard(false, excludedPackages);
                policy.guardEngaged = guard.enabled;
                policy.guardMode = undefined;
            } else {
                policy.guardEngaged = false;
                policy.guardMode = undefined;
            }
            policy.drifted = false;
            policy.lastChangedAt = Date.now();
            policy.message = '实际 IP 和路径已恢复到锁定值，出口保护已自动解除；未再次停止业务 App';
            this.policies.set(device.udid, policy);
            this.saveState();
            return { ...policy, guardStatus: guardState.status, guardError: guardState.error };
        }

        if (decision.expectedPathVerified && !decision.expectsProxyGuard && guardState.enabled) {
            const guard = await device.setNetworkGuard(false, excludedPackages);
            policy.guardEngaged = guard.enabled;
            policy.guardMode = undefined;
            policy.message = guard.supported
                ? '实际 IP 和路径保持锁定值，已清理不需要的网络拦截规则；未停止业务 App'
                : `实际 IP 和路径保持锁定值，但网络拦截规则清理失败（${guard.error || 'unknown error'}）`;
            this.policies.set(device.udid, policy);
            this.saveState();
            return {
                ...policy,
                guardStatus: guard.supported ? 'missing' : 'unavailable',
                guardError: guard.error,
            };
        }

        if (decision.probeIncomplete) {
            return {
                ...policy,
                message: '实际出口正在重新验证；检测失败或路径未知不会停止业务 App',
                guardStatus: guardState.status,
                guardError: guardState.error,
            };
        }

        policy.guardEngaged = guardState.enabled;
        return { ...policy, guardStatus: guardState.status, guardError: guardState.error };
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
