/**
 * utils.js —— 通用工具层
 * 挂载：window.Utils
 * 时间规则（v48 最高优先级）：平台数据包时间本身已是 UTC+8（北京时间），
 * WEB 端展示/解析一律本地钟面直出，禁止任何 ±8 运算、禁止出现 UTC 字样。
 */
(function (global) {
  'use strict';

  /**
   * 安全本地存储（try-catch 包裹，禁止裸调 localStorage）
   */
  var store = {
    get: function (key) {
      try {
        var raw = global.localStorage.getItem(key);
        if (raw === null || raw === undefined || raw === '') return null;
        var obj = JSON.parse(raw);
        if (obj === null || typeof obj !== 'object' || Array.isArray(obj) === false && Object.keys(obj).length === 0) return obj;
        return obj;
      } catch (e) {
        return null;
      }
    },
    getRaw: function (key) {
      try { return global.localStorage.getItem(key); } catch (e) { return null; }
    },
    set: function (key, val) {
      try {
        global.localStorage.setItem(key, typeof val === 'string' ? val : JSON.stringify(val));
        return true;
      } catch (e) { return false; }
    },
    remove: function (key) {
      try { global.localStorage.removeItem(key); } catch (e) { /* ignore */ }
    },
    clearPrefix: function (prefix) {
      try {
        var keys = [];
        for (var i = 0; i < global.localStorage.length; i++) {
          var k = global.localStorage.key(i);
          if (k && k.indexOf(prefix) === 0) keys.push(k);
        }
        keys.forEach(function (k) { global.localStorage.removeItem(k); });
      } catch (e) { /* ignore */ }
    },
    session: {
      get: function (key) {
        try { return global.sessionStorage.getItem(key); } catch (e) { return null; }
      },
      set: function (key, val) {
        try { global.sessionStorage.setItem(key, val); return true; } catch (e) { return false; }
      },
      remove: function (key) {
        try { global.sessionStorage.removeItem(key); } catch (e) { /* ignore */ }
      }
    }
  };

  /**
   * 字符串转义：所有 innerHTML 拼接的动态数据一律经此函数
   */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * 本地钟面解析 "YYYY-MM-DD HH:mm:ss"（无时区字面按本地钟面解析）
   * 返回 Date；失败返回 null
   */
  function parseLocalTime(str) {
    if (!str) return null;
    if (typeof str === 'number' || (typeof str === 'string' && /^\d+$/.test(str))) {
      var ms = Number(str);
      if (isFinite(ms) && ms > 0) return new Date(ms);
      return null;
    }
    var m = String(str).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
    if (!m) {
      var d = new Date(str);
      return isNaN(d.getTime()) ? null : d;
    }
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
  }

  /**
   * 取记录时间戳：batch_time（毫秒）优先，否则 ct 本地钟面解析
   */
  function recTs(rec) {
    if (rec && rec.batch_time) {
      var bt = Number(rec.batch_time);
      if (isFinite(bt) && bt > 0) return bt;
    }
    var t = (rec && (rec.ct || rec.time)) || null;
    if (!t) return 0;
    var d = (typeof rec.batch_time === 'number' && rec.batch_time > 0) ? new Date(rec.batch_time) : parseLocalTime(t);
    return d ? d.getTime() : 0;
  }

  function two(n) { return (n < 10 ? '0' : '') + n; }

  /**
   * 毫秒 -> "YYYY-MM-DD HH:mm:ss"（本地钟面直出）
   */
  function fmtFull(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()) +
      ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  }

  /**
   * 毫秒 -> "MM-DD HH:mm:ss"（本地钟面直出）
   */
  function fmtShort(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    return two(d.getMonth() + 1) + '-' + two(d.getDate()) +
      ' ' + two(d.getHours()) + ':' + two(d.getMinutes()) + ':' + two(d.getSeconds());
  }

  /**
   * 平台字面时间（"2026-08-18 18:53:54"）直出展示，不做换算
   */
  function fmtLiteral(str) {
    return str || '';
  }

  /**
   * 相对时间 "X 秒前"（物理 epoch 差，与时区无关）
   */
  function timeAgo(ts) {
    if (!ts) return '';
    var diff = Date.now() - ts;
    if (diff < 0) diff = 0;
    var s = Math.floor(diff / 1000);
    if (s < 60) return s + ' 秒前';
    var mi = Math.floor(s / 60);
    if (mi < 60) return mi + ' 分钟前';
    var h = Math.floor(mi / 60);
    if (h < 24) return h + ' 小时前';
    var d = Math.floor(h / 24);
    return d + ' 天前';
  }

  /**
   * 电压 mV -> 电量百分比（vbat：(v-3000)/(4200-3000)）
   */
  function vbatToPercent(mv) {
    var v = Number(mv);
    if (!isFinite(v) || v <= 0) return null;
    var pct = (v - 3000) / (4200 - 3000) * 100;
    pct = Math.max(0, Math.min(100, pct));
    return Math.round(pct);
  }

  /**
   * 电量档位：按 vbat(mV) 返回 low/mid/high/none（用于电池图标着色）
   * low  < 3400mV（低电量）；mid < 3700mV；high ≥3700mV
   */
  function batteryTone(mv) {
    var v = Number(mv);
    if (!isFinite(v) || v <= 0) return 'none';
    var LOW = 3400, HIGH = 3700;
    try { LOW = global.CFG.VBAT_LOW_MV; HIGH = global.CFG.VBAT_MID_MV; } catch (e) { /* ignore */ }
    if (v < LOW) return 'low';
    if (v < HIGH) return 'mid';
    return 'high';
  }

  /**
   * 782 4G 信号分档
   */
  function signalText(v) {
    var n = Number(v);
    if (!isFinite(n)) return '';
    if (n >= 0 && n <= 10) return '弱';
    if (n <= 20) return '一般';
    return '强';
  }

  /**
   * 手机号脱敏 138****5678
   */
  function maskPhone(p) {
    if (!p) return '';
    var s = String(p);
    if (s.length < 7) return s;
    return s.slice(0, 3) + '****' + s.slice(-4);
  }

  function debounce(fn, wait) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      if (t) clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, wait);
    };
  }

  function throttle(fn, wait) {
    var last = 0, t = null;
    return function () {
      var args = arguments, self = this;
      var now = Date.now();
      if (now - last >= wait) {
        last = now;
        fn.apply(self, args);
      } else if (!t) {
        t = setTimeout(function () { t = null; last = Date.now(); fn.apply(self, args); }, wait - (now - last));
      }
    };
  }

  /**
   * 从当前 URL 提取 appId：/ai_app/luatos/{appId}/ 前缀之后到下一个 /
   * 兜底回退 CFG.FALLBACK_APP_ID
   */
  function extractAppId() {
    try {
      var href = global.location.href;
      var m = href.match(/\/ai_app\/luatos\/([^/]+)\//);
      if (m && m[1]) return m[1];
    } catch (e) { /* ignore */ }
    return global.CFG.FALLBACK_APP_ID;
  }

  /**
   * 拼完整绝对页面地址：生产拼 BASE_HOST 前缀，本地（file/localhost）回退相对路径
   */
  function pageUrl(file) {
    var host = global.location && global.location.host;
    if (host && host !== 'localhost' && host !== '127.0.0.1') {
      return global.CFG.BASE_HOST + '/ai_app/luatos/' + extractAppId() + '/' + (file || '');
    }
    return (file || '');
  }

  /**
   * 用 default 合并对象（浅拷贝增强）
   */
  function extend(target, src) {
    if (!src) return target || {};
    target = target || {};
    for (var k in src) {
      if (Object.prototype.hasOwnProperty.call(src, k)) target[k] = src[k];
    }
    return target;
  }

  /**
   * 唯一 id
   */
  function uid(prefix) {
    prefix = prefix || '';
    return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  /**
   * DOM 便捷：安全查询
   */
  function $(sel, root) {
    return (root || document).querySelector(sel);
  }
  function $all(sel, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(sel));
  }
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  function toast(msg, type) {
    try {
      var box = $('.toast-wrap');
      if (!box) {
        box = el('div', 'toast-wrap');
        document.body.appendChild(box);
      }
      var t = el('div', 'toast' + (type === 'err' ? ' toast-err' : '') , msg);
      box.appendChild(t);
      setTimeout(function () {
        t.classList.add('toast-out');
        setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
      }, 2600);
    } catch (e) { /* ignore */ }
  }

  /**
   * 简易日期范围工具（本地钟面）
   */
  function todayLocal() {
    var d = new Date();
    return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
  }
  function hourAgoLocal(h) {
    var d = new Date(Date.now() - h * 3600000);
    return fmtFull(d.getTime());
  }

  var Utils = {
    store: store,
    esc: esc,
    parseLocalTime: parseLocalTime,
    recTs: recTs,
    fmtFull: fmtFull,
    fmtShort: fmtShort,
    fmtLiteral: fmtLiteral,
    timeAgo: timeAgo,
    vbatToPercent: vbatToPercent,
    batteryTone: batteryTone,
    signalText: signalText,
    maskPhone: maskPhone,
    debounce: debounce,
    throttle: throttle,
    extractAppId: extractAppId,
    pageUrl: pageUrl,
    extend: extend,
    uid: uid,
    $: $,
    $all: $all,
    el: el,
    toast: toast,
    todayLocal: todayLocal,
    hourAgoLocal: hourAgoLocal,
    two: two,
    log: function () {
      try {
        if (global.console && global.console.log) global.console.log.apply(global.console, arguments);
      } catch (e) { /* ignore */ }
    }
  };

  global.Utils = Utils;
})(window);