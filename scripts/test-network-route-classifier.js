#!/usr/bin/env node

require('ts-node/register/transpile-only');
const assert = require('assert');
const { classifyNetworkRoute } = require('../src/server/goog-device/services/NetworkRouteClassifier');

const now = Date.now();
const noAndroidVpn = { active: false, isDefault: false, lockdown: false };

function hostVpn(overrides = {}) {
    return {
        active: true,
        proxyReachable: true,
        deviceProxy: '10.0.2.2:7898',
        defaultInterface: 'utun4',
        tunnelActive: true,
        systemProxy: { enabled: true, host: '127.0.0.1', port: 7897 },
        evidence: [],
        ip: '203.0.113.20',
        checkedAt: now,
        ...overrides,
    };
}

function classify(overrides = {}) {
    return classifyNetworkRoute({
        actualIp: '203.0.113.20',
        androidProxy: ':0',
        androidVpn: noAndroidVpn,
        hostDefault: { ip: '198.51.100.10', checkedAt: now },
        hostVpn: hostVpn(),
        ...overrides,
    });
}

assert.deepStrictEqual(classify().route, 'host-vpn', 'matching active host VPN must be identified');

assert.deepStrictEqual(
    classify({
        actualIp: '203.0.113.30',
        androidVpn: {
            active: true,
            isDefault: true,
            packageName: 'com.example.vpn',
            lockdown: true,
        },
    }),
    {
        route: 'device-vpn',
        confidence: 'verified',
        reason: 'Android default network is a VPN and the exit IP was measured inside the emulator',
    },
    'a full-device Android VPN must take precedence over the host route',
);

assert.strictEqual(
    classify({
        androidVpn: { active: true, isDefault: false, packageName: 'com.example.vpn', lockdown: false },
    }).confidence,
    'partial',
    'an app-scoped Android VPN must not be reported as fully verified',
);

assert.strictEqual(
    classify({
        actualIp: '203.0.113.20',
        hostDefault: { ip: '203.0.113.20', checkedAt: now },
        hostVpn: hostVpn({ ip: '203.0.113.20', proxyReachable: false }),
    }).route,
    'host-vpn',
    'a host default route through utun must remain a host VPN even when both exits match',
);

assert.strictEqual(
    classify({
        hostVpn: hostVpn({ tunnelActive: false, defaultInterface: 'en0' }),
    }).confidence,
    'partial',
    'an HTTP-proxy-only match must not claim that every app is protected',
);

assert.strictEqual(
    classify({
        actualIp: '198.51.100.10',
        hostVpn: hostVpn({ active: false, ip: undefined, tunnelActive: false, systemProxy: { enabled: false } }),
    }).route,
    'host-direct',
    'matching host default without VPN evidence must be direct',
);

assert.strictEqual(
    classify({ actualIp: '192.0.2.44', androidProxy: '10.0.2.2:9000' }).route,
    'unknown',
    'an unmatched proxy exit must not be labeled as a host VPN',
);

console.log('network route classifier tests passed');
