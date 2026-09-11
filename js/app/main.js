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
   * 每次只抽查一台设备，把请求频率压到最低。
   */
  var fenceWatchTimer = null;

  /** 抽查一台设备，判断是否越界（fences 已是「对该设备生效」的过滤结果） */
  function probeOne(imei, fences) {
    AC.latestLocation(imei).then(function (res) {
      if (res.code !== 0 || !res.value || res.value.lng === undefined) return;
      var lng = Number(res.value.lng), lat = Number(res.value.lat);
      if (!isFinite(lng) || !isFinite(lat)) return;
      fences.forEach(function (f) {
        if (FenceStore.isPointInFence([lng, lat], f)) return;
        var alert = FenceStore.addAlert(imei, f.id, [lng, lat], res.value.address);
        if (!alert) return;
        var name = PetStore.nameOf(imei);
        U.toast('🚨 「' + f.name + '」设备 ' + name + ' 越界！');
        Views.updateAlertDot();
        // 消息推送：前台已有 toast + 红点，Push 内部会判断只在后台才推系统通知
        if (global.Push) global.Push.alarm(alert, f, name);
      });
    });
  }

  function checkFencesOnce() {
    if (!AC.isAuthenticated()) return;
    var fences = FenceStore.all().filter(function (f) { return f.enabled; });
    if (!fences.length) return;

    // 候选设备 = 被某围栏指定的设备 ∪（存在"全部设备"围栏时的所有设备）
    var untargeted = fences.filter(function (f) { return !f.imeis || !f.imeis.length; });
    var imeiSet = {};
    fences.forEach(function (f) {
      (f.imeis || []).forEach(function (i) { imeiSet[String(i)] = true; });
    });
    var imeis;
    var ownKeys = Object.keys(PetStore.all());
    if (untargeted.length) {
      // 有"对全部设备生效"的围栏：旧语义不变，所有已知设备都是候选
      ownKeys.forEach(function (i) { imeiSet[i] = true; });
    }
    imeis = Object.keys(imeiSet);
    if (!imeis.length) {
      // 深链直达（例如点报警通知进来）时 PetStore 可能还是空的 —— 若就此返回，
      // 会出现「围栏明明开着，却完全不巡检」。这里用 TTL 缓存的设备列表兜底
      // （loadDevices 命中 60s 缓存时不产生请求）。
      try {
        Views.loadDevices().then(function (devices) {
          var ids = (devices || []).map(function (d) { return String(d.deviceid); })
            .filter(function (id) { return fences.some(function (f) { return FenceStore.targetsImei(f, id); }); });
          if (!ids.length) return;
          var pick = ids[Math.floor(Date.now() / 10000) % ids.length];
          probeOne(pick, fences.filter(function (f) { return FenceStore.targetsImei(f, pick); }));
        })['catch'](function () { /* ignore */ });
      } catch (e) { /* ignore */ }
      return;
    }
    // 每次抽查一台（降低请求频率），按 10s 时间片轮换
    var imei = imeis[Math.floor(Date.now() / 10000) % imeis.length];
    probeOne(imei, fences.filter(function (f) { return FenceStore.targetsImei(f, imei); }));
  }

  function startFenceWatch() {
    if (fenceWatchTimer) clearInterval(fenceWatchTimer);
    fenceWatchTimer = setInterval(checkFencesOnce, CFG.FENCE_WATCH_MS);
    // 回到前台立刻补一次巡检：WebView / 浏览器在后台会限制定时器执行，
    // 只靠 setInterval 会漏掉后台这段时间里的越界
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden) checkFencesOnce();
    });
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
    // 主题落盘（theme.js 已在脚本求值时先画过一次，这里保证属性与存储一致）
    if (global.Theme && global.Theme.init) global.Theme.init();
    if (global.Push && global.Push.init) global.Push.init();
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

  // checkFencesOnce 一并导出：离线验证环境需要直接驱动一轮越界巡检
  global.Main = { navigate: navigate, boot: boot, checkFencesOnce: checkFencesOnce };
})(window);