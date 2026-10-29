#!/usr/bin/env node

require('ts-node/register/transpile-only');
const assert = require('assert');
const {
    evaluateNetworkProtection,
} = require('../src/server/goog-device/services/NetworkProtectionDecision');

function evaluate(overrides = {}) {
    return evaluateNetworkProtection({
        expectedIp: '198.51.100.10',
        expectedRoute: 'host-direct',
        actualIp: '198.51.100.10',
        actualCountryCode: 'CN',
        actualRoute: 'host-direct',
        routeConfidence: 'verified',
        alreadyDrifted: false,
        allowedProxy: '10.0.2.2:7899',
        guardStatus: 'active',
        guardEnabled: true,
        guardAllowedProxy: '10.0.2.2:7899',
        ...overrides,
    });
}

assert.strictEqual(evaluate().confirmedDrift, false, 'the expected verified route must remain healthy');

const domesticDirectIpChange = evaluate({ actualIp: '198.51.100.11' });
assert.strictEqual(
    domesticDirectIpChange.domesticHostDirectIpChange,
    true,
    'a verified domestic host-direct IP rotation must be recognized',
);
assert.strictEqual(
    domesticDirectIpChange.confirmedDrift,
    false,
    'a verified domestic host-direct IP rotation must not become blocking drift',
);
assert.strictEqual(
    domesticDirectIpChange.shouldStopApps,
    false,
    'a verified domestic host-direct IP rotation must not stop apps',
);

const foreignDirectIpChange = evaluate({ actualIp: '203.0.113.20', actualCountryCode: 'US' });
assert.strictEqual(foreignDirectIpChange.confirmedDrift, true, 'a foreign host-direct IP change must remain drift');
assert.strictEqual(foreignDirectIpChange.shouldStopApps, true, 'a foreign host-direct IP change must stop apps');

const unlocatedDirectIpChange = evaluate({ actualIp: '203.0.113.20', actualCountryCode: undefined });
assert.strictEqual(
    unlocatedDirectIpChange.confirmedDrift,
    true,
    'a host-direct IP change without verified domestic location must remain drift',
);

const hostVpnPathChange = evaluate({
    actualIp: '203.0.113.20',
    actualCountryCode: 'CN',
    actualRoute: 'host-vpn',
});
assert.strictEqual(hostVpnPathChange.confirmedDrift, true, 'switching to the host VPN must remain drift');
assert.strictEqual(hostVpnPathChange.shouldStopApps, true, 'switching to the host VPN must stop apps');

const deviceVpnPathChange = evaluate({
    actualIp: '203.0.113.20',
    actualCountryCode: 'CN',
    actualRoute: 'device-vpn',
});
assert.strictEqual(deviceVpnPathChange.confirmedDrift, true, 'switching to a device VPN must remain drift');
assert.strictEqual(deviceVpnPathChange.shouldStopApps, true, 'switching to a device VPN must stop apps');

const unreadableGuard = evaluate({
    guardStatus: 'unavailable',
    guardEnabled: false,
    guardAllowedProxy: undefined,
});
assert.strictEqual(unreadableGuard.guardReadFailed, true, 'a failed guard read must be represented explicitly');
assert.strictEqual(unreadableGuard.confirmedDrift, false, 'a failed guard read must not become route drift');
assert.strictEqual(unreadableGuard.shouldStopApps, false, 'a failed guard read must not stop apps');
assert.strictEqual(unreadableGuard.shouldRepairProxyGuard, false, 'an unreadable guard must not be overwritten');

const changedIpWithUnreadableGuard = evaluate({
    actualIp: '203.0.113.20',
    actualRoute: 'unknown',
    routeConfidence: 'unknown',
    guardStatus: 'unavailable',
    guardEnabled: false,
    guardAllowedProxy: undefined,
});
assert.strictEqual(
    changedIpWithUnreadableGuard.shouldStopApps,
    true,
    'an independently measured IP drift must still engage protection when the guard read fails',
);

const missingGuard = evaluate({ guardStatus: 'missing', guardEnabled: false, guardAllowedProxy: undefined });
assert.strictEqual(missingGuard.confirmedDrift, false, 'a missing guard is not actual egress drift');
assert.strictEqual(missingGuard.shouldStopApps, false, 'a missing guard must not stop apps while egress is correct');
assert.strictEqual(missingGuard.shouldRepairProxyGuard, true, 'a confirmed missing guard should be repaired');

const unknownRoute = evaluate({ actualRoute: 'unknown', routeConfidence: 'unknown' });
assert.strictEqual(unknownRoute.confirmedDrift, false, 'a transient unknown route must not be treated as drift');
assert.strictEqual(unknownRoute.shouldStopApps, false, 'a transient unknown route must not stop apps');

const missingIp = evaluate({ actualIp: undefined, actualRoute: 'unknown', routeConfidence: 'unknown' });
assert.strictEqual(missingIp.confirmedDrift, false, 'a failed IP probe must not be treated as drift');
assert.strictEqual(missingIp.shouldStopApps, false, 'a failed IP probe must not stop apps');

const changedIp = evaluate({ actualIp: '203.0.113.20', actualRoute: 'unknown', routeConfidence: 'unknown' });
assert.strictEqual(changedIp.confirmedDrift, true, 'a measured IP change must be confirmed drift');
assert.strictEqual(changedIp.shouldStopApps, true, 'the first confirmed IP drift must stop apps');

const changedRoute = evaluate({ actualRoute: 'host-vpn', routeConfidence: 'verified' });
assert.strictEqual(changedRoute.confirmedDrift, true, 'a verified route change must be confirmed drift');
assert.strictEqual(changedRoute.shouldStopApps, true, 'the first verified route change must stop apps');

const partialRoute = evaluate({ actualRoute: 'host-vpn', routeConfidence: 'partial' });
assert.strictEqual(partialRoute.confirmedDrift, false, 'a partially verified route must not trigger protection');
assert.strictEqual(partialRoute.shouldStopApps, false, 'a partially verified route must not stop apps');

const repeatedDrift = evaluate({
    actualIp: '203.0.113.20',
    actualRoute: 'unknown',
    routeConfidence: 'unknown',
    alreadyDrifted: true,
});
assert.strictEqual(repeatedDrift.confirmedDrift, true, 'the persisted drift must remain visible');
assert.strictEqual(repeatedDrift.shouldStopApps, false, 'an existing drift must never repeatedly stop apps');

const recoverOldFalsePositive = evaluate({
    alreadyDrifted: true,
    guardStatus: 'active',
    guardEnabled: true,
    guardAllowedProxy: undefined,
});
assert.strictEqual(recoverOldFalsePositive.expectedPathVerified, true, 'the expected route must be verified');
assert.strictEqual(
    recoverOldFalsePositive.shouldRepairProxyGuard,
    true,
    'a stale false-positive state must repair the proxy guard without stopping apps',
);

console.log('network protection decision tests passed');
