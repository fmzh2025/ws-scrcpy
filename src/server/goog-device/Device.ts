import { AdbExtended } from './adb';
import AdbKitClient from '@dead50f7/adbkit/lib/adb/client';
import PushTransfer from '@dead50f7/adbkit/lib/adb/sync/pushtransfer';
import { spawn } from 'child_process';
import path from 'path';
import '../../../vendor/ws-scrcpy/ip-probe.jar';
import { NetInterface } from '../../types/NetInterface';
import { TypedEmitter } from '../../common/TypedEmitter';
import GoogDeviceDescriptor from '../../types/GoogDeviceDescriptor';
import { AndroidVpnStatus } from '../../types/NetworkRouteStatus';
import { ScrcpyServer } from './ScrcpyServer';
import { Properties } from './Properties';
import Timeout = NodeJS.Timeout;

enum PID_DETECTION {
    UNKNOWN,
    PIDOF,
    GREP_PS,
    GREP_PS_A,
    LS_PROC,
}

export interface DeviceEvents {
    update: Device;
}

export type NetworkGuardResult = {
    enabled: boolean;
    supported: boolean;
    protectedPackages: number;
    allowedProxy?: string;
    error?: string;
};

export type NetworkGuardState = {
    enabled: boolean;
    allowedProxy?: string;
};

type ThirdPartyPackage = {
    name: string;
    uid?: number;
};

export class Device extends TypedEmitter<DeviceEvents> {
    private static readonly INITIAL_UPDATE_TIMEOUT = 1500;
    private static readonly MAX_UPDATES_COUNT = 7;
    private static readonly SAFE_APK_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.apk$/i;
    private static readonly SAFE_UPLOADED_FILE_NAME = /^(?!\.{1,2}$)[^/\\\0]{1,240}$/;
    private static readonly RESERVED_UPLOAD_FILE_NAMES = new Set([
        'scrcpy-server.jar',
        'ws_scrcpy.pid',
        'ws-scrcpy-ip-probe.jar',
    ]);
    private static readonly TEMP_PATH = '/data/local/tmp/';
    private static readonly DOWNLOAD_PATH = '/sdcard/Download/';
    private static readonly IP_PROBE_REMOTE_PATH = `${Device.TEMP_PATH}ws-scrcpy-ip-probe.jar`;
    private static readonly IP_PROBE_URL = 'https://ipwho.is/';
    private connected = true;
    private pidDetectionVariant: PID_DETECTION = PID_DETECTION.UNKNOWN;
    private client: AdbKitClient;
    private properties?: Record<string, string>;
    private spawnServer = false;
    private startServerPromise?: Promise<number | undefined>;
    private streamAcquirePromise?: Promise<void>;
    private streamIdleTimeoutId?: Timeout;
    private streamClientCount = 0;
    private streamServerOwned = false;
    private updateTimeoutId?: Timeout;
    private updateTimeout = Device.INITIAL_UPDATE_TIMEOUT;
    private updateCount = 0;
    private throttleTimeoutId?: Timeout;
    private lastEmit = 0;
    private ipProbeReady?: Promise<void>;
    public readonly TAG: string;
    public readonly descriptor: GoogDeviceDescriptor;

    constructor(public readonly udid: string, state: string) {
        super();
        this.TAG = `[${udid}]`;
        this.descriptor = {
            udid,
            state,
            interfaces: [],
            pid: -1,
            'wifi.interface': '',
            'ro.build.version.release': '',
            'ro.build.version.sdk': '',
            'ro.product.manufacturer': '',
            'ro.product.model': '',
            'ro.product.cpu.abi': '',
            'last.update.timestamp': 0,
        };
        this.client = AdbExtended.createClient();
        this.setState(state);
    }

    public setState(state: string): void {
        if (state === 'device') {
            if (!this.connected) {
                this.ipProbeReady = undefined;
            }
            this.connected = true;
            this.properties = undefined;
        } else {
            this.connected = false;
            this.ipProbeReady = undefined;
        }
        this.descriptor.state = state;
        this.emitUpdate();
        this.fetchDeviceInfo();
    }

    public isConnected(): boolean {
        return this.connected;
    }

