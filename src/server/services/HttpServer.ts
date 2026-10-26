import * as http from 'http';
import * as https from 'https';
import path from 'path';
import { Service } from './Service';
import { Utils } from '../Utils';
import express, { Express } from 'express';
import { Config } from '../Config';
import { TypedEmitter } from '../../common/TypedEmitter';
import * as process from 'process';
import { EnvName } from '../EnvName';
import { ControlCenter } from '../goog-device/services/ControlCenter';
import { AdbRemoteAccess } from '../goog-device/services/AdbRemoteAccess';
import { WebsocketProxy } from '../mw/WebsocketProxy';

const DEFAULT_STATIC_DIR = path.join(__dirname, './public');

const LISTEN_HOST = process.env.WS_SCRCPY_BIND || '127.0.0.1';
const PATHNAME = process.env[EnvName.WS_SCRCPY_PATHNAME] || __PATHNAME__;
const INSTALL_APK_PATH = `${PATHNAME === '/' ? '' : PATHNAME.replace(/\/$/, '')}/api/install-apk`;
const FINALIZE_UPLOAD_PATH = `${PATHNAME === '/' ? '' : PATHNAME.replace(/\/$/, '')}/api/finalize-upload`;
const API_PREFIX = `${PATHNAME === '/' ? '' : PATHNAME.replace(/\/$/, '')}/api`;
const ADB_STATUS_PATH = `${API_PREFIX}/adb/status`;
const ADB_TOGGLE_PATH = `${API_PREFIX}/adb/toggle`;
const ADB_COMMAND_PATH = `${API_PREFIX}/adb/command`;
const STREAM_METRICS_PATH = `${API_PREFIX}/stream/metrics`;
const NETWORK_STATUS_PATH = `${API_PREFIX}/network/status`;
const NETWORK_PROXY_PATH = `${API_PREFIX}/network/proxy`;
const DEFAULT_ANDROID_PROXY = process.env.WS_SCRCPY_ANDROID_PROXY || '';
// This is the relay exposed by the remote emulator host and forwarded to the
// host VPN. Override it when the deployment uses a different tunnel.
const HOST_VPN_PROXY = process.env.WS_SCRCPY_HOST_VPN_PROXY || '192.168.31.16:7898';

const ADB_OPERATIONS = new Set([
    'devices',
    'version',
    'connect',
    'disconnect',
    'shell',
    'install',
    'install-multiple',
    'push',
    'pull',
    'forward',
    'reverse',
    'reboot',
    'wait-for-device',
    'get-state',
    'get-serialno',
    'start-server',
]);

