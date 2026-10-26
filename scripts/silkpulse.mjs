#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const env = { ...process.env };
if (!env.SILKPULSE_API_KEY) {
    const file = env.SILKPULSE_PRIVATE_CONFIG || resolve(homedir(), '.config/silkpulse/ws-scrcpy.json');
    try {
        if (process.platform !== 'win32' && (statSync(file).mode & 0o077)) {
            throw new Error('Private configuration must have mode 0600.');
        }
        const config = JSON.parse(readFileSync(file, 'utf8'));
        env.SILKPULSE_API_KEY = config.SILKPULSE_API_KEY;
        env.SILKPULSE_SERVER ||= config.SILKPULSE_SERVER;
    } catch {
        console.error('Cannot load private SilkPulse configuration. Set SILKPULSE_API_KEY or provide a mode-0600 SILKPULSE_PRIVATE_CONFIG file.');
        process.exit(1);
    }
}
if (!env.SILKPULSE_API_KEY) {
    console.error('A project API key is required. Never pass an administrator key to this wrapper.');
    process.exit(1);
}
env.SILKPULSE_SERVER ||= 'https://debug.foxhello.com';
const cli = fileURLToPath(new URL('../tools/skill/scripts/silkpulse.mjs', import.meta.url));
const child = spawn(process.execPath, [cli, ...process.argv.slice(2)], { env, stdio: 'inherit' });
child.on('error', () => { console.error('Cannot start the official SilkPulse CLI.'); process.exitCode = 1; });
child.on('exit', (code) => { process.exitCode = code ?? 1; });
