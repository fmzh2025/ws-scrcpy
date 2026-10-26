import {
    AndroidVpnStatus,
    ExternalNetworkStatus,
    HostDirectStatus,
    HostVpnStatus,
    NetworkRouteConfidence,
    NetworkRouteKind,
} from '../../../types/NetworkRouteStatus';

export type NetworkRouteClassification = {
    route: NetworkRouteKind;
    confidence: NetworkRouteConfidence;
    reason: string;
};

export type NetworkRouteEvidence = {
    actualIp?: string;
    androidProxy: string;
    androidVpn: AndroidVpnStatus;
    hostDefault: ExternalNetworkStatus;
    hostDirect: HostDirectStatus;
    hostVpn: HostVpnStatus;
};

function sameIp(first?: string, second?: string): boolean {
    return !!first && !!second && first === second;
}

export function classifyNetworkRoute(evidence: NetworkRouteEvidence): NetworkRouteClassification {
    const { actualIp, androidProxy, androidVpn, hostDefault, hostDirect, hostVpn } = evidence;

    if (androidVpn.active && androidVpn.isDefault) {
        return {
            route: 'device-vpn',
            confidence: actualIp ? 'verified' : 'partial',
            reason: actualIp
                ? 'Android default network is a VPN and the exit IP was measured inside the emulator'
                : 'Android default network is a VPN, but its exit IP could not be measured',
        };
    }

    if (androidVpn.active) {
        return {
            route: 'device-vpn',
            confidence: 'partial',
            reason: 'Android has an app-scoped VPN; the shell probe may not use the same per-app route',
        };
    }

    if (hostVpn.active && sameIp(actualIp, hostVpn.ip)) {
        return {
            route: 'host-vpn',
            confidence: hostVpn.tunnelActive ? 'verified' : 'partial',
            reason: hostVpn.tunnelActive
                ? 'The emulator exit IP matches the active host VPN exit IP and the host default route is tunneled'
                : 'The emulator probe matches the host proxy exit, but apps may bypass an HTTP-only proxy',
        };
    }

    if (hostDirect.available && sameIp(actualIp, hostDirect.ip) && !sameIp(actualIp, hostVpn.ip)) {
        return {
            route: 'host-direct',
            confidence: 'verified',
            reason: 'The emulator exit IP matches the host physical-network exit measured through the direct relay',
        };
    }

    if (hostVpn.active && hostVpn.tunnelActive && sameIp(actualIp, hostDefault.ip)) {
        return {
            route: 'host-vpn',
            confidence: 'verified',
            reason: 'The emulator exit matches the host default route, and that route uses a VPN tunnel',
        };
    }

    if (!hostVpn.active && sameIp(actualIp, hostDefault.ip)) {
        return {
            route: 'host-direct',
            confidence: 'verified',
            reason: 'The emulator exit IP matches the host default network and no host VPN route is active',
        };
    }

    if (androidProxy && androidProxy !== ':0') {
        return {
            route: 'unknown',
            confidence: 'unknown',
            reason: 'Android has a proxy configured, but the measured exit does not match a verified host route',
        };
    }

    return {
        route: 'unknown',
        confidence: 'unknown',
        reason: 'The emulator exit IP does not match any verified host or Android VPN route',
    };
}
