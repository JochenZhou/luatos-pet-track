/**
 * app/main.js —— 应用入口：路由 + 启动 + 越界监测
 * 挂载：window.Main
 * 路由：#/home #/pets #/status(/imei) #/debug #/devices #/fence #/track(/imei) #/alerts
 * 未登录（无完整认证缓存）→ 跳 login.html。
 */
(function (global) {
  'use strict';
  var U = global.Utils;
  var CFG = global.CFG;
  var AC = global.AC;
  var MapKit = global.MapKit;
  var Views = global.Views;
  var PetStore = global.PetStore;
  var FenceStore = global.FenceStore;

  var ROUTES = ['home', 'pets', 'status', 'debug', 'devices', 'fence', 'track', 'alerts', 'report'];

  function parseHash() {
    var h = (global.location.hash || '#/home').replace(/^#\/?/, '');
    var parts = h.split('/');
    var route = parts[0] || 'home';
    if (ROUTES.indexOf(route) < 0) route = 'home';
    return { route: route, arg: parts[1] || '' };
  }

  function navigate() {
    if (!AC.isAuthenticated()) {
      AC.redirectToLogin('/' + CFG.APP_PAGE);
      return;
    }
    var p = parseHash();
    Views.clearTimers();
    var root = document.getElementById('view-root') || document.getElementById('app-root');
    if (!root) return;
    // 视图归属守卫：切页前销毁地图（防轨迹窜入围栏等跨页污染）
    MapKit.destroyMap();
    switch (p.route) {
      case 'home': Views.renderHome(); break;
      case 'pets': Views.renderPets(); break;
      case 'status': Views.renderStatus(p.arg); break;
      case 'debug': Views.renderDebug(); break;
      case 'devices': Views.renderDevices(); break;
      case 'fence': Views.renderFence(); break;
      case 'track': Views.renderTrack(p.arg); break;
      case 'alerts': Views.renderAlerts(); break;
      case 'report': Views.renderReport(p.arg); break;
      default: Views.renderHome();
    }
  }

  /**
   * 越界监测：轮询启用围栏内设备最新位置，越界记录报警（去抖在 FenceStore）
   */
  var fenceWatchTimer = null;
  function startFenceWatch() {
    if (fenceWatchTimer) clearInterval(fenceWatchTimer);
    fenceWatchTimer = setInterval(function () {
      if (!AC.isAuthenticated()) return;
      var fences = FenceStore.all().filter(function (f) { return f.enabled; });
      if (!fences.length) return;
      var imeis = Object.keys(PetStore.all());
      if (!imeis.length) return;
      // 每次抽查一台（降低请求频率）
      var imei = imeis[Math.floor(Date.now() / 10000) % imeis.length];
      AC.latestLocation(imei).then(function (res) {
        if (res.code !== 0 || !res.value || res.value.lng === undefined) return;
        var lng = Number(res.value.lng), lat = Number(res.value.lat);
        if (!isFinite(lng) || !isFinite(lat)) return;
        fences.forEach(function (f) {
          var inside = FenceStore.isPointInFence([lng, lat], f);
          if (!inside) {
            var alert = FenceStore.addAlert(imei, f.id, [lng, lat], res.value.address);
            if (alert) {
              U.toast('�� 「' + f.name + '」设备 ' + PetStore.nameOf(imei) + ' 越界！');
              Views.updateAlertDot();
            }
          }
        });
      });
    }, 30000);
  }

  function boot() {
    // 宿主 m_* 注入监听（可选）
    // 自动登录：已认证则渲染；未认证跳 login
    var app = document.getElementById('app-root');
    if (!app) return;
    if (!AC.isAuthenticated()) {
      AC.redirectToLogin('/' + CFG.APP_PAGE);
      return;
    }
    Views.buildShell(app);
    global.addEventListener('hashchange', navigate);
    if (!global.location.hash) global.location.hash = '#/home';
    MapKit.bindDelegates();
    Views.bindTurboStop();
    navigate();
    startFenceWatch();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  global.Main = { navigate: navigate, boot: boot };
})(window);