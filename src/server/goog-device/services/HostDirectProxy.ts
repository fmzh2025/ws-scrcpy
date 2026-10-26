import { spawn } from 'child_process';
import * as dns from 'dns';
import * as net from 'net';
import * as process from 'process';

export type HostPhysicalRoute = {
    interfaceName: string;
    gateway: string;
    dnsServer: string;
};

type ParsedRequest = {
    host: string;
    port: number;
    connect: boolean;
    initialPayload: Buffer;
};

const DIRECT_DEVICE_PROXY = process.env.WS_SCRCPY_HOST_DIRECT_PROXY || '10.0.2.2:7899';
const DIRECT_RELAY_BIND = process.env.WS_SCRCPY_HOST_DIRECT_RELAY_BIND || '127.0.0.1';
const DIRECT_RELAY_ENABLED = process.env.WS_SCRCPY_HOST_DIRECT_RELAY !== '0';
const DIRECT_INTERFACE = process.env.WS_SCRCPY_HOST_DIRECT_INTERFACE;
const DIRECT_GATEWAY = process.env.WS_SCRCPY_HOST_DIRECT_GATEWAY;
const DIRECT_DNS = process.env.WS_SCRCPY_HOST_DIRECT_DNS;
const ROUTE_CACHE_MS = 2_000;
const MAX_HEADER_BYTES = 64 * 1024;
const INITIAL_REQUEST_TIMEOUT_MS = 15_000;

function parseProxyPort(value: string): number | undefined {
    const match = value.match(/:(\d+)$/);
    const port = match ? parseInt(match[1], 10) : NaN;
    return Number.isFinite(port) && port > 0 && port <= 65_535 ? port : undefined;
}

function runCommand(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => child.kill(), 4_000);
        child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
        child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
        child.once('error', reject);
        child.once('close', (code) => {
            clearTimeout(timer);
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(stderr.trim() || `${command} exited with ${code === null ? 'a signal' : code}`));
            }
        });
    });
}

function isTunnelInterface(interfaceName: string): boolean {
    return /^(?:utun|tun|tap|wg|ppp|tailscale|ipsec)/i.test(interfaceName);
}

export function parsePhysicalDefaultRoute(output: string): Omit<HostPhysicalRoute, 'dnsServer'> | undefined {
    const candidates = output
        .split('\n')
        .map((line) => line.trim().split(/\s+/))
        .filter((columns) => columns[0] === 'default' && columns.length >= 4)
        .map((columns) => ({ gateway: columns[1], interfaceName: columns[3] }))
        .filter(
            ({ gateway, interfaceName }) =>
                net.isIPv4(gateway) && !isTunnelInterface(interfaceName) && interfaceName !== 'lo0',
        );
    return candidates[0];
}

export function isPublicIpv4(value: string): boolean {
    if (!net.isIPv4(value)) {
        return false;
    }
    const [first, second] = value.split('.').map((part) => parseInt(part, 10));
    return !(
        first === 0 ||
        first === 10 ||
        first === 127 ||
        first >= 224 ||
        (first === 100 && second >= 64 && second <= 127) ||
        (first === 169 && second === 254) ||
        (first === 172 && second >= 16 && second <= 31) ||
        (first === 192 && second === 168) ||
        (first === 198 && (second === 18 || second === 19))
    );
}

function parseAuthority(authority: string, defaultPort: number): { host: string; port: number } | undefined {
    if (!authority || authority.startsWith('[')) {
        return;
    }
    const separator = authority.lastIndexOf(':');
    const hasPort = separator > 0 && authority.indexOf(':') === separator;
    const host = (hasPort ? authority.slice(0, separator) : authority).trim();
    const port = hasPort ? parseInt(authority.slice(separator + 1), 10) : defaultPort;
    if (!host || !Number.isFinite(port) || port < 1 || port > 65_535) {
        return;
    }
    return { host, port };
}

