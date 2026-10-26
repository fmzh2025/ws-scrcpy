import { execFile } from 'child_process';
import * as http from 'http';
import * as https from 'https';
import * as net from 'net';
import * as process from 'process';
import {
    ExternalNetworkStatus,
    HostDirectStatus,
    HostSystemProxyStatus,
    HostVpnStatus,
} from '../../../types/NetworkRouteStatus';
import { HostDirectProxy } from './HostDirectProxy';

type HostNetworkSnapshot = {
    hostDefault: ExternalNetworkStatus;
    hostDirect: HostDirectStatus;
    hostVpn: HostVpnStatus;
};

type ProxyEndpoint = {
    host: string;
    port: number;
};

type CachedHostSnapshot = {
    value: HostNetworkSnapshot;
    expiresAt: number;
};

const DEVICE_PROXY = process.env.WS_SCRCPY_HOST_VPN_PROXY || '10.0.2.2:7898';
const RELAY_BIND = process.env.WS_SCRCPY_HOST_VPN_RELAY_BIND || '127.0.0.1';
const RELAY_ENABLED = process.env.WS_SCRCPY_HOST_VPN_RELAY !== '0';
const HOST_STATUS_CACHE_MS = 10_000;
const SYSTEM_ROUTE_CACHE_MS = 2_000;

function parseProxyEndpoint(value?: string): ProxyEndpoint | undefined {
    if (!value) {
        return;
    }
    const normalized = /^[a-z]+:\/\//i.test(value) ? value : `http://${value}`;
    try {
        const url = new URL(normalized);
        const port = parseInt(url.port || '80', 10);
        if (!url.hostname || !Number.isFinite(port) || port < 1 || port > 65535) {
            return;
        }
        return { host: url.hostname, port };
    } catch (_error) {
        return;
    }
}

function runCommand(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(command, args, { timeout: 4_000 }, (error, stdout) => {
            if (error) {
                reject(error);
            } else {
                resolve(stdout.toString());
            }
        });
    });
}

type IpWhoIsResponse = {
    success?: boolean;
    ip?: string;
    country?: string;
    country_code?: string;
    region?: string;
    city?: string;
    connection?: { isp?: string };
};

export function parseIpWhoIsResponse(body: string, source: string): ExternalNetworkStatus {
    let data: IpWhoIsResponse;
    try {
        data = JSON.parse(body) as IpWhoIsResponse;
    } catch (_error) {
        throw new Error(`${source} returned invalid JSON`);
    }
    if (data.success === false || !data.ip) {
        throw new Error(`${source} did not return a public IP`);
    }
    return {
        ip: data.ip,
        country: data.country,
        countryCode: data.country_code,
        region: data.region,
        city: data.city,
        isp: data.connection?.isp,
        checkedAt: Date.now(),
    };
}

function requestExternalNetworkStatus(proxy?: ProxyEndpoint, source?: string): Promise<ExternalNetworkStatus> {
    const requestUrl = `http://ipwho.is/?_ws_scrcpy=${Date.now()}`;
    return new Promise((resolve, reject) => {
        const handleResponse = (response: http.IncomingMessage): void => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => (body += chunk));
            response.on('end', () => {
                try {
                    if (response.statusCode !== 200) {
                        throw new Error(`External IP lookup failed (${response.statusCode || 'unknown'})`);
                    }
                    resolve(
                        parseIpWhoIsResponse(body, source || (proxy ? 'Host proxy lookup' : 'Host default lookup')),
                    );
                } catch (error) {
                    reject(error);
                }
            });
        };
        const request = proxy
            ? http.get(
                  {
                      hostname: proxy.host,
                      port: proxy.port,
                      path: requestUrl,
                      headers: { Host: 'ipwho.is', Connection: 'close', 'Cache-Control': 'no-cache' },
                      timeout: 10_000,
                  },
                  handleResponse,
              )
            : https.get(
                  `https://ipwho.is/?_ws_scrcpy=${Date.now()}`,
                  { headers: { Connection: 'close', 'Cache-Control': 'no-cache' }, timeout: 10_000 },
                  handleResponse,
              );
        request.on('error', reject);
        request.on('timeout', () => request.destroy(new Error('External IP lookup timed out')));
    });
}

export class HostNetworkProbe {
    private static instance?: HostNetworkProbe;
    private readonly relayPort: number;
    private readonly directProxy = new HostDirectProxy();
    private relayServer?: net.Server;
    private relayError?: string;
    private cachedSnapshot?: CachedHostSnapshot;
    private snapshotPromise?: Promise<HostNetworkSnapshot>;
    private cachedSystemState?: {
        proxy: HostSystemProxyStatus;
        defaultInterface?: string;
        expiresAt: number;
    };

