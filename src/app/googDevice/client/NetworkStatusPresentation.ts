import { NetworkRouteKind, NetworkRouteStatus } from '../../../types/NetworkRouteStatus';

export type NetworkStatusTone = 'safe' | 'warning' | 'danger';

export type NetworkStatusFailure = {
    headline: string;
    details: string;
};

const ROUTE_LABELS: Record<NetworkRouteKind, string> = {
    'host-vpn': '宿主 VPN',
    'device-vpn': '手机 VPN',
    'host-direct': '宿主直连',
    unknown: '路径未知',
};

function locationOf(status: { country?: string; region?: string; city?: string }): string {
    return [status.country, status.region, status.city].filter(Boolean).join(' / ') || '地区未知';
}

function checkedTime(timestamp?: number): string {
    return timestamp ? new Date(timestamp).toLocaleTimeString() : '未知';
}

export function routeLabel(status: NetworkRouteStatus): string {
    const suffix =
        status.confidence === 'verified' ? '（已验证）' : status.confidence === 'partial' ? '（部分验证）' : '';
    return `${ROUTE_LABELS[status.route]}${suffix}`;
}

export function statusTone(status: NetworkRouteStatus): NetworkStatusTone {
    const blockingGuard = status.protection.guardEngaged && status.protection.guardMode !== 'proxy-only';
    if (status.protection.drifted || blockingGuard || !status.ip) {
        return 'danger';
    }
    if (status.protection.warning === 'domestic-host-direct-ip-change') {
        return 'warning';
    }
    if (
        status.protection.guardMode === 'proxy-only' &&
        status.protection.guardStatus &&
        status.protection.guardStatus !== 'active'
    ) {
        return 'warning';
    }
    if (status.route === 'device-vpn' && !status.androidVpn.lockdown) {
        return 'warning';
    }
    if (status.confidence !== 'verified' || status.route === 'unknown') {
        return 'warning';
    }
    if (
        status.route === 'host-direct' &&
        (!status.protection.enabled ||
            status.protection.expectedRoute !== 'host-direct' ||
            status.protection.guardMode !== 'proxy-only')
    ) {
        return 'warning';
    }
    return 'safe';
}

export function statusHeadline(status: NetworkRouteStatus): string {
    return status.ip ? `实际出口 IP：${status.ip}` : '实际出口 IP：检测失败';
}

export function statusVerification(status: NetworkRouteStatus): string {
    if (!status.ip) {
        return '验证结果：未取得云手机内部实测出口 IP';
    }
    if (status.route === 'host-vpn') {
        return status.confidence === 'verified'
            ? '验证结果：云手机出口与宿主 VPN 出口一致'
            : '验证结果：仅确认代理出口一致，尚未验证所有 App 都经过宿主 VPN';
    }
    if (status.route === 'device-vpn') {
        return status.confidence === 'verified'
            ? '验证结果：手机全局 VPN 已接管，出口 IP 已在云手机内部实测'
            : '验证结果：检测到手机 VPN，但它不是全局默认网络';
    }
    if (status.route === 'host-direct') {
        if (
            status.protection.enabled &&
            status.protection.guardMode === 'proxy-only' &&
            status.protection.guardStatus === 'active'
        ) {
            return status.hostVpn.active
                ? '验证结果：宿主 VPN 已开启，但云手机经物理网络直连，未使用该 VPN'
                : '验证结果：云手机经宿主物理网络直连，且防 VPN 泄漏规则已生效';
        }
        return '验证结果：云手机出口与宿主物理直连出口一致，但尚未启用防泄漏锁定';
    }
    return '验证结果：云手机出口与已知宿主/手机路径均不匹配';
}

export function hostVpnActionLabel(status: NetworkRouteStatus): string {
    if (status.protection.drifted && status.protection.expectedRoute === 'host-vpn') {
        return '确认并锁定宿主新节点';
    }
    if (status.route === 'host-vpn' && status.protection.enabled) {
        return '重新验证并锁定宿主 VPN';
    }
    return '使用宿主 VPN（验证并锁定）';
}