function parseAdbCommand(command: string, udid: string): string[] {
    if (typeof command !== 'string' || !command.trim()) {
        throw new Error('ADB command is required');
    }
    if (/[;|&`$<>]/.test(command)) {
        throw new Error('Shell operators are not allowed in ADB commands');
    }
    const tokens: string[] = [];
    let token = '';
    let quote = '';
    for (let i = 0; i < command.length; i++) {
        const char = command[i];
        if (quote) {
            if (char === quote) {
                quote = '';
            } else if (char === '\\' && i + 1 < command.length) {
                token += command[++i];
            } else {
                token += char;
            }
        } else if (char === '"' || char === "'") {
            quote = char;
        } else if (/\s/.test(char)) {
            if (token) {
                tokens.push(token);
                token = '';
            }
        } else if (char === '\\' && i + 1 < command.length) {
            token += command[++i];
        } else {
            token += char;
        }
    }
    if (quote) {
        throw new Error('Unclosed quote in ADB command');
    }
    if (token) {
        tokens.push(token);
    }
    if (!tokens.length || (tokens[0] !== 'adb' && tokens[0] !== 'adb.exe')) {
        throw new Error('Command must start with adb');
    }

    let operationIndex = 1;
    let hasSerial = false;
    while (operationIndex < tokens.length && tokens[operationIndex].charAt(0) === '-') {
        const option = tokens[operationIndex];
        if (option === '-s') {
            hasSerial = true;
            operationIndex += 2;
        } else if (option === '-H' || option === '-P' || option === '-L' || option === '-t') {
            operationIndex += 2;
        } else {
            operationIndex++;
        }
    }
    const operation = tokens[operationIndex];
    if (!operation || !ADB_OPERATIONS.has(operation)) {
        throw new Error(`Unsupported ADB operation: ${operation || '(missing)'}`);
    }
    const args = tokens.slice(1);
    if (!hasSerial && !['devices', 'version', 'connect', 'disconnect', 'start-server'].includes(operation)) {
        args.unshift('-s', udid);
    }
    return args;
}

type ExternalNetworkStatus = {
    ip?: string;
    country?: string;
    countryCode?: string;
    region?: string;
    city?: string;
    isp?: string;
    checkedAt: number;
};

type IpWhoIsResponse = {
    success?: boolean;
    ip?: string;
    country?: string;
    country_code?: string;
    region?: string;
    city?: string;
    connection?: { isp?: string };
};

type HostVpnStatus = ExternalNetworkStatus & {
    available: boolean;
    proxy: string;
    error?: string;
};

const externalNetworkStatusCache: Map<string, ExternalNetworkStatus> = new Map();
const externalNetworkStatusPromises: Map<string, Promise<ExternalNetworkStatus>> = new Map();

function parseIpWhoIsResponse(body: string, source: string): ExternalNetworkStatus {
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

function requestExternalNetworkStatus(proxy?: string, useCache = true): Promise<ExternalNetworkStatus> {
    const cacheKey = proxy || 'direct';
    const cached = externalNetworkStatusCache.get(cacheKey);
    if (useCache && cached && Date.now() - cached.checkedAt < 60_000) {
        return Promise.resolve(cached);
    }
    const pending = externalNetworkStatusPromises.get(cacheKey);
    if (pending) {
        return pending;
    }
    const requestUrl = 'http://ipwho.is/';
    const requestOptions = proxy
        ? (() => {
              const [hostname, portString] = proxy.split(':');
              return {
                  hostname,
                  port: parseInt(portString, 10),
                  path: requestUrl,
                  headers: { Host: 'ipwho.is' },
                  timeout: 10_000,
              };
          })()
        : undefined;
    const requestPromise = new Promise<ExternalNetworkStatus>((resolve, reject) => {
        const request = proxy
            ? http.get(requestOptions as http.RequestOptions, handleResponse)
            : https.get('https://ipwho.is/', { timeout: 10_000 }, handleResponse);

        function handleResponse(response: http.IncomingMessage): void {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk) => (body += chunk));
            response.on('end', () => {
                try {
                    if (response.statusCode !== 200) {
                        throw new Error(`External IP lookup failed (${response.statusCode || 'unknown'})`);
                    }
                    const status = parseIpWhoIsResponse(body, 'Host network lookup');
                    externalNetworkStatusCache.set(cacheKey, status);
                    resolve(status);
                } catch (error) {
                    reject(error);
                }
            });
        }
        request.on('error', reject);
        request.on('timeout', () => request.destroy(new Error('External IP lookup timed out')));
    }).finally(() => {
        externalNetworkStatusPromises.delete(cacheKey);
    });
    externalNetworkStatusPromises.set(cacheKey, requestPromise);
    return requestPromise;
}

async function requestHostVpnStatus(): Promise<HostVpnStatus> {
    try {
        const [network, direct] = await Promise.all([
            requestExternalNetworkStatus(HOST_VPN_PROXY, false),
            requestExternalNetworkStatus(undefined, false),
        ]);
        if (network.ip && direct.ip && network.ip === direct.ip) {
            return {
                ...network,
                available: false,
                proxy: HOST_VPN_PROXY,
                error: 'Host VPN proxy is reachable, but its exit IP matches the direct network',
            };
        }
        return { ...network, available: true, proxy: HOST_VPN_PROXY };
    } catch (error: unknown) {
        return {
            available: false,
            proxy: HOST_VPN_PROXY,
            checkedAt: Date.now(),
            error: error instanceof Error ? error.message : 'Host VPN proxy unavailable',
        };
    }
}

export type ServerAndPort = {
    server: https.Server | http.Server;
    port: number;
};

interface HttpServerEvents {
    started: boolean;
}

export class HttpServer extends TypedEmitter<HttpServerEvents> implements Service {
    private static instance: HttpServer;
    private static PUBLIC_DIR = DEFAULT_STATIC_DIR;
    private static SERVE_STATIC = true;
    private servers: ServerAndPort[] = [];
    private mainApp?: Express;
    private started = false;

    protected constructor() {
        super();
    }

    public static getInstance(): HttpServer {
        if (!this.instance) {
            this.instance = new HttpServer();
        }
        return this.instance;
    }

    public static hasInstance(): boolean {
        return !!this.instance;
    }

    public static setPublicDir(dir: string): void {
        if (HttpServer.instance) {
            throw Error('Unable to change value after instantiation');
        }
        HttpServer.PUBLIC_DIR = dir;
    }

    public static setServeStatic(enabled: boolean): void {
        if (HttpServer.instance) {
            throw Error('Unable to change value after instantiation');
        }
        HttpServer.SERVE_STATIC = enabled;
    }

    public async getServers(): Promise<ServerAndPort[]> {
        if (this.started) {
            return [...this.servers];
        }
        return new Promise<ServerAndPort[]>((resolve) => {
            this.once('started', () => {
                resolve([...this.servers]);
            });
        });
    }

    public getName(): string {
        return `HTTP(s) Server Service`;
    }

    public async start(): Promise<void> {
        this.mainApp = express();
        this.mainApp.use(express.json());
        this.mainApp.get(ADB_STATUS_PATH, (req, res) => {
            const udid = typeof req.query.udid === 'string' ? req.query.udid : '';
            if (!udid) {
                return res.status(400).json({ success: false, output: 'udid is required' });
            }
            try {
                const status = AdbRemoteAccess.getInstance().getStatus(udid);
                return res.json({ success: true, status });
            } catch (error: unknown) {
                const output = error instanceof Error ? error.message : 'Unable to read ADB status';
                return res.status(400).json({ success: false, output });
            }
        });
        this.mainApp.get(STREAM_METRICS_PATH, (_req, res) => {
            return res.json({
                success: true,
                generatedAt: Date.now(),
                streams: WebsocketProxy.getMetrics(),
            });
        });
        this.mainApp.get(NETWORK_STATUS_PATH, async (req, res) => {
            const udid = typeof req.query.udid === 'string' ? req.query.udid : '';
            if (!udid) {
                return res.status(400).json({ success: false, output: 'udid is required' });
            }
            const device = ControlCenter.getInstance().getDevice(udid);
            if (!device) {
                return res.status(404).json({ success: false, output: `Device "${udid}" was not found` });
            }
            try {
                const [proxy, emulatorResponse] = await Promise.all([
                    device.getGlobalProxy(),
                    device.getExternalNetworkStatus(),
                ]);
                const network = parseIpWhoIsResponse(emulatorResponse, 'Emulator network probe');
                const hostVpn = await requestHostVpnStatus();
                return res.json({
                    success: true,
                    status: {
                        ...network,
                        ipSource: 'emulator-network',
                        proxy,
                        configuredProxy: DEFAULT_ANDROID_PROXY,
                        proxyWarning: proxy.length > 0 && proxy !== ':0',
                        hostVpn,
                    },
                });
            } catch (error: unknown) {
                const output = error instanceof Error ? error.message : 'Unable to read network status';
                return res.status(502).json({ success: false, output });
            }
        });
        this.mainApp.post(NETWORK_PROXY_PATH, async (req, res) => {
            const { udid, mode, reboot } = req.body || {};
            if (typeof udid !== 'string' || (mode !== 'clear' && mode !== 'host-vpn')) {
                return res.status(400).json({ success: false, output: 'udid and mode are required' });
            }
            let targetProxy: string | undefined;
            if (mode === 'host-vpn') {
                const hostVpn = await requestHostVpnStatus();
                if (!hostVpn.available) {
                    return res.status(503).json({
                        success: false,
                        output: `Host VPN is unavailable via ${HOST_VPN_PROXY}`,
                        hostVpn,
                    });
                }
                targetProxy = HOST_VPN_PROXY;
            }
            const device = ControlCenter.getInstance().getDevice(udid);
            if (!device) {
                return res.status(404).json({ success: false, output: `Device "${udid}" was not found` });
            }
            try {
                const result = await device.setGlobalProxy(targetProxy);
                if (reboot === true) {
                    // Let the HTTP response reach the browser before the device drops ADB.
                    setTimeout(() => void device.runShellCommandAdbKit('reboot'), 250);
                }
                return res.json({ success: true, rebooting: reboot === true, status: result });
            } catch (error: unknown) {
                const output = error instanceof Error ? error.message : 'Unable to change device proxy';
                return res.status(500).json({ success: false, output });
            }
        });
        this.mainApp.post(ADB_TOGGLE_PATH, async (req, res) => {
            const { udid, enabled } = req.body || {};
            if (typeof udid !== 'string' || typeof enabled !== 'boolean') {
                return res.status(400).json({ success: false, output: 'udid and enabled are required' });
            }
            const device = ControlCenter.getInstance().getDevice(udid);
            if (!device) {
                return res.status(404).json({ success: false, output: `Device "${udid}" was not found` });
            }
            try {
                const status = await AdbRemoteAccess.getInstance().setEnabled(udid, enabled);
                return res.json({ success: true, status });
            } catch (error: unknown) {
                const output = error instanceof Error ? error.message : 'Unable to change ADB status';
                return res.status(500).json({ success: false, output });
            }
        });
        this.mainApp.post(ADB_COMMAND_PATH, async (req, res) => {
            const { udid, command } = req.body || {};
            if (typeof udid !== 'string' || typeof command !== 'string') {
                return res.status(400).json({ success: false, output: 'udid and command are required' });
            }
            const device = ControlCenter.getInstance().getDevice(udid);
            if (!device) {
                return res.status(404).json({ success: false, output: `Device "${udid}" was not found` });
            }
            try {
                if (!AdbRemoteAccess.getInstance().getStatus(udid).enabled) {
                    return res
                        .status(409)
                        .json({ success: false, output: 'Enable ADB TCP access before executing commands' });
                }
                const args = parseAdbCommand(command, udid);
                const result = await device.runAdbCommand(args);
                const success = result.code === 0;
                return res.status(success ? 200 : 422).json({ success, ...result });
            } catch (error: unknown) {
                const output = error instanceof Error ? error.message : 'ADB command failed';
                return res.status(400).json({ success: false, output });
            }
        });
        this.mainApp.post(INSTALL_APK_PATH, async (req, res) => {
            const { udid, fileName, fileNames } = req.body || {};
            const names = Array.isArray(fileNames) ? fileNames : typeof fileName === 'string' ? [fileName] : undefined;
            if (
                typeof udid !== 'string' ||
                !names ||
                !names.length ||
                !names.every((name) => typeof name === 'string')
            ) {
                return res.status(400).json({ success: false, output: 'udid and fileNames are required' });
            }
            const device = ControlCenter.getInstance().getDevice(udid);
            if (!device) {
                return res.status(404).json({ success: false, output: `Device "${udid}" was not found` });
            }
            try {
                const output = await device.installUploadedApks(names);
                const success = /^Success\s*$/m.test(output);
                return res.status(success ? 200 : 422).json({ success, output });
            } catch (error: unknown) {
                const output = error instanceof Error ? error.message : 'APK installation failed';
                return res.status(500).json({ success: false, output });
            }
        });
        this.mainApp.post(FINALIZE_UPLOAD_PATH, async (req, res) => {
            const { udid, fileNames } = req.body || {};
            if (
                typeof udid !== 'string' ||
                !Array.isArray(fileNames) ||
                !fileNames.length ||
                !fileNames.every((name) => typeof name === 'string')
            ) {
                return res.status(400).json({ success: false, output: 'udid and fileNames are required' });
            }
            const device = ControlCenter.getInstance().getDevice(udid);
            if (!device) {
                return res.status(404).json({ success: false, output: `Device "${udid}" was not found` });
            }
            try {
                const output = await device.finalizeUploadedFiles(fileNames);
                return res.json({ success: true, output });
            } catch (error: unknown) {
                const output = error instanceof Error ? error.message : 'Unable to process uploaded files';
                return res.status(422).json({ success: false, output });
            }
        });
        if (HttpServer.SERVE_STATIC && HttpServer.PUBLIC_DIR) {
            this.mainApp.use(PATHNAME, express.static(HttpServer.PUBLIC_DIR));

            /// #if USE_WDA_MJPEG_SERVER

            const { MjpegProxyFactory } = await import('../mw/MjpegProxyFactory');
            this.mainApp.get('/mjpeg/:udid', new MjpegProxyFactory().proxyRequest);
            /// #endif
        }
        const config = Config.getInstance();
        config.servers.forEach((serverItem) => {
            const { secure, port, redirectToSecure } = serverItem;
            let proto: string;
            let server: http.Server | https.Server;
            if (secure) {
                if (!serverItem.options) {
                    throw Error('Must provide option for secure server configuration');
                }
                server = https.createServer(serverItem.options, this.mainApp);
                proto = 'https';
            } else {
                const options = serverItem.options ? { ...serverItem.options } : {};
                proto = 'http';
                let currentApp = this.mainApp;
                let host = '';
                let port = 443;
                let doRedirect = false;
                if (redirectToSecure === true) {
                    doRedirect = true;
                } else if (typeof redirectToSecure === 'object') {
                    doRedirect = true;
                    if (typeof redirectToSecure.port === 'number') {
                        port = redirectToSecure.port;
                    }
                    if (typeof redirectToSecure.host === 'string') {
                        host = redirectToSecure.host;
                    }
                }
                if (doRedirect) {
                    currentApp = express();
                    currentApp.use(function (req, res) {
                        const url = new URL(`https://${host ? host : req.headers.host}${req.url}`);
                        if (port && port !== 443) {
                            url.port = port.toString();
                        }
                        return res.redirect(301, url.toString());
                    });
                }
                server = http.createServer(options, currentApp);
            }
            this.servers.push({ server, port });
            server.listen(port, LISTEN_HOST, () => {
                Utils.printListeningMsg(proto, port, PATHNAME);
            });
        });
        this.started = true;
        this.emit('started', true);
    }

    public release(): void {
        AdbRemoteAccess.getInstance().release();
        this.servers.forEach((item) => {
            item.server.close();
        });
    }
}
