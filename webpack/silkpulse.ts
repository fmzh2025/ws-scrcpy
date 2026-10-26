import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import webpack from 'webpack';

export function createSilkPulseAssets(root: string) {
    const configPath = process.env.SILKPULSE_PUBLIC_CONFIG || path.join(root, '.silkpulse.public.local.json');
    const raw = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, 'utf8')) : {};
    const allowed = ['server', 'projectId', 'deviceToken', 'environment', 'tags', 'testDeviceIds', 'sessionMinutes'];
    if (Object.keys(raw).some((key) => !allowed.includes(key))) {
        throw new Error(
            'SilkPulse public configuration contains unsupported fields; never use a private key file here.',
        );
    }
    const server = new URL(raw.server || 'https://debug.foxhello.com');
    if (server.protocol !== 'https:' || server.username || server.password || server.search || server.hash) {
        throw new Error('SilkPulse server must be an HTTPS URL without credentials or query parameters.');
    }
    const strings = (value: unknown): string[] =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 20) : [];
    const config = {
        server: server.toString().replace(/\/$/, ''),
        projectId: typeof raw.projectId === 'string' ? raw.projectId : '',
        deviceToken: typeof raw.deviceToken === 'string' ? raw.deviceToken : '',
        environment: typeof raw.environment === 'string' ? raw.environment : 'production',
        tags: strings(raw.tags),
        testDeviceIds: strings(raw.testDeviceIds),
        sessionMinutes: Math.min(120, Math.max(1, Number(raw.sessionMinutes) || 30)),
    };
    const bootstrap = fs
        .readFileSync(path.join(root, 'src/public/silkpulse-bootstrap.js'), 'utf8')
        .replace('__SILKPULSE_PUBLIC_CONFIG__', JSON.stringify(config));
    const check = fs.readFileSync(path.join(root, 'src/public/silkpulse-check.js'), 'utf8');
    const filename = (name: string, source: string) =>
        `${name}.${crypto.createHash('sha256').update(source).digest('hex').slice(0, 12)}.js`;
    const bootstrapFile = filename('silkpulse-bootstrap', bootstrap);
    const checkFile = filename('silkpulse-check', check);
    const plugin: webpack.WebpackPluginInstance = {
        apply(compiler) {
            compiler.hooks.thisCompilation.tap('SilkPulsePublicAssets', (compilation) => {
                compilation.hooks.processAssets.tap(
                    { name: 'SilkPulsePublicAssets', stage: webpack.Compilation.PROCESS_ASSETS_STAGE_ADDITIONAL },
                    () => {
                        compilation.emitAsset(bootstrapFile, new webpack.sources.RawSource(bootstrap));
                        compilation.emitAsset(checkFile, new webpack.sources.RawSource(check));
                    },
                );
            });
        },
    };
    return { bootstrapFile, checkFile, plugin };
}