function parseInitialRequest(header: Buffer, remainder: Buffer): ParsedRequest | undefined {
    const text = header.toString('latin1');
    const lines = text.split('\r\n');
    const requestLine = lines[0]?.match(/^([A-Z]+)\s+(\S+)\s+(HTTP\/\d(?:\.\d)?)$/);
    if (!requestLine) {
        return;
    }
    const [, method, target, version] = requestLine;
    if (method === 'CONNECT') {
        const authority = parseAuthority(target, 443);
        return authority ? { ...authority, connect: true, initialPayload: remainder } : undefined;
    }

    let url: URL;
    try {
        url = new URL(target);
    } catch (_error) {
        const hostHeader = lines.find((line) => /^host:/i.test(line))?.replace(/^host:\s*/i, '');
        if (!hostHeader) {
            return;
        }
        try {
            url = new URL(`http://${hostHeader}${target.startsWith('/') ? target : `/${target}`}`);
        } catch (_nestedError) {
            return;
        }
    }
    if (url.protocol !== 'http:') {
        return;
    }
    const authority = parseAuthority(url.host, 80);
    if (!authority) {
        return;
    }
    const rewrittenLines = lines.slice(1).filter((line) => line && !/^(?:proxy-connection|connection):/i.test(line));
    rewrittenLines.push('Connection: close');
    const path = `${url.pathname || '/'}${url.search}`;
    const rewrittenHeader = Buffer.from(
        `${method} ${path} ${version}\r\n${rewrittenLines.join('\r\n')}\r\n\r\n`,
        'latin1',
    );
    return {
        ...authority,
        connect: false,
        initialPayload: Buffer.concat([rewrittenHeader, remainder]),
    };
}

export class HostDirectProxy {
    private readonly relayPort = parseProxyPort(DIRECT_DEVICE_PROXY) || 7899;
    private server?: net.Server;
    private serverError?: string;
    private cachedRoute?: { value?: HostPhysicalRoute; expiresAt: number; error?: string };
    private readonly dnsCache: Map<string, { address: string; expiresAt: number }> = new Map();

    public getDeviceProxy(): string {
        return DIRECT_DEVICE_PROXY;
    }

    public getProbeProxy(): { host: string; port: number } {
        return { host: DIRECT_RELAY_BIND, port: this.relayPort };
    }

    public isAvailable(): boolean {
        return !!this.server?.listening && !this.serverError;
    }

    public getError(): string | undefined {
        return this.serverError || this.cachedRoute?.error;
    }

    public start(): void {
        if (!DIRECT_RELAY_ENABLED || this.server) {
            return;
        }
        if (process.platform !== 'darwin') {
            this.serverError = 'Host direct relay currently requires macOS interface-bound sockets';
            return;
        }
        const server = net.createServer((client) => this.accept(client));
        this.server = server;
        server.on('error', (error: NodeJS.ErrnoException) => {
            this.serverError = error.message;
            console.error(`Host direct relay failed on ${DIRECT_RELAY_BIND}:${this.relayPort}: ${error.message}`);
        });
        server.listen(this.relayPort, DIRECT_RELAY_BIND, () => {
            this.serverError = undefined;
            console.log(`Host direct relay listening on ${DIRECT_RELAY_BIND}:${this.relayPort}`);
        });
    }

    public stop(): void {
        this.server?.close();
        this.server = undefined;
    }

    public async getPhysicalRoute(force = false): Promise<HostPhysicalRoute | undefined> {
        if (!force && this.cachedRoute && this.cachedRoute.expiresAt > Date.now()) {
            return this.cachedRoute.value;
        }
        try {
            let interfaceName = DIRECT_INTERFACE;
            let gateway = DIRECT_GATEWAY;
            if (!interfaceName || !gateway) {
                const output = await runCommand('/usr/sbin/netstat', ['-rn', '-f', 'inet']);
                const detected = parsePhysicalDefaultRoute(output);
                interfaceName = interfaceName || detected?.interfaceName;
                gateway = gateway || detected?.gateway;
            }
            if (!interfaceName || !gateway || !net.isIPv4(gateway)) {
                throw new Error('No physical IPv4 default route was found');
            }
            const value = { interfaceName, gateway, dnsServer: DIRECT_DNS || gateway };
            this.cachedRoute = { value, expiresAt: Date.now() + ROUTE_CACHE_MS };
            return value;
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : 'Unable to detect the physical host route';
            this.cachedRoute = { expiresAt: Date.now() + ROUTE_CACHE_MS, error: message };
            return;
        }
    }

