(function () {
    'use strict';
    function start() {
        var state = window.WSSilkPulse;
        var output = document.getElementById('silkpulse-result');
        document.getElementById('silkpulse-status').textContent = state ?
            'SDK 状态：' + state.state + '；调试：' + (state.enabled ? '开启' : '关闭') : '调试引导未加载，页面仍可使用。';
        document.getElementById('silkpulse-disable').onclick = function () { if (state) state.disable(); };
        document.getElementById('silkpulse-run').onclick = function () {
            var marker = 'silkpulse-check-' + Date.now();
            output.textContent = marker + '\n正在验证采集。';
            console.info('[SilkPulse verification]', marker);
            var request = new URL('./iphone-touch.html', location.href);
            request.searchParams.set('silkpulseProbe', marker);
            fetch(request.href, { cache: 'no-store' }).then(function (response) {
                output.textContent = marker + '\n只读请求 HTTP ' + response.status + '\n测试错误已触发，请在项目 errors 中核对。';
                setTimeout(function () { throw new Error('[SilkPulse verification] ' + marker); }, 0);
            }).catch(function () { output.textContent = marker + '\n只读请求失败，请查看 network。'; });
        };
    }
    Promise.resolve(window.__WS_SILKPULSE_READY__).then(start, start);
})();
