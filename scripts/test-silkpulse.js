const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const template = fs.readFileSync('src/public/silkpulse-bootstrap.js', 'utf8');

function boot({ query = '', hash = '#!action=stream&udid=emulator-5554&player=mse', session, blockedStorage = false,
    allowDevice = false, streamEnabledByDefault = false } = {}) {
    const scripts = [];
    const timers = [];
    const attrs = {};
    const storage = new Map(session ? [['ws-scrcpy:silkpulse-session', JSON.stringify(session)]] : []);
    const config = { server: 'https://debug.foxhello.com', projectId: 'test-project', deviceToken: 'test-device-token',
        environment: 'production', tags: ['cloudphone-h5'], testDeviceIds: allowDevice ? ['test-device'] : [],
        sessionMinutes: 30, streamEnabledByDefault };
    const context = vm.createContext({ URL, URLSearchParams, Promise, Date, Math,
        window: {}, location: { href: 'http://localhost:8000/' + query + hash },
        history: { state: null, replaceState(_s, _t, url) { context.location.href = url; } },
        localStorage: { getItem() { if (blockedStorage) throw Error('blocked'); return 'test-device'; } },
        sessionStorage: { getItem(key) { if (blockedStorage) throw Error('blocked'); return storage.get(key); },
            setItem(key, value) { if (blockedStorage) throw Error('blocked'); storage.set(key, value); } },
        setTimeout(fn) { timers.push(fn); return timers.length; }, clearTimeout() {},
        document: { readyState: 'complete', createElement() { return { setAttribute(key, value) { attrs[key] = value; } }; },
            head: { appendChild(script) { scripts.push(script); } } }
    });
    const source = template.replace('__SILKPULSE_PUBLIC_CONFIG__', JSON.stringify(config));
    vm.runInContext(source, context);
    return { context, scripts, timers, attrs, source, status: context.window.WSSilkPulse };
}

(async () => {
    const off = boot();
    await off.status.ready;
    assert.strictEqual(off.scripts.length, 0, 'production must not load the SDK by default');
    const on = boot({ query: '?silkpulse=1' });
    assert.strictEqual(on.scripts.length, 1);
    assert.strictEqual(on.attrs['data-project-id'], 'test-project');
    assert.strictEqual(on.attrs['data-device-token'], 'test-device-token');
    assert.strictEqual(on.attrs['data-server'], 'https://debug.foxhello.com');
    assert(on.attrs['data-tags'].includes('production'));
    assert(on.attrs['data-tags'].includes('udid-emulator-5554'));
    assert(on.attrs['data-tags'].includes('player-mse'));
    assert.strictEqual(on.status.streamDevice, 'emulator-5554');
    assert.strictEqual(on.status.streamPlayer, 'mse');
    assert(!on.context.location.href.includes('silkpulse=1'), 'consume the switch while preserving SPA routing');
    assert(on.context.location.href.endsWith('#!action=stream&udid=emulator-5554&player=mse'));
    vm.runInContext(on.source, on.context);
    assert.strictEqual(on.scripts.length, 1, 'SPA/bootstrap repetition must not duplicate SDK initialization');
    on.scripts[0].onload();
    await on.status.ready;
    assert.strictEqual(on.status.state, 'loaded');
    const failed = boot({ query: '?silkpulse=1' });
    failed.scripts[0].onerror();
    await failed.status.ready;
    assert.strictEqual(failed.status.state, 'failed');
    const timeout = boot({ query: '?silkpulse=1' });
    timeout.timers[0]();
    await timeout.status.ready;
    assert.strictEqual(timeout.status.state, 'timeout', 'a hanging SDK must release business startup');
    assert.strictEqual(boot({ allowDevice: true }).scripts.length, 1);
    assert.strictEqual(boot({ streamEnabledByDefault: true }).scripts.length, 1,
        'configured stream pages must load diagnostics without a per-browser allow-list');
    assert.strictEqual(boot({ hash: '#!action=list', streamEnabledByDefault: true }).scripts.length, 0,
        'default stream diagnostics must not enable unrelated pages');
    assert.strictEqual(boot({ query: '?silkpulse=0', allowDevice: true }).scripts.length, 0, 'off takes precedence');
    assert.strictEqual(boot({ query: '?silkpulse=0', streamEnabledByDefault: true }).scripts.length, 0,
        'an explicit opt-out must override stream defaults');
    assert.strictEqual(boot({ session: { enabled: true, expiresAt: Date.now() - 1000 } }).scripts.length, 0);
    assert.strictEqual(boot({ blockedStorage: true }).scripts.length, 0);
    assert.strictEqual(boot({ query: '?silkpulse=1', blockedStorage: true }).scripts.length, 1);
    console.log('SilkPulse: default-off, session/device gating, SPA deduplication, routing, blocked storage, load failure and timeout pass.');
})().catch(error => { console.error(error); process.exitCode = 1; });