    private constructor() {
        const deviceProxy = parseProxyEndpoint(DEVICE_PROXY);
        this.relayPort = parseInt(process.env.WS_SCRCPY_HOST_VPN_RELAY_PORT || '', 10) || deviceProxy?.port || 7898;
    }

    public static getInstance(): HostNetworkProbe {
        if (!this.instance) {
            this.instance = new HostNetworkProbe();
        }
        return this.instance;
    }

    public getDeviceProxy(): string {
        return DEVICE_PROXY;
    }

    public getDirectDeviceProxy(): string {
        return this.directProxy.getDeviceProxy();
    }

    public isRelayAvailable(): boolean {
        return !!this.relayServer?.listening && !this.relayError;
    }

    public isDirectRelayAvailable(): boolean {
        return this.directProxy.isAvailable();
    }

    public startRelay(): void {
        this.directProxy.start();
        if (!RELAY_ENABLED || this.relayServer) {
            return;
        }
        const server = net.createServer((client) => void this.forwardRelayConnection(client));
        this.relayServer = server;
        server.on('error', (error: NodeJS.ErrnoException) => {
            this.relayError = error.message;
            console.error(`Host VPN relay failed on ${RELAY_BIND}:${this.relayPort}: ${error.message}`);
        });
        server.listen(this.relayPort, RELAY_BIND, () => {
            this.relayError = undefined;
            console.log(`Host VPN relay listening on ${RELAY_BIND}:${this.relayPort}`);
        });
    }

    public stopRelay(): void {
        this.relayServer?.close();
        this.relayServer = undefined;
        this.directProxy.stop();
    }

    public async getSnapshot(force = false): Promise<HostNetworkSnapshot> {
        if (!force && this.cachedSnapshot && this.cachedSnapshot.expiresAt > Date.now()) {
            return this.cachedSnapshot.value;
        }
        if (this.snapshotPromise) {
            return this.snapshotPromise;
        }
        this.snapshotPromise = this.readSnapshot()
            .then((value) => {
                this.cachedSnapshot = { value, expiresAt: Date.now() + HOST_STATUS_CACHE_MS };
                return value;
            })
            .finally(() => {
                this.snapshotPromise = undefined;
            });
        return this.snapshotPromise;
    }

    private async readSnapshot(): Promise<HostNetworkSnapshot> {
        const [{ proxy: systemProxy, defaultInterface }, hostDefaultResult, physicalRoute] = await Promise.all([
            this.getSystemState(true),
            requestExternalNetworkStatus().catch(
                (error: unknown): ExternalNetworkStatus => ({
                    checkedAt: Date.now(),
                    error: error instanceof Error ? error.message : 'Host default lookup failed',
                }),
            ),
            this.directProxy.getPhysicalRoute(true),
        ]);
        const tunnelActive = !!defaultInterface && /^(?:utun|tun|tap|wg|ppp|tailscale|ipsec)/i.test(defaultInterface);
        const proxyEndpoint =
            systemProxy.enabled && systemProxy.host && systemProxy.port
                ? { host: systemProxy.host, port: systemProxy.port }
                : undefined;
        let proxyNetwork: ExternalNetworkStatus | undefined;
        let proxyError: string | undefined;
        if (proxyEndpoint) {
            try {
                proxyNetwork = await requestExternalNetworkStatus(proxyEndpoint, 'Host VPN lookup');
            } catch (error: unknown) {
                proxyError = error instanceof Error ? error.message : 'Host VPN proxy lookup failed';
            }
        }
        const exitDiffers = !!proxyNetwork?.ip && !!hostDefaultResult.ip && proxyNetwork.ip !== hostDefaultResult.ip;
        const proxyReachable = !!proxyNetwork?.ip;
        const active = tunnelActive || (systemProxy.enabled && proxyReachable) || exitDiffers;
        const evidence: string[] = [];
        if (tunnelActive) {
            evidence.push(`default route uses ${defaultInterface}`);
        }
        if (systemProxy.enabled) {
            evidence.push('macOS system proxy is enabled');
        }
        if (proxyReachable) {
            evidence.push('host VPN proxy returned a public IP');
        }
        if (exitDiffers) {
            evidence.push('host VPN proxy exit differs from host default exit');
        }
        const hostVpnNetwork = proxyNetwork || (tunnelActive ? hostDefaultResult : undefined);
        const error = active
            ? proxyError
            : proxyError || this.relayError || 'No active host VPN tunnel or reachable system proxy was detected';
        let hostDirectNetwork: ExternalNetworkStatus = {
            checkedAt: Date.now(),
            error: this.directProxy.getError() || 'Host direct relay is unavailable',
        };
        if (this.directProxy.isAvailable() && physicalRoute) {
            hostDirectNetwork = await requestExternalNetworkStatus(
                this.directProxy.getProbeProxy(),
                'Host direct lookup',
            ).catch(
                (directError: unknown): ExternalNetworkStatus => ({
                    checkedAt: Date.now(),
                    error: directError instanceof Error ? directError.message : 'Host direct lookup failed',
                }),
            );
        }
        const hostDirect: HostDirectStatus = {
            ...hostDirectNetwork,
            available: !!hostDirectNetwork.ip && !!physicalRoute && this.directProxy.isAvailable(),
            relayAvailable: this.directProxy.isAvailable(),
            deviceProxy: this.directProxy.getDeviceProxy(),
            interfaceName: physicalRoute?.interfaceName,
            gateway: physicalRoute?.gateway,
        };
        return {
            hostDefault: hostDefaultResult,
            hostDirect,
            hostVpn: {
                ...(hostVpnNetwork || { checkedAt: Date.now() }),
                active,
                proxyReachable,
                deviceProxy: DEVICE_PROXY,
                upstreamProxy: proxyEndpoint ? `${proxyEndpoint.host}:${proxyEndpoint.port}` : undefined,
                defaultInterface,
                tunnelActive,
                systemProxy,
                evidence,
                error,
            },
        };
    }