    private accept(client: net.Socket): void {
        client.setTimeout(INITIAL_REQUEST_TIMEOUT_MS, () => client.destroy());
        let buffered = Buffer.alloc(0);
        const onData = (chunk: Buffer): void => {
            buffered = Buffer.concat([buffered, chunk]);
            if (buffered.length > MAX_HEADER_BYTES) {
                this.failClient(client, 431, 'Request Header Fields Too Large');
                return;
            }
            const end = buffered.indexOf('\r\n\r\n');
            if (end < 0) {
                return;
            }
            client.removeListener('data', onData);
            client.pause();
            const request = parseInitialRequest(buffered.slice(0, end + 4), buffered.slice(end + 4));
            if (!request) {
                this.failClient(client, 400, 'Bad Request');
                return;
            }
            void this.openDirectConnection(client, request);
        };
        client.on('data', onData);
        client.once('error', () => client.destroy());
    }

    private async openDirectConnection(client: net.Socket, request: ParsedRequest): Promise<void> {
        try {
            const route = await this.getPhysicalRoute();
            if (!route) {
                throw new Error(this.getError() || 'Physical route is unavailable');
            }
            const address = await this.resolvePublicIpv4(request.host, route.dnsServer);
            const upstream = spawn(
                '/usr/bin/nc',
                ['-4', '-b', route.interfaceName, '-n', address, request.port.toString()],
                { stdio: ['pipe', 'pipe', 'pipe'] },
            );
            let stderr = '';
            upstream.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
            upstream.once('error', () => client.destroy());
            upstream.stdin.once('error', () => client.destroy());
            upstream.stdout.once('error', () => client.destroy());
            upstream.stderr.once('error', () => client.destroy());
            upstream.once('close', (code) => {
                if (code && !client.destroyed) {
                    console.error(
                        `Host direct connection to ${request.host}:${request.port} failed: ${
                            stderr.trim() || `nc exited with ${code}`
                        }`,
                    );
                }
                client.destroy();
            });
            client.once('close', () => upstream.kill());
            client.setTimeout(0);
            if (request.connect) {
                client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: ws-scrcpy\r\n\r\n');
            }
            if (request.initialPayload.length) {
                upstream.stdin.write(request.initialPayload);
            }
            client.pipe(upstream.stdin);
            upstream.stdout.pipe(client);
            client.resume();
        } catch (error: unknown) {
            console.error(
                `Host direct relay rejected ${request.host}:${request.port}: ${
                    error instanceof Error ? error.message : 'unknown error'
                }`,
            );
            this.failClient(client, 502, 'Bad Gateway');
        }
    }

    private resolvePublicIpv4(host: string, dnsServer: string): Promise<string> {
        if (net.isIP(host)) {
            return isPublicIpv4(host)
                ? Promise.resolve(host)
                : Promise.reject(new Error('Private targets are blocked'));
        }
        const cacheKey = `${dnsServer}|${host}`;
        const cached = this.dnsCache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) {
            return Promise.resolve(cached.address);
        }
        const resolver = new dns.Resolver();
        resolver.setServers([dnsServer]);
        return new Promise((resolve, reject) => {
            resolver.resolve4(host, (error, addresses) => {
                if (error) {
                    reject(error);
                    return;
                }
                const address = addresses.find(isPublicIpv4);
                if (address) {
                    this.dnsCache.set(cacheKey, { address, expiresAt: Date.now() + 60_000 });
                    resolve(address);
                } else {
                    reject(new Error('DNS did not return a public IPv4 address'));
                }
            });
        });
    }

    private failClient(client: net.Socket, status: number, message: string): void {
        if (!client.destroyed) {
            client.end(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
        }
    }
}
