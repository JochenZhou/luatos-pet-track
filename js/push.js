/**
 * push.js —— 报警消息推送
 * 挂载：window.Push
 *
 * 三条通道，按可用性依次降级：
 *   ① Android 原生通知（window.AndroidBridge.notify）—— APP 内唯一可靠的系统级推送
 *   ② 浏览器 Web Notification —— 桌面浏览器 / 部分 Android 浏览器可用
 *   ③ 都没有 → 只走应用内 toast + 报警红点（不静默失败，永远有反馈）
 *
 * 重要设计（避免「同一件事提示两遍」）：
 *   页面在前台时，应用内已经有 toast + 红点，此时**不再**弹系统通知；
 *   只有页面被切到后台（document.hidden）才推系统通知 —— 这才是推送的价值所在。
 *
 * 关于 Android WebView：WebView 不实现 Web Notification API，
 *   所以 APP 内必须走原生通道（MainActivity 的 AndroidBridge.notify）。
 */
(function (global) {
  'use strict';
  var U = global.Utils;
  var CFG = global.CFG;

  /** 去重：同一设备+同一围栏在 DEDUP_MS 内只推一次（与 FenceStore 的 5 分钟去抖互补） */
  var DEDUP_MS = 60000;
  var lastPushed = {};

  function bridge() {
    return global.AndroidBridge || null;
  }

  function hasNative() {
    var b = bridge();
    return !!(b && typeof b.notify === 'function');
  }

  /** WebView 里 typeof Notification 通常是 undefined（不是 'undefined' 字符串） */
  function hasWeb() {
    return typeof global.Notification === 'function';
  }

  function webPermission() {
    if (!hasWeb()) return 'unsupported';
    try { return global.Notification.permission || 'default'; } catch (e) { return 'unsupported'; }
  }

  function enabled() {
    return U.store.getRaw(CFG.KEY_PUSH) === '1';
  }

  function setEnabled(on) {
    U.store.set(CFG.KEY_PUSH, on ? '1' : '0');
    return enabled();
  }

  function supported() {
    return { native: hasNative(), web: hasWeb(), webPermission: webPermission() };
  }

  /** 当前可用的推送通道名，供设置面板展示 */
  function channelName() {
    if (hasNative()) return 'APP 原生通知';
    if (hasWeb() && webPermission() === 'granted') return '浏览器通知';
    if (hasWeb()) return '浏览器通知（未授权）';
    return '仅应用内提示';
  }

  /** 请求通知权限：APP 走原生授权（Android 13+），浏览器走 Web Notification 授权 */
  function requestPermission() {
    var b = bridge();
    if (b && typeof b.requestNotifyPermission === 'function') {
      try {
        b.requestNotifyPermission();
        return Promise.resolve('native');
      } catch (e) { /* 落到 Web 分支 */ }
    }
    if (!hasWeb()) return Promise.resolve('unsupported');
    var p = webPermission();
    if (p === 'granted' || p === 'denied') return Promise.resolve(p);
    try {
      var r = global.Notification.requestPermission();
      if (r && typeof r.then === 'function') {
        return r['catch'](function () { return 'unsupported'; });
      }
    } catch (e) { /* 老实现走回调式，忽略 */ }
    return Promise.resolve(webPermission());
  }

  /** 拿内联的品牌 logo 当通知图标（data URI，不产生网络请求） */
  function iconUrl() {
    try {
      var v = global.Theme && global.Theme.cssVar ? global.Theme.cssVar('--logo', '') : '';
      var m = v.match(/url\(["']?([^"')]+)/);
      return m ? m[1] : '';
    } catch (e) { return ''; }
  }

  /**
   * 底层分发。返回实际使用的通道：'native' | 'web' | 'none'
   */
  function deliver(title, body, hash) {
    var t = String(title || '报警');
    var b = String(body || '');
    var h = hash || '';

    if (hasNative()) {
      try {
        bridge().notify(t, b, h);
        return 'native';
      } catch (e) { /* 落到下一条通道 */ }
    }

    if (hasWeb() && webPermission() === 'granted') {
      try {
        var n = new global.Notification(t, {
          body: b,
          tag: 'pettrack' + h,          // 同 tag 覆盖，避免刷屏
          renotify: true,
          icon: iconUrl()
        });
        n.onclick = function () {
          try {
            global.focus();
            if (h) global.location.hash = h;
            n.close();
          } catch (e) { /* ignore */ }
        };
        return 'web';
      } catch (e) { /* 落到 none */ }
    }

    return 'none';
  }

  /**
   * 越界报警推送
   * @param {{imei:string,fenceId:string,address?:string,lng:number,lat:number}} alert
   * @param {{name:string}} fence
   * @param {string} petName
   * @returns {string} 'off' | 'foreground' | 'dup' | 'native' | 'web' | 'none'
   */
  function alarm(alert, fence, petName) {
    if (!alert) return 'none';
    if (!enabled()) return 'off';

    var key = alert.imei + '|' + alert.fenceId;
    var now = Date.now();
    if (lastPushed[key] && (now - lastPushed[key]) < DEDUP_MS) return 'dup';
    lastPushed[key] = now;

    // 前台已经有 toast + 红点，不重复打扰
    if (!document.hidden) return 'foreground';

    var where = alert.address ? ('，' + alert.address) : '';
    var name = petName || alert.imei;
    // 设备还没命名时补一个 IMEI 尾号：通知栏只写「未命名设备」的话，
    // 根本认不出是哪一台（应用内卡片下面是有 IMEI 的，通知栏没有）。
    var placeholder = (CFG.DEV_PLACEHOLDER_NAME && name === CFG.DEV_PLACEHOLDER_NAME) || name === alert.imei;
    var tail = placeholder ? ('（尾号' + String(alert.imei).slice(-6) + '）') : '';
    var title = '🚨 越界报警';
    var body = '「' + ((fence && fence.name) || '围栏') + '」' + name + tail +
      ' 已越界' + where;
    return deliver(title, body, '#/alerts');
  }

  /** 其它类型通知（预留：低电量、设备离线等） */
  function info(title, body, hash) {
    if (!enabled()) return 'off';
    return deliver(title, body, hash || '');
  }

  /** 测试推送：不看去抖、不看过不过滤，直接发一条 */
  function test() {
    return deliver('🚨 PetTrack 推送测试',
      '收到这条通知说明推送通道正常。' + (document.hidden ? '' : '（当前页面在前台，实际报警会走应用内提示）'),
      '#/alerts');
  }

  function init() {
    var s = supported();
    return s;
  }

  var Push = {
    DEDUP_MS: DEDUP_MS,
    enabled: enabled,
    setEnabled: setEnabled,
    supported: supported,
    channelName: channelName,
    requestPermission: requestPermission,
    deliver: deliver,
    alarm: alarm,
    info: info,
    test: test,
    init: init,
    _reset: function () { lastPushed = {}; }   // 供测试使用
  };

  global.Push = Push;
})(window);
