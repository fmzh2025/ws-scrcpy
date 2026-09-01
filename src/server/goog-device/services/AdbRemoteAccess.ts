import * as net from 'net';
import * as os from 'os';

export interface AdbRemoteAccessStatus {
    enabled: boolean;
    udid: string;
    host: string;
    port: number;
    targetHost: string;
    targetPort: number;
    connectCommand: string;
    shellCommand: string;
}

const DEFAULT_PORT = 5555;
const TARGET_HOST = '127.0.0.1';

/**
 * Optional TCP access to the emulator ADB endpoint.
 *
 * The emulator itself listens on localhost only. This small, opt-in proxy
 * exposes that endpoint on the machine LAN address without changing the
 * emulator or the shared ADB server configuration.
 */
export class AdbRemoteAccess {
    private static instance?: AdbRemoteAccess;
    private server?: net.Server;
    private readonly sockets = new Set<net.Socket>();
    private enabled = false;
    private udid = '';
    private bindHost = AdbRemoteAccess.resolveBindHost();
    private readonly port = AdbRemoteAccess.resolvePort();

    private constructor() {}

    public static getInstance(): AdbRemoteAccess {
        if (!this.instance) {
            this.instance = new AdbRemoteAccess();
        }
        return this.instance;
    }

    public getStatus(udid: string): AdbRemoteAccessStatus {
        const targetPort = AdbRemoteAccess.getTargetPort(udid);
        const host = this.bindHost;
        return {
            enabled: this.enabled && this.udid === udid,
            udid,
            host,
            port: this.port,
            targetHost: TARGET_HOST,
            targetPort,
            connectCommand: `adb connect ${host}:${this.port}`,
            shellCommand: `adb -s ${host}:${this.port} shell <command>`,
        };
    }

    public async setEnabled(udid: string, enabled: boolean): Promise<AdbRemoteAccessStatus> {
        const targetPort = AdbRemoteAccess.getTargetPort(udid);
        if (!enabled) {
            await this.stop();
            return this.getStatus(udid);
        }
        if (this.enabled && this.udid === udid && this.server) {
            return this.getStatus(udid);
        }
        await this.stop();
        await this.start(udid, targetPort);
        return this.getStatus(udid);
    }

    public release(): void {
        void this.stop();
    }

    private async start(udid: string, targetPort: number): Promise<void> {
        const server = net.createServer((socket) => {
            this.sockets.add(socket);
            socket.setNoDelay(true);
            const target = net.connect(targetPort, TARGET_HOST);
            target.setNoDelay(true);
            socket.pipe(target);
            target.pipe(socket);
            const close = (): void => {
                socket.destroy();
                target.destroy();
                this.sockets.delete(socket);
            };
            socket.once('error', close);
            target.once('error', close);
            socket.once('close', close);
            target.once('close', close);
        });
        await new Promise<void>((resolve, reject) => {
            const onError = (error: Error): void => {
                server.off('listening', onListening);
                reject(error);
            };
            const onListening = (): void => {
                server.off('error', onError);
                resolve();
            };
            server.once('error', onError);
            server.once('listening', onListening);
            server.listen(this.port, this.bindHost);
        });
        this.server = server;
        this.udid = udid;
        this.enabled = true;
        console.log(`[AdbRemoteAccess] listening on ${this.bindHost}:${this.port} -> ${TARGET_HOST}:${targetPort}`);
    }

    private async stop(): Promise<void> {
        this.enabled = false;
        this.udid = '';
        this.sockets.forEach((socket) => socket.destroy());
        this.sockets.clear();
        const server = this.server;
        this.server = undefined;
        if (!server) {
            return;
        }
        await new Promise<void>((resolve) => {
            server.close(() => resolve());
        });
    }

    private static getTargetPort(udid: string): number {
        const match = /^emulator-(\d+)$/.exec(udid);
        if (!match) {
            throw new Error(`ADB remote access only supports emulator-* devices: ${udid}`);
        }
        const consolePort = parseInt(match[1], 10);
        if (!Number.isFinite(consolePort) || consolePort < 1 || consolePort > 65533 || consolePort % 2 !== 0) {
            throw new Error(`Invalid emulator console port in device id: ${udid}`);
        }
        return consolePort + 1;
    }

    private static resolvePort(): number {
        const value = parseInt(process.env.WS_SCRCPY_ADB_PORT || `${DEFAULT_PORT}`, 10);
        return Number.isFinite(value) && value > 0 && value < 65536 ? value : DEFAULT_PORT;
    }

    private static resolveBindHost(): string {
        const configured = process.env.WS_SCRCPY_ADB_BIND;
        if (configured) {
            return configured;
        }
        const interfaces = os.networkInterfaces();
        for (const entries of Object.values(interfaces)) {
            for (const entry of entries || []) {
                if (entry.family === 'IPv4' && !entry.internal) {
                    return entry.address;
                }
            }
        }
        return '127.0.0.1';
    }
}
