import { NetworkGuardReadStatus, NetworkRouteConfidence, NetworkRouteKind } from '../../../types/NetworkRouteStatus';

export type NetworkProtectionDecisionInput = {
    expectedIp?: string;
    expectedRoute?: NetworkRouteKind;
    actualIp?: string;
    actualRoute: NetworkRouteKind;
    routeConfidence: NetworkRouteConfidence;
    alreadyDrifted: boolean;
    allowedProxy?: string;
    guardStatus: NetworkGuardReadStatus;
    guardEnabled: boolean;
    guardAllowedProxy?: string;
};

export type NetworkProtectionDecision = {
    confirmedDrift: boolean;
    ipDrift: boolean;
    routeDrift: boolean;
    expectedPathVerified: boolean;
    probeIncomplete: boolean;
    guardReadFailed: boolean;
    expectsProxyGuard: boolean;
    proxyGuardMismatch: boolean;
    blockingGuardActive: boolean;
    shouldStopApps: boolean;
    shouldRepairProxyGuard: boolean;
};

export function evaluateNetworkProtection(input: NetworkProtectionDecisionInput): NetworkProtectionDecision {
    const ipDrift = !!input.expectedIp && !!input.actualIp && input.actualIp !== input.expectedIp;
    const routeDrift =
        !!input.expectedRoute &&
        input.actualRoute !== 'unknown' &&
        input.routeConfidence === 'verified' &&
        input.actualRoute !== input.expectedRoute;
    const confirmedDrift = ipDrift || routeDrift;
    const expectedPathVerified =
        !!input.expectedIp &&
        !!input.actualIp &&
        input.actualIp === input.expectedIp &&
        !!input.expectedRoute &&
        input.actualRoute === input.expectedRoute &&
        input.routeConfidence === 'verified';
    const guardReadFailed = input.guardStatus === 'unavailable';
    const expectsProxyGuard = input.expectedRoute === 'host-direct' && !!input.allowedProxy;
    const proxyGuardMismatch =
        expectsProxyGuard &&
        !guardReadFailed &&
        (!input.guardEnabled || input.guardAllowedProxy !== input.allowedProxy);
    const blockingGuardActive = input.guardStatus === 'active' && input.guardEnabled && !input.guardAllowedProxy;

    return {
        confirmedDrift,
        ipDrift,
        routeDrift,
        expectedPathVerified,
        probeIncomplete: !input.actualIp || input.actualRoute === 'unknown' || input.routeConfidence !== 'verified',
        guardReadFailed,
        expectsProxyGuard,
        proxyGuardMismatch,
        blockingGuardActive,
        shouldStopApps: confirmedDrift && !input.alreadyDrifted,
        shouldRepairProxyGuard:
            !confirmedDrift &&
            expectsProxyGuard &&
            proxyGuardMismatch &&
            (!input.alreadyDrifted || expectedPathVerified),
    };
}
