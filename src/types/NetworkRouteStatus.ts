export type NetworkRouteKind = 'host-vpn' | 'device-vpn' | 'host-direct' | 'unknown';

export type NetworkRouteConfidence = 'verified' | 'partial' | 'unknown';

export type ExternalNetworkStatus = {
    ip?: string;
    country?: string;
    countryCode?: string;
    region?: string;
    city?: string;
    isp?: string;
    checkedAt: number;
    error?: string;
};

export type HostSystemProxyStatus = {
    enabled: boolean;
    host?: string;
    port?: number;
};

export type HostVpnStatus = ExternalNetworkStatus & {
    active: boolean;
    proxyReachable: boolean;
    deviceProxy: string;
    upstreamProxy?: string;
    defaultInterface?: string;
    tunnelActive: boolean;
    systemProxy: HostSystemProxyStatus;
    evidence: string[];
};

export type AndroidVpnStatus = {
    active: boolean;
    isDefault: boolean;
    packageName?: string;
    uid?: number;
    interfaceName?: string;
    alwaysOnPackage?: string;
    lockdown: boolean;
    error?: string;
};

export type NetworkProtectionStatus = {
    enabled: boolean;
    expectedIp?: string;
    expectedRoute?: NetworkRouteKind;
    drifted: boolean;
    guardEngaged: boolean;
    lastChangedAt?: number;
    stoppedPackages?: number;
    message?: string;
};

export type NetworkRouteChange = {
    scope: 'emulator' | 'host-vpn';
    fromIp?: string;
    toIp?: string;
    fromRoute?: NetworkRouteKind;
    toRoute?: NetworkRouteKind;
    changedAt: number;
};

export type NetworkRouteStatus = ExternalNetworkStatus & {
    ipSource: 'emulator-network';
    route: NetworkRouteKind;
    confidence: NetworkRouteConfidence;
    routeReason: string;
    androidProxy: string;
    hostDefault: ExternalNetworkStatus;
    hostVpn: HostVpnStatus;
    androidVpn: AndroidVpnStatus;
    protection: NetworkProtectionStatus;
    changed: boolean;
    hostVpnChanged: boolean;
    recentChanges: NetworkRouteChange[];
};