    public async getPidOf(processName: string): Promise<number[] | undefined> {
        if (!this.connected) {
            return;
        }
        if (this.pidDetectionVariant === PID_DETECTION.UNKNOWN) {
            this.pidDetectionVariant = await this.findDetectionVariant();
        }
        switch (this.pidDetectionVariant) {
            case PID_DETECTION.PIDOF:
                return this.pidOf(processName);
            case PID_DETECTION.GREP_PS:
                return this.grepPs(processName);
            case PID_DETECTION.GREP_PS_A:
                return this.grepPs_A(processName);
            default:
                return this.listProc(processName);
        }
    }

    public killProcess(pid: number): Promise<string> {
        const command = `kill ${pid}`;
        return this.runShellCommandAdbKit(command);
    }

    public async runShellCommandAdb(command: string): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const cmd = 'adb';
            const args = ['-s', `${this.udid}`, 'shell', command];
            const adb = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let output = '';

            adb.stdout.on('data', (data) => {
                output += data.toString();
                console.log(this.TAG, `stdout: ${data.toString().replace(/\n$/, '')}`);
            });

            adb.stderr.on('data', (data) => {
                console.error(this.TAG, `stderr: ${data}`);
            });

            adb.on('error', (error: Error) => {
                console.error(this.TAG, `failed to spawn adb process.\n${error.stack}`);
                reject(error);
            });

