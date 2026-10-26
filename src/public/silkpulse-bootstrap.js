(function () {
    'use strict';
    if (window.WSSilkPulse) return;
    var config = __SILKPULSE_PUBLIC_CONFIG__;
    var sessionKey = 'ws-scrcpy:silkpulse-session';
    var deviceKey = 'ws-scrcpy:silkpulse-test-device';
    var now = Date.now();
    var session = null;
    var deviceId = '';
    var url = new URL(location.href);
    var switchValue = url.searchParams.get('silkpulse');
    try {
        deviceId = localStorage.getItem(deviceKey) || '';
        if (!deviceId) {
            deviceId = 'ws-' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 12);
            localStorage.setItem(deviceKey, deviceId);
        }
        session = JSON.parse(sessionStorage.getItem(sessionKey) || 'null');
    } catch (_) { /* Storage restrictions must not affect the application. */ }
    if (switchValue === '1') session = { enabled: true, expiresAt: now + config.sessionMinutes * 60000 };
    if (switchValue === '0') session = { enabled: false };
    if (switchValue === '1' || switchValue === '0') {
        try { sessionStorage.setItem(sessionKey, JSON.stringify(session)); } catch (_) {}
        url.searchParams.delete('silkpulse');
        try { history.replaceState(history.state, '', url.href); } catch (_) {}
    }
    var enabled = session && session.enabled === false ? false :
        !!(session && session.enabled && session.expiresAt > now) || config.testDeviceIds.indexOf(deviceId) !== -1;
    var finish;
    var ready = new Promise(function (resolve) { finish = resolve; });
    var status = window.WSSilkPulse = {
        enabled: enabled,
        state: enabled ? 'loading' : 'disabled',
        testDeviceId: deviceId,
        ready: ready,
        disable: function () {
            try { sessionStorage.setItem(sessionKey, JSON.stringify({ enabled: false })); } catch (_) {}
            var off = new URL(location.href);
            off.searchParams.set('silkpulse', '0');
            location.replace(off.href);
        }
    };
    window.__WS_SILKPULSE_READY__ = ready;
    if (!enabled) { finish(); return; }
    if (!config.projectId || !config.deviceToken) {
        status.state = 'missing-config';
        finish();
        return;
    }
    var script = document.createElement('script');
    script.id = 'ws-silkpulse-sdk';
    script.src = config.server + '/sdk.js';
    script.async = true;
    script.setAttribute('data-server', config.server);
    script.setAttribute('data-project-id', config.projectId);
    script.setAttribute('data-device-token', config.deviceToken);
    script.setAttribute('data-tags', ['ws-scrcpy', config.environment].concat(config.tags).filter(function (tag, i, all) {
        return all.indexOf(tag) === i;
    }).join(','));
    script.setAttribute('data-floating-ball', '0');
    // The SDK may arrive later. Business startup waits at most 1.5 seconds.
    var timer = setTimeout(function () { status.state = 'timeout'; finish(); }, 1500);
    script.onload = function () {
        clearTimeout(timer);
        status.state = 'loaded';
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', finish, { once: true });
        else finish();
    };
    script.onerror = function () {
        clearTimeout(timer);
        status.state = 'failed';
        finish();
    };
    try { document.head.appendChild(script); }
    catch (_) { clearTimeout(timer); status.state = 'failed'; finish(); }
})();
