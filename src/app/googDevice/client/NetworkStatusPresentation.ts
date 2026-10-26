import { NetworkRouteKind, NetworkRouteStatus } from '../../../types/NetworkRouteStatus';

export type NetworkStatusTone = 'safe' | 'warning' | 'danger';

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
    if (status.protection.drifted || status.protection.guardEngaged || !status.ip) {
        return 'danger';
    }
    if (status.route === 'device-vpn' && !status.androidVpn.lockdown) {
        return 'warning';
    }
    if (status.confidence !== 'verified' || status.route === 'host-direct' || status.route === 'unknown') {
        return 'warning';
    }
    return 'safe';
}

export function statusHeadline(status: NetworkRouteStatus): string {
    return status.ip ? `实际出口 IP：${status.ip}` : '实际出口 IP：检测失败';
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
        ? `宿主默认出口：${status.hostDefault.ip}（${locationOf(status.hostDefault)}）`
        : `宿主默认出口：检测失败（${status.hostDefault.error || '未知错误'}）`;
    const hostVpn = status.hostVpn.active
        ? `宿主 VPN：已开启；出口 ${status.hostVpn.ip || '检测失败'}（${locationOf(status.hostVpn)}）`
        : `宿主 VPN：未检测到${status.hostVpn.error ? `（${status.hostVpn.error}）` : ''}`;
    let protection = 'IP 防漂移：未锁定';
    if (status.protection.enabled) {
        protection = status.protection.drifted
            ? `IP 防漂移：已触发；期望 ${status.protection.expectedIp || '未知'} / ${
                  status.protection.expectedRoute ? ROUTE_LABELS[status.protection.expectedRoute] : '路径未知'
              }；应用已停止${status.protection.guardEngaged ? '且网络已拦截' : ''}`
            : `IP 防漂移：已锁定 ${status.protection.expectedIp || '未知'} / ${
                  status.protection.expectedRoute ? ROUTE_LABELS[status.protection.expectedRoute] : '路径未知'
              }`;
    }
    const latestChange = status.recentChanges[0];
    const change = latestChange
        ? `${latestChange.scope === 'host-vpn' ? '宿主 VPN 节点' : '云手机出口'}最近变化：${
              latestChange.fromIp || '无'
          } → ${latestChange.toIp || '无'}（${checkedTime(latestChange.changedAt)}）`
        : '最近变化：本次服务启动后未检测到';
    return [
        `当前路径：${routeLabel(status)}`,
        `云手机地区：${locationOf(status)}`,
        androidProxy,
        androidVpn,
        hostDefault,
        hostVpn,
        protection,
        status.protection.message ? `保护说明：${status.protection.message}` : '',
        change,
        `检测时间：${checkedTime(status.checkedAt)}`,
        status.error ? `检测错误：${status.error}` : '',
    ].filter(Boolean);
}