export function hostDirectActionLabel(status: NetworkRouteStatus): string {
    if (status.protection.drifted && status.protection.expectedRoute === 'host-direct') {
        return '确认并锁定新的宿主直连 IP';
    }
    if (status.route === 'host-direct' && status.protection.enabled) {
        return '重新验证并锁定宿主直连';
    }
    return '不用宿主 VPN（验证并锁定）';
}

export function deviceVpnActionLabel(status: NetworkRouteStatus): string {
    if (status.route === 'device-vpn' && status.protection.enabled) {
        return '重新验证并锁定手机 VPN';
    }
    return '使用手机 VPN（验证并锁定）';
}

export function hostVpnTrackingMessage(status: NetworkRouteStatus): string {
    if (status.protection.drifted && status.protection.expectedRoute === 'host-vpn') {
        return '已检测到宿主节点或云手机出口变化，业务 App 已停止并拦截网络；点击上面的宿主 VPN 按钮确认新节点。';
    }
    if (status.protection.drifted && status.protection.expectedRoute === 'host-direct') {
        return '已检测到宿主物理出口、直连中继或云手机路径变化，业务 App 已停止并断网；请重新确认宿主直连。';
    }
    if (
        status.protection.warning === 'domestic-host-direct-ip-change' &&
        status.route === 'host-direct' &&
        status.protection.message
    ) {
        return status.protection.message;
    }
    if (status.route === 'device-vpn') {
        return '当前使用手机 VPN，与宿主 VPN 隔离；宿主切换节点不会改变云手机出口。';
    }
    if (status.route === 'host-direct') {
        return status.protection.enabled &&
            status.protection.expectedRoute === 'host-direct' &&
            status.protection.guardMode === 'proxy-only' &&
            status.protection.guardStatus === 'active'
            ? `云手机已固定使用宿主物理网络（${status.ip || 'IP 未知'}），宿主 VPN 切换节点不会改变该出口。`
            : '当前出口匹配宿主物理网络，但防泄漏规则尚未确认；系统会自动复查或恢复。';
    }
    if (!status.hostVpn.active) {
        return '未检测到宿主 VPN；打开宿主 VPN 后，点击上面的宿主 VPN 按钮进行验证。';
    }
    if (status.protection.enabled && status.protection.expectedRoute === 'host-vpn') {
        return '每 15 秒自动检测宿主节点和云手机出口；发生变化时会先停止业务 App 并拦截网络。';
    }
    const latestHostChange = status.recentChanges.find((change) => change.scope === 'host-vpn');
    if (latestHostChange) {
        return `已检测到宿主节点变化：${latestHostChange.fromIp || '无'} → ${
            latestHostChange.toIp || '无'
        }；点击上面的宿主 VPN 按钮验证并锁定。`;
    }
    return '点击上面的宿主 VPN 按钮锁定后，将每 15 秒自动检测节点变化并防止 IP 漂移。';
}

export function networkStatusFailure(httpStatus?: number, output?: string): NetworkStatusFailure {
    if (httpStatus === 404 && !output) {
        return {
            headline: '网络状态接口不存在（HTTP 404）',
            details: '页面与服务端版本不一致，当前 IP 未验证。修复前请勿打开业务 App。',
        };
    }
    const suffix = httpStatus ? `（HTTP ${httpStatus}）` : '';
    return {
        headline: `实际出口 IP：检测失败${suffix}`,
        details: output || '无法读取网络状态，当前 IP 未验证。请勿打开业务 App。',
    };
}

export function statusSummary(status: NetworkRouteStatus): string {
    return `${status.ip || 'IP 未知'} | ${routeLabel(status)} | ${locationOf(status)}`;
}