    private async getSystemState(force = false): Promise<{
        proxy: HostSystemProxyStatus;
        defaultInterface?: string;
    }> {
        if (!force && this.cachedSystemState && this.cachedSystemState.expiresAt > Date.now()) {
            return this.cachedSystemState;
        }
        const [proxy, defaultInterface] = await Promise.all([this.readSystemProxy(), this.readDefaultInterface()]);
        this.cachedSystemState = {
            proxy,
            defaultInterface,
            expiresAt: Date.now() + SYSTEM_ROUTE_CACHE_MS,
        };
        return { proxy, defaultInterface };
    }

    private async readSystemProxy(): Promise<HostSystemProxyStatus> {
        const configured = parseProxyEndpoint(
            process.env.WS_SCRCPY_HOST_VPN_UPSTREAM || process.env.HTTPS_PROXY || process.env.HTTP_PROXY,
        );
        if (configured) {
            return { enabled: true, host: configured.host, port: configured.port };
        }
        if (process.platform !== 'darwin') {
            return { enabled: false };
        }
        try {
            const output = await runCommand('/usr/sbin/scutil', ['--proxy']);
            const httpsEnabled = /HTTPSEnable\s*:\s*1/.test(output);
            const httpEnabled = /HTTPEnable\s*:\s*1/.test(output);
            const prefix = httpsEnabled ? 'HTTPS' : 'HTTP';
            const host = output.match(new RegExp(`${prefix}Proxy\\s*:\\s*(\\S+)`));
            const port = output.match(new RegExp(`${prefix}Port\\s*:\\s*(\\d+)`));
            if ((httpsEnabled || httpEnabled) && host && port) {
                return { enabled: true, host: host[1], port: parseInt(port[1], 10) };
            }
        } catch (_error) {
            // A missing platform command means no system proxy evidence is available.
        }
        return { enabled: false };
    }

    private async readDefaultInterface(): Promise<string | undefined> {
        try {
            if (process.platform === 'darwin') {
                const output = await runCommand('/sbin/route', ['-n', 'get', '1.1.1.1']);
                return output.match(/interface:\s*(\S+)/)?.[1];
            }
            if (process.platform === 'linux') {
                const output = await runCommand('/sbin/ip', ['route', 'get', '1.1.1.1']);
                return output.match(/\bdev\s+(\S+)/)?.[1];
            }
        } catch (_error) {
            return;
        }
        return;
    }

    private async forwardRelayConnection(client: net.Socket): Promise<void> {
        client.pause();
        client.setTimeout(15_000, () => client.destroy());
        try {
            const { proxy } = await this.getSystemState(true);
            if (!proxy.enabled || !proxy.host || !proxy.port) {
                throw new Error('Host system VPN proxy is off');
            }
            if (proxy.port === this.relayPort && ['127.0.0.1', 'localhost', RELAY_BIND].includes(proxy.host)) {
                throw new Error('Host VPN relay cannot forward to itself');
            }
            const upstream = net.connect(proxy.port, proxy.host);
            upstream.setTimeout(15_000, () => upstream.destroy());
            upstream.once('connect', () => {
                client.setTimeout(0);
                upstream.setTimeout(0);
                client.pipe(upstream).pipe(client);
                client.resume();
            });
            upstream.once('error', () => client.destroy());
            client.once('error', () => upstream.destroy());
            client.once('close', () => upstream.destroy());
        } catch (_error) {
            client.destroy();
        }
    }
}
