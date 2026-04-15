(function () {
    var q = new URLSearchParams(window.location.search);
    if (q.get('dev') !== '1') return;
    window.__DEV_PREVIEW__ = true;
    if (!localStorage.getItem('jwtToken')) {
        localStorage.setItem('jwtToken', 'dev-preview-token');
    }
    var p = (window.location.pathname || '').toLowerCase();
    localStorage.setItem('userRole', 'police');

    var orig = window.fetch.bind(window);
    window.fetch = function (input, init) {
        var url = typeof input === 'string' ? input : (input && input.url) || '';
        if (url.indexOf('/api/police/alerts') >= 0) {
            return Promise.resolve(new Response(JSON.stringify([
                { location: [29.57, 106.56], description: '渝A×××追尾（模拟）', level: '高' },
                { location: [29.55, 106.52], description: '侧翻占道', level: '中' }
            ]), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (url.indexOf('/api/vehicle/request-greenwave') >= 0) {
            return Promise.resolve(new Response(JSON.stringify({
                vehicleId: '渝A-88G12',
                nextLightStatus: '绿灯',
                eta: '约 6 分钟',
                route: [[29.56, 106.55], [29.565, 106.555], [29.57, 106.56]]
            }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        if (url.indexOf('/api/gov/') >= 0) {
            return Promise.resolve(new Response(JSON.stringify({ congestionIndex: 1.9, ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
        }
        // 不拦截 /api/route/driving：真实贴路轨迹必须走后端 + 本机 OSRM（否则会永远直线）
        return orig(input, init);
    };
})();