export function statusDetails(status: NetworkRouteStatus): string[] {
    const androidProxy =
        status.androidProxy && status.androidProxy !== ':0'
            ? `Android HTTP 代理：${status.androidProxy}`
            : 'Android HTTP 代理：关闭';
    const androidVpn = status.androidVpn.active
        ? `手机 VPN：运行中${status.androidVpn.packageName ? `（${status.androidVpn.packageName}）` : ''}${
              status.androidVpn.isDefault ? '，全局默认网络' : '，分应用/非默认网络'
          }${status.androidVpn.lockdown ? '，Lockdown 已启用' : '，Lockdown 未启用'}`
        : `手机 VPN：未运行${
              status.androidVpn.alwaysOnPackage ? `（Always-on：${status.androidVpn.alwaysOnPackage}）` : ''
          }`;
    const hostDefault = status.hostDefault.ip
        ? `宿主当前默认出口：${status.hostDefault.ip}（${locationOf(status.hostDefault)}）`
        : `宿主当前默认出口：检测失败（${status.hostDefault.error || '未知错误'}）`;
    const hostDirect = status.hostDirect.available
        ? `宿主物理直连出口：${status.hostDirect.ip || '检测失败'}（${locationOf(status.hostDirect)}）；${
              status.hostDirect.interfaceName || '未知网卡'
          } → ${status.hostDirect.gateway || '未知网关'}`
        : `宿主物理直连出口：不可用（${status.hostDirect.error || '直连中继未就绪'}）`;
    const hostVpn = status.hostVpn.active
        ? `宿主 VPN：已开启；出口 ${status.hostVpn.ip || '检测失败'}（${locationOf(status.hostVpn)}）`
        : `宿主 VPN：未检测到${status.hostVpn.error ? `（${status.hostVpn.error}）` : ''}`;
    const guardExpected =
        status.protection.guardMode === 'proxy-only' || status.protection.drifted || status.protection.guardEngaged;
    const guardStatus = guardExpected
        ? status.protection.guardStatus === 'active'
            ? '防泄漏规则：正常'
            : status.protection.guardStatus === 'missing'
            ? '防泄漏规则：缺失，正在自动恢复'
            : status.protection.guardStatus === 'unavailable'
            ? `防泄漏规则：读取失败（${status.protection.guardError || '等待复查'}）`
            : ''
        : '';
    let protection = 'IP 防漂移：未锁定';
    if (status.protection.enabled) {
        const proxyGuardDetail =
            status.protection.guardMode === 'proxy-only'
                ? status.protection.guardStatus === 'active'
                    ? '；仅允许通过宿主直连中继联网'
                    : '；防泄漏规则待确认'
                : '';
        protection = status.protection.drifted
            ? `IP 防漂移：已触发；期望 ${status.protection.expectedIp || '未知'} / ${
                  status.protection.expectedRoute ? ROUTE_LABELS[status.protection.expectedRoute] : '路径未知'
              }；应用已停止${status.protection.guardEngaged ? '且网络已拦截' : ''}`
            : `IP 防漂移：已锁定 ${status.protection.expectedIp || '未知'} / ${
                  status.protection.expectedRoute ? ROUTE_LABELS[status.protection.expectedRoute] : '路径未知'
              }${proxyGuardDetail}`;
    }
    const latestChange = status.recentChanges[0];
    const change = latestChange
        ? `${latestChange.scope === 'host-vpn' ? '宿主 VPN 节点' : '云手机出口'}最近变化：${
              latestChange.fromIp || '无'
          } → ${latestChange.toIp || '无'}（${checkedTime(latestChange.changedAt)}）`
        : '最近变化：本次服务启动后未检测到';
    return [
        `当前路径：${routeLabel(status)}`,
        statusVerification(status),
        `云手机地区：${locationOf(status)}`,
        androidProxy,
        androidVpn,
        hostDefault,
        hostDirect,
        hostVpn,
        guardStatus,
        protection,
        status.protection.message ? `保护说明：${status.protection.message}` : '',
        change,
        `检测时间：${checkedTime(status.checkedAt)}`,
        status.error ? `检测错误：${status.error}` : '',
    ].filter(Boolean);
}
