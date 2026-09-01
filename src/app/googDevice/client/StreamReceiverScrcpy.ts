import { StreamReceiver } from '../../client/StreamReceiver';
import { ParamsStreamScrcpy } from '../../../types/ParamsStreamScrcpy';
import { ACTION } from '../../../common/Action';
import { SERVER_PORT } from '../../../common/Constants';
import Util from '../../Util';

export class StreamReceiverScrcpy extends StreamReceiver<ParamsStreamScrcpy> {
    public static parseParameters(params: URLSearchParams): ParamsStreamScrcpy {
        const typedParams = super.parseParameters(params);
        const { action } = typedParams;
        if (action !== ACTION.STREAM_SCRCPY) {
            throw Error('Incorrect action');
        }
        return {
            ...typedParams,
            action,
            udid: Util.parseString(params, 'udid', true),
            ws: Util.parseString(params, 'ws'),
            player: Util.parseString(params, 'player', true),
        };
    }
    public static buildSameOriginWebSocketUrl(udid: string): URL {
        const url = new URL(window.location.href);
        url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        url.hash = '';
        url.search = '';
        url.searchParams.set('action', ACTION.PROXY_ADB);
        url.searchParams.set('remote', `tcp:${SERVER_PORT}`);
        url.searchParams.set('udid', udid);
        return url;
    }

    public static isSameOriginProxyUrl(value: string, udid: string): boolean {
        try {
            return new URL(value).toString() === StreamReceiverScrcpy.buildSameOriginWebSocketUrl(udid).toString();
        } catch (_error) {
            return false;
        }
    }

    protected buildDirectWebSocketUrl(): URL {
        const { udid, ws } = this.params as ParamsStreamScrcpy;
        return ws ? new URL(ws) : StreamReceiverScrcpy.buildSameOriginWebSocketUrl(udid);
    }
}