            adb.on('close', (code) => {
                console.log(this.TAG, `adb process (${args.join(' ')}) exited with code ${code}`);
                resolve(output);
            });
        });
    }

    public async runAdbCommand(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
        return new Promise((resolve, reject) => {
            const adb = spawn('adb', args, { stdio: ['ignore', 'pipe', 'pipe'] });
            let stdout = '';
            let stderr = '';
            adb.stdout.on('data', (data) => {
                stdout += data.toString();
            });
            adb.stderr.on('data', (data) => {
                stderr += data.toString();
            });
            adb.on('error', reject);
            adb.on('close', (code) => {
                resolve({ stdout, stderr, code: typeof code === 'number' ? code : 1 });
            });
        });
    }

    public async runShellCommandAdbKit(command: string): Promise<string> {
        return this.client
            .shell(this.udid, command)
            .then(AdbExtended.util.readAll)
            .then((output: Buffer) => output.toString().trim());
    }

    public async getGlobalProxy(): Promise<string> {
        if (!this.connected) {
            throw new Error(`Device "${this.udid}" is not connected`);
        }
        return this.runShellCommandAdbKit('settings get global http_proxy');
    }

    public async getAndroidVpnStatus(): Promise<AndroidVpnStatus> {
        if (!this.connected) {
            throw new Error(`Device "${this.udid}" is not connected`);
        }
        try {
            const [connectivity, alwaysOnValue, lockdownValue] = await Promise.all([
                this.runShellCommandAdbKit('dumpsys connectivity'),
                this.runShellCommandAdbKit('settings get secure always_on_vpn_app'),
                this.runShellCommandAdbKit('settings get secure always_on_vpn_lockdown'),
            ]);
            const activeNetworkMatch = connectivity.match(/Active default network:\s*(\d+)/);
            const activeNetworkId = activeNetworkMatch ? activeNetworkMatch[1] : undefined;
            const currentNetworks = connectivity.split('Current Networks:')[1] || '';
            const networkBlocks = currentNetworks.split(/\n(?=  NetworkAgentInfo\{network\{)/);
            const vpnBlocks = networkBlocks.filter((block) => /\bTransports:\s*VPN\b/.test(block));
            const activeVpnBlock = vpnBlocks.find((block) => {
                const id = block.match(/NetworkAgentInfo\{network\{(\d+)\}/);
                return !!id && id[1] === activeNetworkId;
            });
            const vpnBlock = activeVpnBlock || vpnBlocks[0];
            const ownerUidMatch = vpnBlock ? vpnBlock.match(/\bOwnerUid:\s*(\d+)/) : undefined;
            const uid = ownerUidMatch ? parseInt(ownerUidMatch[1], 10) : undefined;
            let packageName: string | undefined;
            if (typeof uid === 'number') {
                const packages = await this.runShellCommandAdbKit('pm list packages -U');
                const packageLine = packages
                    .split('\n')
                    .find((line) => new RegExp(`\\buid:${uid}\\s*$`).test(line.trim()));
                const packageMatch = packageLine ? packageLine.match(/^package:([^\s]+)\s+uid:/) : undefined;
                packageName = packageMatch ? packageMatch[1] : undefined;
            }
            const interfaceMatch = vpnBlock ? vpnBlock.match(/\bInterfaceName:\s*([^\s,}\]]+)/) : undefined;
            const alwaysOnPackage = !alwaysOnValue || alwaysOnValue === 'null' ? undefined : alwaysOnValue;
            return {
                active: vpnBlocks.length > 0,
                isDefault: !!activeVpnBlock,
                packageName,
                uid,
                interfaceName: interfaceMatch ? interfaceMatch[1] : undefined,
                alwaysOnPackage,
                lockdown: lockdownValue === '1' || lockdownValue === 'true',
            };
        } catch (error: unknown) {
            return {
                active: false,
                isDefault: false,
                lockdown: false,
                error: error instanceof Error ? error.message : 'Unable to inspect Android VPN state',
            };
        }
    }

    public async getExternalNetworkStatus(proxy?: string): Promise<string> {
        if (!this.connected) {
            throw new Error(`Device "${this.udid}" is not connected`);
        }
        await this.ensureIpProbe();
        const target = `${Device.IP_PROBE_URL}?_ws_scrcpy=${Date.now()}`;
        const proxyArgument = proxy && proxy !== ':0' ? ` ${Device.shellQuote(proxy)}` : '';
        const output = await this.runShellCommandAdbKit(
            `CLASSPATH=${Device.shellQuote(Device.IP_PROBE_REMOTE_PATH)} app_process / IpProbe ${Device.shellQuote(
                target,
            )}${proxyArgument}`,
        );
        const match = output.match(/^(\d{3})\t([\s\S]*)$/);
        if (!match) {
            throw new Error(`Emulator IP probe returned invalid output: ${output.slice(0, 200) || '(empty)'}`);
        }
        const statusCode = parseInt(match[1], 10);
        if (statusCode !== 200 || !match[2]) {
            throw new Error(`Emulator IP probe failed (${statusCode || 'unknown'})`);
        }
        return match[2];
    }

    private async ensureIpProbe(): Promise<void> {
        if (!this.ipProbeReady) {
            this.ipProbeReady = this.ensureIpProbeInternal().catch((error: unknown) => {
                this.ipProbeReady = undefined;
                throw error;
            });
        }
        return this.ipProbeReady;
    }

    private async ensureIpProbeInternal(): Promise<void> {
        const remotePath = Device.IP_PROBE_REMOTE_PATH;
        // Always replace the device copy once per service process so a stale
        // probe left by an earlier deployment cannot change the result.
        const sourcePath = path.join(__dirname, 'vendor/ws-scrcpy/ip-probe.jar');
        const transfer = await this.push(sourcePath, remotePath);
        await new Promise<void>((resolve, reject) => {
            transfer.once('end', resolve);
            transfer.once('error', reject);
        });
        const verified = await this.runShellCommandAdbKit(
            `test -s ${Device.shellQuote(remotePath)} && echo ready || echo missing`,
        );
        if (verified.trim() !== 'ready') {
            throw new Error('Unable to install the emulator IP probe');
        }
    }

    public async listThirdPartyPackages(): Promise<ThirdPartyPackage[]> {
        if (!this.connected) {
            throw new Error(`Device "${this.udid}" is not connected`);
        }
        const packageOutput = await this.runShellCommandAdbKit('pm list packages -3 -U 2>/dev/null');
        return packageOutput
            .split('\n')
            .map((line) => line.trim().match(/^package:([A-Za-z0-9._]+)(?:\s+uid:(\d+))?$/))
            .filter((match): match is RegExpMatchArray => !!match)
            .map((match) => ({ name: match[1], uid: match[2] ? parseInt(match[2], 10) : undefined }));
    }

    public async stopThirdPartyApps(excludedPackages: string[] = []): Promise<number> {
        const excluded = new Set(excludedPackages);
        const packages = (await this.listThirdPartyPackages()).filter(({ name }) => !excluded.has(name));
        if (packages.length) {
            await this.runShellCommandAdbKit(
                packages.map(({ name }) => `am force-stop ${Device.shellQuote(name)}`).join('; '),
            );
        }
        return packages.length;
    }

    public async setGlobalProxy(
        proxy?: string,
        stopApps = true,
        excludedPackages: string[] = [],
    ): Promise<{ proxy: string; stoppedPackages: number }> {
        if (!this.connected) {
            throw new Error(`Device "${this.udid}" is not connected`);
        }
        const stoppedPackages = stopApps ? await this.stopThirdPartyApps(excludedPackages) : 0;
        const value = proxy || ':0';
        await this.runShellCommandAdbKit(`settings put global http_proxy ${Device.shellQuote(value)}`);
        const applied = await this.getGlobalProxy();
        if (applied !== value) {
            throw new Error(`Proxy verification failed: expected "${value}", got "${applied || '(empty)'}"`);
        }
        return { proxy: applied, stoppedPackages };
    }

    public async setNetworkGuard(
        enabled: boolean,
        excludedPackages: string[] = [],
        allowedProxy?: string,
    ): Promise<NetworkGuardResult> {
        if (!this.connected) {
            throw new Error(`Device "${this.udid}" is not connected`);
        }
        const chain = 'WS_SCRCPY_GUARD';
        const proxySetting = 'ws_scrcpy_guard_proxy';
        const cleanup = (binary: string): string =>
            `while ${binary} -D OUTPUT -j ${chain} 2>/dev/null; do :; done; ` +
            `${binary} -F ${chain} 2>/dev/null || true; ${binary} -X ${chain} 2>/dev/null || true`;
        const packages = await this.listThirdPartyPackages();
        const excluded = new Set(excludedPackages);
        const protectedUids = Array.from(
            new Set(
                packages
                    .filter(({ name, uid }) => !excluded.has(name) && typeof uid === 'number')
                    .map(({ uid }) => uid as number),
            ),
        );
        const commands = [
            cleanup('iptables'),
            'command -v ip6tables >/dev/null 2>&1 && { ' + cleanup('ip6tables') + '; }',
            `settings delete global ${proxySetting} >/dev/null 2>&1 || true`,
        ];
        let allowedProxyAddress: string | undefined;
        let allowedProxyPort: number | undefined;
        if (allowedProxy) {
            const match = allowedProxy.match(/^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/);
            const octets = match ? match[1].split('.').map((part) => parseInt(part, 10)) : [];
            const port = match ? parseInt(match[2], 10) : NaN;
            if (!match || octets.some((octet) => octet < 0 || octet > 255) || port < 1 || port > 65_535) {
                throw new Error(`Invalid network guard proxy: ${allowedProxy}`);
            }
            allowedProxyAddress = match[1];
            allowedProxyPort = port;
        }
        if (enabled) {
            const rules: string[] = [];
            protectedUids.forEach((uid) => {
                if (allowedProxyAddress && allowedProxyPort) {
                    rules.push(
                        `iptables -A ${chain} -p tcp -d ${allowedProxyAddress} --dport ${allowedProxyPort} -m owner --uid-owner ${uid} -j RETURN`,
                    );
                }
                rules.push(`iptables -A ${chain} -m owner --uid-owner ${uid} -j REJECT`);
            });
            const rulesV6 = protectedUids.map((uid) => `ip6tables -A ${chain} -m owner --uid-owner ${uid} -j REJECT`);
            const ip6Rules = rulesV6.length ? `${rulesV6.join('; ')}; ` : '';
            commands.push(
                `iptables -N ${chain}`,
                ...rules,
                `iptables -I OUTPUT 1 -j ${chain}`,
                `command -v ip6tables >/dev/null 2>&1 && { ip6tables -N ${chain}; ${ip6Rules}ip6tables -I OUTPUT 1 -j ${chain}; }`,
            );
            if (allowedProxy) {
                commands.push(`settings put global ${proxySetting} ${Device.shellQuote(allowedProxy)}`);
            }
        }
        commands.push('echo __WS_SCRCPY_GUARD_OK__');
        try {
            const output = await this.runShellCommandAdbKit(`su 0 sh -c ${Device.shellQuote(commands.join('; '))}`);
            if (!output.includes('__WS_SCRCPY_GUARD_OK__')) {
                throw new Error(output || 'Root command did not complete');
            }
            return {
                enabled,
                supported: true,
                protectedPackages: packages.filter(({ name }) => !excluded.has(name)).length,
                allowedProxy: enabled ? allowedProxy : undefined,
            };
        } catch (error: unknown) {
            return {
                enabled: false,
                supported: false,
                protectedPackages: 0,
                error: error instanceof Error ? error.message : 'Root network guard is unavailable',
            };
        }
    }

    public async isNetworkGuardEnabled(): Promise<boolean> {
        return (await this.getNetworkGuardState()).enabled;
    }

    public async getNetworkGuardState(): Promise<NetworkGuardState> {
        if (!this.connected) {
            return { enabled: false };
        }
        try {
            const chain = 'WS_SCRCPY_GUARD';
            const proxySetting = 'ws_scrcpy_guard_proxy';
            const [chainRules, outputRules, proxyMarker] = await Promise.all([
                this.runShellCommandAdbKit(`su 0 iptables -S ${chain} 2>/dev/null`),
                this.runShellCommandAdbKit('su 0 iptables -S OUTPUT 2>/dev/null'),
                this.runShellCommandAdbKit(`settings get global ${proxySetting}`),
            ]);
            const hooked = outputRules.split('\n').some((line) => line.trim() === `-A OUTPUT -j ${chain}`);
            if (!hooked) {
                return { enabled: false };
            }
            const proxyLine = chainRules
                .split('\n')
                .find((line) => line.includes('--dport') && line.includes('-j RETURN'));
            const proxyAddress = proxyLine?.match(/-d (\d{1,3}(?:\.\d{1,3}){3})(?:\/32)?\b/)?.[1];
            const proxyPort = proxyLine?.match(/--dport (\d+)\b/)?.[1];
            const markedProxy = /^(\d{1,3}(?:\.\d{1,3}){3}):(\d{1,5})$/.test(proxyMarker) ? proxyMarker : undefined;
            return {
                enabled: true,
                allowedProxy: markedProxy || (proxyAddress && proxyPort ? `${proxyAddress}:${proxyPort}` : undefined),
            };
        } catch (_error) {
            return { enabled: false };
        }
    }

    public async push(contents: string, path: string): Promise<PushTransfer> {
        return this.client.push(this.udid, contents, path);
    }

    public async installUploadedApks(fileNames: string[]): Promise<string> {
        if (!this.connected) {
            throw new Error(`Device "${this.udid}" is not connected`);
        }
        if (!fileNames.length || fileNames.some((fileName) => !Device.SAFE_APK_FILE_NAME.test(fileName))) {
            throw new Error('Invalid APK file name');
        }
        const names = Array.from(new Set(fileNames));
        if (names.length !== fileNames.length) {
            throw new Error('Duplicate APK file name');
        }
        names.sort((a, b) => (a === 'base.apk' ? -1 : b === 'base.apk' ? 1 : 0));
        if (names.length === 1) {
            return this.runShellCommandAdbKit(`pm install -r /data/local/tmp/${names[0]}`);
        }
        return this.installSplitApks(names);
    }

    public async finalizeUploadedFiles(fileNames: string[]): Promise<string> {
        if (!this.connected) {
            throw new Error(`Device "${this.udid}" is not connected`);
        }
        if (!fileNames.length || fileNames.some((fileName) => !Device.isSafeUploadedFileName(fileName))) {
            throw new Error('Invalid uploaded file name');
        }
        const names = Array.from(new Set(fileNames));
        if (names.length !== fileNames.length) {
            throw new Error('Duplicate uploaded file name');
        }

        const apks = names.filter((fileName) => /\.apk$/i.test(fileName));
        const otherFiles = names.filter((fileName) => !/\.apk$/i.test(fileName));
        const output: string[] = [];
        if (otherFiles.length) {
            await this.moveUploadedFilesToDownload(otherFiles);
            output.push(`${otherFiles.length} file(s) saved to Download`);
        }
        if (apks.length) {
            const installOutput = await this.installUploadedApks(apks);
            if (!/^Success\s*$/m.test(installOutput)) {
                throw new Error(installOutput || 'APK installation failed');
            }
            await this.moveUploadedFilesToDownload(apks);
            output.push(`${apks.length} APK file(s) saved to Download and installed`);
        }
        return output.join('\n');
    }

    private async moveUploadedFilesToDownload(fileNames: string[]): Promise<void> {
        const moveCommands = fileNames.map((fileName) => {
            const source = Device.shellQuote(`${Device.TEMP_PATH}${fileName}`);
            const destination = Device.shellQuote(`${Device.DOWNLOAD_PATH}${fileName}`);
            return `mv -f ${source} ${destination}`;
        });
        const marker = '__WS_SCRCPY_DOWNLOAD_SAVED__';
        const moveOutput = await this.runShellCommandAdbKit(
            `mkdir -p ${Device.shellQuote(Device.DOWNLOAD_PATH)} && ${moveCommands.join(' && ')} && echo ${marker}`,
        );
        if (!moveOutput.includes(marker)) {
            throw new Error(`Unable to move uploaded file to Download: ${moveOutput || 'unknown error'}`);
        }
    }

    private static isSafeUploadedFileName(fileName: string): boolean {
        return Device.SAFE_UPLOADED_FILE_NAME.test(fileName) && !Device.RESERVED_UPLOAD_FILE_NAMES.has(fileName);
    }

    private static shellQuote(value: string): string {
        return `'${value.replace(/'/g, "'\\''")}'`;
    }

    private async installSplitApks(fileNames: string[]): Promise<string> {
        const writes: string[] = [];
        fileNames.forEach((fileName: string) => {
            const path = `/data/local/tmp/${fileName}`;
            writes.push(
                `write_output=$(cmd package install-write -S $(stat -c %s ${path}) "$session_id" ${fileName} ${path})`,
                'printf "%s\\n" "$write_output"',
                'case "$write_output" in Success*) ;; *) cmd package install-abandon "$session_id" >/dev/null; exit 0;; esac',
            );
        });
        const commands = [
            'session_output=$(cmd package install-create -r)',
            'printf "%s\\n" "$session_output"',
            'session_id=$(printf "%s\\n" "$session_output" | sed -n "s/.*\\[\\([0-9][0-9]*\\)\\].*/\\1/p")',
            'if [ -z "$session_id" ]; then exit 0; fi',
            ...writes,
            'cmd package install-commit "$session_id"',
        ];
        return this.runShellCommandAdbKit(commands.join('; '));
    }

    public async getProperties(): Promise<Record<string, string> | undefined> {
        if (this.properties) {
            return this.properties;
        }
        if (!this.connected) {
            return;
        }
        this.properties = await this.client.getProperties(this.udid);
        return this.properties;
    }

    private interfacesSort = (a: NetInterface, b: NetInterface): number => {
        if (a.name > b.name) {
            return 1;
        }
        if (a.name < b.name) {
            return -1;
        }
        return 0;
    };

    public async getNetInterfaces(): Promise<NetInterface[]> {
        if (!this.connected) {
            return [];
        }
        const list: NetInterface[] = [];
        const output = await this.runShellCommandAdbKit(`ip -4 -f inet -o a | grep 'scope global'`);
        const lines = output.split('\n').filter((i: string) => !!i);
        lines.forEach((value: string) => {
            const temp = value.split(' ').filter((i: string) => !!i);
            const name = temp[1];
            const ipAndMask = temp[3];
            const ipv4 = ipAndMask.split('/')[0];
            list.push({ name, ipv4 });
        });
        return list.sort(this.interfacesSort);
    }

    private async pidOf(processName: string): Promise<number[]> {
        return this.runShellCommandAdbKit(`pidof ${processName}`)
            .then((output) => {
                return output
                    .split(' ')
                    .map((pid) => parseInt(pid, 10))
                    .filter((num) => !isNaN(num));
            })
            .catch(() => {
                return [];
            });
    }

    private filterPsOutput(processName: string, output: string): number[] {
        const list: number[] = [];
        const processes = output.split('\n');
        processes.map((line) => {
            const cols = line
                .trim()
                .split(' ')
                .filter((item) => item.length);
            if (cols[cols.length - 1] === processName) {
                const pid = parseInt(cols[1], 10);
                if (!isNaN(pid)) {
                    list.push(pid);
                }
            }
        });
        return list;
    }

    private async grepPs_A(processName: string): Promise<number[]> {
        return this.runShellCommandAdbKit(`ps -A | grep ${processName}`)
            .then((output) => {
                return this.filterPsOutput(processName, output);
            })
            .catch(() => {
                return [];
            });
    }

    private async grepPs(processName: string): Promise<number[]> {
        return this.runShellCommandAdbKit(`ps | grep ${processName}`)
            .then((output) => {
                return this.filterPsOutput(processName, output);
            })
            .catch(() => {
                return [];
            });
    }

    private async listProc(processName: string): Promise<number[]> {
        const find = `find /proc -maxdepth 2 -name cmdline  2>/dev/null`;
        const lines = await this.runShellCommandAdbKit(
            `for L in \`${find}\`; do grep -sae '^${processName}' $L 2>&1 >/dev/null && echo $L; done`,
        );
        const re = /\/proc\/([0-9]+)\/cmdline/;
        const list: number[] = [];
        lines.split('\n').map((line) => {
            const trim = line.trim();
            const m = trim.match(re);
            if (m) {
                list.push(parseInt(m[1], 10));
            }
        });
        return list;
    }

    private async executedWithoutError(command: string): Promise<boolean> {
        return this.runShellCommandAdbKit(command)
            .then((output) => {
                const err = parseInt(output, 10);
                return err === 0;
            })
            .catch(() => {
                return false;
            });
    }

    private async hasPs(): Promise<boolean> {
        return this.executedWithoutError('ps | grep init 2>&1 >/dev/null; echo $?');
    }

    private async hasPs_A(): Promise<boolean> {
        return this.executedWithoutError('ps -A | grep init 2>&1 >/dev/null; echo $?');
    }

    private async hasPidOf(): Promise<boolean> {
        const ok = await this.executedWithoutError('which pidof 2>&1 >/dev/null && echo $?');
        if (!ok) {
            return false;
        }
        return this.runShellCommandAdbKit('echo $PPID; pidof init')
            .then((output) => {
                const pids = output.split('\n').filter((a) => a.length);
                if (pids.length < 2) {
                    return false;
                }
                const parentPid = pids[0].replace('\r', '');
                const list = pids[1].split(' ');
                if (list.includes(parentPid)) {
                    return false;
                }
                return list.includes('1');
            })
            .catch(() => {
                return false;
            });
    }

    private async findDetectionVariant(): Promise<PID_DETECTION> {
        if (await this.hasPidOf()) {
            return PID_DETECTION.PIDOF;
        }
        if (await this.hasPs_A()) {
            return PID_DETECTION.GREP_PS_A;
        }
        if (await this.hasPs()) {
            return PID_DETECTION.GREP_PS;
        }
        return PID_DETECTION.LS_PROC;
    }

    private scheduleInfoUpdate(): void {
        if (this.updateTimeoutId) {
            return;
        }
        if (++this.updateCount > Device.MAX_UPDATES_COUNT) {
            console.error(this.TAG, 'The maximum number of attempts to fetch device info has been reached.');
            return;
        }
        this.updateTimeoutId = setTimeout(this.fetchDeviceInfo, this.updateTimeout);
        this.updateTimeout *= 2;
    }

    private fetchDeviceInfo = (): void => {
        if (this.connected) {
            const propsPromise = this.getProperties().then((props) => {
                if (!props) {
                    return false;
                }
                let changed = false;
                Properties.forEach((propName: keyof GoogDeviceDescriptor) => {
                    if (props[propName] !== this.descriptor[propName]) {
                        changed = true;
                        (this.descriptor[propName] as any) = props[propName];
                    }
                });
                if (changed) {
                    this.emitUpdate();
                }
                return true;
            });
            const netIntPromise = this.updateInterfaces().then((interfaces) => {
                return !!interfaces.length;
            });
            let pidPromise: Promise<number | undefined>;
            if (this.spawnServer) {
                pidPromise = this.startServer();
            } else {
                pidPromise = this.getServerPid();
            }
            const serverPromise = pidPromise.then(() => {
                return !(this.descriptor.pid === -1 && this.spawnServer);
            });
            Promise.all([propsPromise, netIntPromise, serverPromise])
                .then((results) => {
                    this.updateTimeoutId = undefined;
                    const failedCount = results.filter((result) => !result).length;
                    if (!failedCount) {
                        this.updateCount = 0;
                        this.updateTimeout = Device.INITIAL_UPDATE_TIMEOUT;
                    } else {
                        this.scheduleInfoUpdate();
                    }
                })
                .catch(() => {
                    this.updateTimeoutId = undefined;
                    this.scheduleInfoUpdate();
                });
        } else {
            this.updateCount = 0;
            this.updateTimeout = Device.INITIAL_UPDATE_TIMEOUT;
            this.updateTimeoutId = undefined;
            this.emitUpdate();
        }
        return;
    };

    private emitUpdate(setUpdateTime = true): void {
        const THROTTLE = 300;
        const now = Date.now();
        const time = now - this.lastEmit;
        if (setUpdateTime) {
            this.descriptor['last.update.timestamp'] = now;
        }
        if (time > THROTTLE) {
            this.lastEmit = now;
            this.emit('update', this);
            return;
        }
        if (!this.throttleTimeoutId) {
            this.throttleTimeoutId = setTimeout(() => {
                delete this.throttleTimeoutId;
                this.emitUpdate(false);
            }, THROTTLE - time);
        }
    }

    private async getServerPid(): Promise<undefined | number> {
        const pids = await ScrcpyServer.getServerPid(this);
        let pid;
        if (!Array.isArray(pids) || !pids.length) {
            pid = -1;
        } else {
            pid = pids[0];
        }
        if (this.descriptor.pid !== pid) {
            this.descriptor.pid = pid;
            this.emitUpdate();
        }
        if (pid !== -1) {
            return pid;
        } else {
            return;
        }
    }

    public async updateInterfaces(): Promise<NetInterface[]> {
        return this.getNetInterfaces().then((interfaces) => {
            let changed = false;
            const old = this.descriptor.interfaces;
            if (old.length !== interfaces.length) {
                changed = true;
            } else {
                old.forEach((value, idx) => {
                    if (value.name !== interfaces[idx].name || value.ipv4 !== interfaces[idx].ipv4) {
                        changed = true;
                    }
                });
            }
            if (changed) {
                this.descriptor.interfaces = interfaces;
                this.emitUpdate();
            }
            return this.descriptor.interfaces;
        });
    }

    public async killServer(pid: number): Promise<void> {
        this.spawnServer = false;
        this.streamServerOwned = false;
        if (this.streamIdleTimeoutId) {
            clearTimeout(this.streamIdleTimeoutId);
            this.streamIdleTimeoutId = undefined;
        }
        const realPid = await this.getServerPid();
        if (typeof realPid !== 'number') {
            return;
        }
        if (realPid !== pid) {
            console.error(this.TAG, `Requested to kill server with PID ${pid}. Real server PID is ${realPid}.`);
        }
        try {
            const output = await this.killProcess(realPid);
            if (output) {
                console.log(this.TAG, `kill server: "${output}"`);
            }
            this.descriptor.pid = -1;
            this.emitUpdate();
        } catch (error: any) {
            console.error(this.TAG, `Error: ${error.message}`);
            throw error;
        }
    }

    public startServer(): Promise<number | undefined> {
        this.spawnServer = true;
        if (!this.startServerPromise) {
            this.startServerPromise = this.startServerInternal().finally(() => {
                this.startServerPromise = undefined;
            });
        }
        return this.startServerPromise;
    }

    public acquireStreamServer(): Promise<void> {
        if (!this.connected) {
            return Promise.reject(new Error(`Device "${this.udid}" is not connected`));
        }
        if (this.streamIdleTimeoutId) {
            clearTimeout(this.streamIdleTimeoutId);
            this.streamIdleTimeoutId = undefined;
        }
        if (!this.streamAcquirePromise) {
            this.streamAcquirePromise = this.ensureStreamServer().finally(() => {
                this.streamAcquirePromise = undefined;
            });
        }
        return this.streamAcquirePromise.then(() => {
            this.streamClientCount++;
        });
    }

    public releaseStreamServer(): void {
        if (this.streamClientCount === 0) {
            return;
        }
        this.streamClientCount--;
        if (this.streamClientCount || !this.streamServerOwned || this.streamIdleTimeoutId) {
            return;
        }
        this.streamIdleTimeoutId = setTimeout(() => {
            this.streamIdleTimeoutId = undefined;
            this.stopOwnedStreamServer().catch((error: Error) => {
                console.error(this.TAG, `Failed to stop idle stream server: ${error.message}`);
            });
        }, 5000);
    }

    private async ensureStreamServer(): Promise<void> {
        const existingPid = await this.getServerPid();
        if (typeof existingPid === 'number') {
            this.streamServerOwned = false;
            return;
        }
        await this.startServer();
        this.streamServerOwned = true;
    }

    private async stopOwnedStreamServer(): Promise<void> {
        if (this.streamClientCount || !this.streamServerOwned) {
            return;
        }
        const pid = await this.getServerPid();
        if (typeof pid === 'number') {
            await this.killServer(pid);
        } else {
            this.spawnServer = false;
            this.streamServerOwned = false;
        }
    }

    private async startServerInternal(): Promise<number | undefined> {
        const pid = await this.getServerPid();
        if (typeof pid === 'number') {
            return pid;
        }
        try {
            const output = await ScrcpyServer.run(this);
            if (output) {
                console.log(this.TAG, `start server: "${output}"`);
            }
            return this.getServerPid();
        } catch (error: any) {
            console.error(this.TAG, `Error: ${error.message}`);
            throw error;
        }
    }
}
