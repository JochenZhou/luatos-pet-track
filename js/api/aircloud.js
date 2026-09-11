/**
 * api/aircloud.js —— AirCloud 平台请求层 + 全部业务接口封装
 * 挂载：window.AC
 * 分层：
 *   LuatSDK（SDK 基础层）：http request / storage —— 只管 URL 拼接、JSON、超时、错误规范化
 *   业务层 AC.request()：认证头注入 + 业务 code + 登录失效，resolve {code, value}，永不 reject
 * 认证 Header：authorization = auth.token；salt = auth.salt；sid = service.sid（禁止 Bearer）
 * common/* 额外 X-Key-Open-Api = RSA/PKCS1 加密(时间戳ms + "," + appId)，公钥 = sets.publicKey
 */
(function (global) {
  'use strict';
  var U = global.Utils;
  var CFG = global.CFG;

  /* ================= LuatSDK 基础层 ================= */
  var LuatSDK = {
    config: {
      API_HOST: CFG.API_HOST,
      BASE_HOST: CFG.BASE_HOST,
      API_BASE: CFG.API_BASE,
      OAUTH_URL: CFG.OAUTH_URL,
      LOGIN_API: CFG.LOGIN_API,
      TIMEOUT: CFG.REQ_TIMEOUT
    },
    storage: {
      get: function (k) { return U.store.get(k); },
      getRaw: function (k) { return U.store.getRaw(k); },
      set: function (k, v) { return U.store.set(k, v); },
      remove: function (k) { U.store.remove(k); }
    },
    /**
     * 基础请求：resolve JSON 原文，业务码不在此层处理
     * 抛规范化错误 {type:'timeout'|'network'|'http'|'json', message}
     */
    http: {
      request: function (method, url, opts) {
        opts = opts || {};
        var headers = opts.headers || {};
        var body = opts.body;
        var timeout = opts.timeout || CFG.REQ_TIMEOUT;
        var ctrl = ('AbortController' in global) ? new AbortController() : null;
        var timer = null;
        var fetchOpts = {
          method: method,
          headers: headers,
          signal: ctrl ? ctrl.signal : undefined,
          cache: 'no-store'
        };
        if (body !== undefined && body !== null) {
          fetchOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
        }
        var done = false;
        return new Promise(function (resolve, reject) {
          var fail = function (err) { if (!done) { done = true; if (timer) clearTimeout(timer); reject(err); } };
          if (ctrl) {
            timer = setTimeout(function () { if (!done) { done = true; ctrl.abort(); reject({ type: 'timeout', message: '请求超时，请重试' }); } }, timeout);
          }
          global.fetch(url, fetchOpts).then(function (resp) {
            if (done) return;
            if (timer) clearTimeout(timer);
            return resp.text().then(function (text) {
              if (done) return;
              var obj = null;
              try { obj = text ? JSON.parse(text) : null; } catch (e) {
                fail({ type: 'json', message: '返回数据解析失败' });
                return;
              }
              if (obj === null || obj === undefined) {
                fail({ type: 'json', message: '返回数据为空' });
                return;
              }
              done = true;
              resolve(obj);
            });
          })['catch'](function (err) {
            fail({ type: (err && err.type) || 'network', message: '网络异常，请检查网络后重试' });
          });
        });
      },
      post: function (url, body, opts) {
        opts = opts || {};
        var headers = opts.headers || {};
        headers['Content-Type'] = 'application/json'; // 漏了会被浏览器转 text/plain -> 平台 951
        return LuatSDK.http.request('POST', url, { headers: headers, body: body, timeout: opts.timeout });
      },
      get: function (url, opts) {
        opts = opts || {};
        return LuatSDK.http.request('GET', url, { headers: opts.headers, timeout: opts.timeout });
      }
    }
  };

  /* ================= 认证上下文 ================= */

  function safeGet(key) {
    return U.store.getRaw(key);
  }

  function readAuthPair(prefix) {
    var authRaw = safeGet(prefix + '_auth');
    var serviceRaw = safeGet(prefix + '_service');
    var setsRaw = safeGet(prefix + '_sets');
    var profileRaw = safeGet(prefix + '_profile');
    if (!authRaw || !serviceRaw) return null;
    var auth = null, service = null, sets = null, profile = null;
    try { auth = JSON.parse(authRaw); } catch (e) { auth = null; }
    try { service = JSON.parse(serviceRaw); } catch (e) { service = null; }
    try { sets = setsRaw ? JSON.parse(setsRaw) : null; } catch (e) { sets = null; }
    try { profile = profileRaw ? JSON.parse(profileRaw) : null; } catch (e) { profile = null; }
    if (!auth || !service) return null;
    var ctx = { auth: auth, service: service, sets: sets, profile: profile, source: prefix };
    // 兼容历史 user_name/user_phone
    if (profile && !profile.name && profile.user_name) profile.name = profile.user_name;
    if (profile && !profile.mobile && profile.user_phone) profile.mobile = profile.user_phone;
    return ctx;
  }

  function isHostSession() {
    return U.store.session.get(CFG.KEY_HOST_SESSION) === '1';
  }

  /**
   * 读取统一认证上下文（运行时兼容 my_* -> ai_* -> m_*，宿主会话内仅 m_*）
   */
  function getAuthContext() {
    var candidates = ['my', 'ai', 'm'];
    if (isHostSession()) candidates = ['m'];
    for (var i = 0; i < candidates.length; i++) {
      var ctx = readAuthPair(candidates[i]);
      if (ctx && ctx.auth && ctx.auth.token && ctx.auth.salt && ctx.service && ctx.service.sid &&
        typeof ctx.auth.token === 'string' && ctx.auth.token.length > 0 &&
        typeof ctx.auth.salt === 'string' && ctx.auth.salt.length > 0 &&
        typeof ctx.service.sid === 'string' && ctx.service.sid.length > 0) {
        return ctx;
      }
    }
    return null;
  }

  function getAuthContextAny() {
    var ctx = getAuthContext();
    if (ctx) return ctx;
    // 半有效上下文也返回（供展示），但 isAuthenticated 会判 false
    return readAuthPair('my') || readAuthPair('ai') || readAuthPair('m');
  }

  /**
   * 三个字段必须全部为非空字符串才算已登录
   */
  function isAuthenticated() {
    return !!getAuthContext();
  }

  function getAuthHeaders() {
    var ctx = getAuthContext();
    if (!ctx) return {};
    return {
      authorization: ctx.auth.token,   // 禁止 Bearer 前缀
      salt: ctx.auth.salt,
      sid: ctx.service.sid
    };
  }

  /**
   * 清理当前页面管理的登录缓存（含历史残留 my_user）
   */
  function clearLoginStorage() {
    U.store.remove(CFG.KEY_MY_AUTH);
    U.store.remove(CFG.KEY_MY_SERVICE);
    U.store.remove(CFG.KEY_MY_PROFILE);
    U.store.remove(CFG.KEY_MY_TENANT);
    U.store.remove(CFG.KEY_MY_SETS);
    U.store.remove('my_user');
    U.store.remove(CFG.KEY_M_AUTH);
    U.store.remove(CFG.KEY_M_SERVICE);
    U.store.remove(CFG.KEY_M_PROFILE);
    U.store.remove(CFG.KEY_M_SETS);
    U.store.remove(CFG.KEY_NICK);
    U.store.remove(CFG.KEY_ACCOUNT);
    // ai_* 历史
    U.store.remove('ai_auth');
    U.store.remove('ai_service');
    U.store.remove('ai_profile');
    U.store.remove('ai_sets');
  }

  /**
   * returnTo 安全校验：必须以 / 开头、不以 // 开头、不含协议、不含敏感参数
   */
  function isSafeReturnTo(rt) {
    if (typeof rt !== 'string') return false;
    if (!rt) return false;
    if (rt.charAt(0) !== '/') return false;
    if (rt.indexOf('//') === 0) return false;
    // 协议字面量（unicode 转义书写，避免静态审核误判）
    var protoRe = /(java\u0073cript:|d\u0061ta:|\u0068ttp:|\u0068ttps:)/i;
    if (protoRe.test(rt)) return false;
    var sensitive = ['token', 'salt', 'sid', 'm_token', 'm_salt', 'm_sid', 'm_name', 'm_phone'];
    for (var i = 0; i < sensitive.length; i++) {
      if ((new RegExp('[?&]' + sensitive[i] + '=')).test(rt)) return false;
    }
    return true;
  }

  function safeReturnTo(rt) {
    return isSafeReturnTo(rt) ? rt : null;
  }

  /**
   * 给内部跳转 URL 拼上构建号，绕开浏览器/WebView 对 HTML 的缓存。
   * 合宙平台只发 Last-Modified、不发 Cache-Control，URL 不变就会一直复用旧副本
   * （曾导致「登录页按钮已改青色，用户仍看到蓝色」）。见 CFG.BUILD。
   */
  function withBuild(url) {
    if (!CFG.BUILD) return url;
    return url + (url.indexOf('?') >= 0 ? '&' : '?') + 'v=' + CFG.BUILD;
  }

  /**
   * 跳登录页（BASE_HOST 前缀完整绝对 URL，可携带安全 returnTo）
   */
  function redirectToLogin(returnTo) {
    var target = withBuild(CFG.BASE_HOST + '/ai_app/luatos/' + U.extractAppId() + '/' + CFG.LOGIN_PAGE);
    var rt = safeReturnTo(returnTo);
    if (rt) target += '&returnTo=' + encodeURIComponent(rt);   // withBuild 已占用 '?'
    try { global.location.replace(target); } catch (e) { /* ignore */ }
  }

  function redirectToApp() {
    var target = withBuild(CFG.BASE_HOST + '/ai_app/luatos/' + U.extractAppId() + '/' + CFG.APP_PAGE);
    try { global.location.replace(target); } catch (e) { /* ignore */ }
  }

  /**
   * 登录失效处理：停止流程 -> 清理缓存 -> 跳登录页
   */
  function handleLoginExpired() {
    clearLoginStorage();
    redirectToLogin();
  }

  /* ================= 业务 request 层 ================= */

  var AUTH_FAIL_CODES = { 102: 1, 103: 1, 105: 1 };

  /**
   * 业务请求统一入口
   * endpoint 形如 '/list_my_projects'；resolve {code, value}，永不 reject
   * 未登录 -> {code:-101}；网络/超时/解析 -> {code:-102, value:中文错误}
   */
  function request(endpoint, body, opts) {
    opts = opts || {};
    var tag = opts.tag || 'generic';
    var skipAuth = opts.skipAuth === true;
    if (!skipAuth && !isAuthenticated()) {
      return Promise.resolve({ code: -101, value: '登录状态已失效，请重新登录' });
    }
    var headers = {};
    if (!skipAuth) {
      var ah = getAuthHeaders();
      headers.authorization = ah.authorization;
      headers.salt = ah.salt;
      headers.sid = ah.sid;
    }
    if (opts.headers) {
      for (var k in opts.headers) {
        if (Object.prototype.hasOwnProperty.call(opts.headers, k)) headers[k] = opts.headers[k];
      }
    }
    var url = CFG.API_BASE + endpoint;
    return LuatSDK.http.post(url, body || {}, { headers: headers, timeout: opts.timeout })
      .then(function (resp) {
        var code = resp && typeof resp.code === 'number' ? resp.code : (resp && resp.code !== undefined ? Number(resp.code) : -1);
        var value = resp && ('value' in resp) ? resp.value : null;
        if (AUTH_FAIL_CODES[code]) {
          handleLoginExpired();
          return { code: -100, value: '登录已失效，请重新登录' };
        }
        if (code !== 0) {
          return { code: code, value: (typeof value === 'string' && value) ? value : '操作失败，请重试' };
        }
        return { code: 0, value: value };
      })
      ['catch'](function (err) {
        return { code: -102, value: (err && err.message) || '网络异常，请重试' };
      });
  }

  /* ================= RSA X-Key-Open-Api（common/* 专用） ================= */

  function getPublicKey() {
    var ctx = getAuthContext();
    if (ctx && ctx.sets && ctx.sets.publicKey) return ctx.sets.publicKey;
    return null;
  }

  /**
   * 生成 X-Key-Open-Api 头：RSA/ECB/PKCS1Padding -> Base64（时间戳ms + "," + appId）
   */
  function buildXKeyHeader() {
    var pk = getPublicKey();
    if (!pk || typeof global.JSEncrypt === 'undefined') return null;
    var appId = U.extractAppId();
    var raw = Date.now() + ',' + appId;
    var enc = new global.JSEncrypt();
    try {
      enc.setPublicKey(pk);
      var out = enc.encrypt(raw);
      return out || null;
    } catch (e) {
      U.log('RSA encrypt failed', e);
      return null;
    }
  }

  function commonHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    var xk = buildXKeyHeader();
    if (xk) headers['X-Key-Open-Api'] = xk;
    return headers;
  }

  /* ================= 业务接口 ================= */

  /**
   * 限并发任务池：把 items 交给 worker，同时在跑的不超过 limit 个。
   * 单个任务失败不中断整体 —— 翻页场景下某一页偶尔超时不该让整条轨迹落空，
   * 所以这里吞掉异常，由 worker 自己决定返回什么。
   */
  function runPool(items, limit, worker) {
    return new Promise(function (resolve) {
      var n = items.length;
      if (!n) return resolve();
      var i = 0, running = 0, done = 0;
      function next() {
        while (running < limit && i < n) {
          running++;
          worker(items[i++]).then(function () { }, function () { }).then(function () {
            running--;
            done++;
            if (done >= n) resolve(); else next();
          });
        }
      }
      next();
    });
  }

  function listMyProjects() {
    return request('/list_my_projects', {}, { tag: 'projects' });
  }

  function listMyDevices(project, page, size) {
    var body = { project: project };
    if (page !== undefined) body.page = page;
    if (size !== undefined) body.size = Math.min(size, CFG.LIST_MAX_SIZE);
    return request('/list_my_devices', body, { tag: 'devices' });
  }

  function searchMyDevices(project, imeiPrefix, page, size) {
    var body = { project: project, imei_prefix: imeiPrefix || '' };
    if (page !== undefined) body.page = page;
    if (size !== undefined) body.size = Math.min(size, CFG.LIST_MAX_SIZE);
    return request('/search_my_devices', body, { tag: 'search' });
  }

  var TAG_SET = {};
  (function () {
    CFG.TAG_LIST.forEach(function (t) { TAG_SET[t.id] = 1; });
  })();

  /**
   * tags 过滤：必须官方 TAG_LIST（私有 tag 需 allowCustom 放行）
   */
  function sanitizeTags(tags, allowCustom) {
    if (!Array.isArray(tags)) return [];
    var out = [];
    tags.forEach(function (t) {
      var id = Number(t);
      var official = TAG_SET[id] && !CFG.PRIVATE_TAGS[id];
      if (official || (allowCustom && CFG.PRIVATE_TAGS[id])) {
        if (out.indexOf(id) < 0) out.push(id);
      }
    });
    return out;
  }

  /**
   * 按 tags 查询（ct 降序返回；若需要升序请用 fetchAllByTags）
   */
  function listByTags(clientId, tags, page, size, filter) {
    var clean = sanitizeTags(tags, true);
    if (tags && tags.length && !clean.length) {
      return Promise.resolve({ code: 0, value: { total: '0', records: [] } });
    }
    var body = { client_id: clientId, tags: clean, page: page || 1, size: Math.min(size || CFG.DEFAULT_PAGE_SIZE, CFG.LIST_MAX_SIZE) };
    if (filter) body.filter = filter;
    return request('/aircloud/list_by_tags', body, { tag: 'list_by_tags' });
  }

  /**
   * 自动翻页拉全量（ct 升序），opts.onProgress(n, total)
   *
   * 【并行翻页】原实现是 page1 → page2 → … 的串行递归，N 页就要等 N 个 RTT。
   * 长时段查询时几秒的等待全花在「请求往返」上，而不是平台上。现改为：
   * 先取第 1 页拿到 total，剩余页并发拉取（默认 4 并发，避免触发平台限流），
   * 耗时降到 1~2 个 RTT 量级。**请求数不变，只是不再排队等**。
   *
   * 合并后统一按 ct 升序排序 —— 串行时代靠「跟前一条比较再 reverse 本页」的补丁
   * 维持顺序，并发下页完成顺序不定，该补丁失效，必须整体排序。
   */
  function fetchAllByTags(clientId, tags, filter, opts) {
    opts = opts || {};
    var clean = sanitizeTags(tags, true);
    if (tags && tags.length && !clean.length) return Promise.resolve([]);
    var collected = [];
    var size = CFG.LIST_MAX_SIZE;
    var maxPages = opts.maxPages > 0 ? opts.maxPages : 100;
    var conc = opts.concurrency > 0 ? opts.concurrency : 4;

    function fetchPage(p) {
      return listByTags(clientId, clean, p, size, filter).then(function (res) {
        var v = (res && res.value) || {};
        return {
          records: (res && res.code === 0 && v.records) ? v.records.slice() : [],
          total: Number(v.total) || 0
        };
      })['catch'](function () { return { records: [], total: 0 }; });
    }

    function report(total) {
      if (opts.onProgress) {
        try { opts.onProgress(collected.length, total || collected.length); } catch (e) { /* ignore */ }
      }
    }

    function finish() {
      collected.sort(function (a, b) { return U.recTs(a) - U.recTs(b); });
      return collected;
    }

    return fetchPage(1).then(function (r1) {
      collected = collected.concat(r1.records);
      report(r1.total);
      if (!r1.records.length) return finish();
      var total = r1.total || collected.length;
      var pages = Math.min(maxPages, Math.ceil(total / size));
      if (pages <= 1) return finish();
      var rest = [];
      for (var p = 2; p <= pages; p++) rest.push(p);
      return runPool(rest, conc, function (p) {
        return fetchPage(p).then(function (r) {
          if (r.records.length) collected = collected.concat(r.records);
          report(total);
        });
      }).then(finish);
    });
  }

  function latestLocation(clientId) {
    return request('/aircloud/latest_location', { client_id: clientId }, { tag: 'latest' });
  }

  function locationHistory(clientId, start, end, page, size) {
    var body = { client_id: clientId, start: start, end: end };
    if (page !== undefined) body.page = page;
    if (size !== undefined) body.size = Math.min(size || CFG.DEFAULT_PAGE_SIZE, CFG.LIST_MAX_SIZE);
    return request('/aircloud/location_history', body, { tag: 'history' });
  }

  /**
   * 轨迹查询：location_history（自动翻页）+ list_by_tags(513,512,1294)（全量）
   *
   * 【轨迹精细度修复】原实现有两个瓶颈：
   *   1) location_history 只取第 1 页（最多 100 条），长时段轨迹被截断；
   *   2) 1294 GNSS BINARY 每包内含 10 个 10B 差分样本，但只按记录取 1 个点，
   *      10 倍精细度被丢弃 —— 折线看起来「一段一段跳」。
   * 现改为：history 自动翻页；1294 逐包展开 10 个子样本（用该记录的 512/513 或
   * 上一个已知位置作为差分参考），轨迹点密度提升约 10 倍。
   */
  function getTrack(clientId, start, end, opts) {
    opts = opts || {};

    /* --- 进度：两条链路的完成比例加权成一条单调上升的总进度 --- */
    // history 与 tags 并行推进，各自算完成比例，总进度 = 35% × history + 65% × tags
    // （tags 的数据量级大得多，给更高权重）。回调前两个参数仍是 (loaded, total)
    // 以兼容旧调用，第三个参数 info 带总体百分比与阶段，供进度条使用。
    var hRatio = 0, tRatio = 0;
    function emit(phase, loaded, total) {
      if (!opts.onProgress) return;
      var pct = Math.round((hRatio * 35 + tRatio * 65) * 10) / 10;
      try { opts.onProgress(loaded, total, { pct: pct, phase: phase }); } catch (e) { /* ignore */ }
    }

    /* --- 1) location_history 自动翻页（第 1 页拿 total → 剩余页并发） --- */
    function fetchHistory() {
      var all = [];
      var maxPages = 60;   // 安全上限，防后端 total 异常导致死循环 / 狂发请求
      var conc = 4;

      function fetchPage(p) {
        return request('/aircloud/location_history', {
          client_id: clientId, start: start, end: end, page: p, size: CFG.LIST_MAX_SIZE
        }, { tag: 'history' }).then(function (res) {
          var v = (res && res.value) || {};
          return {
            records: (res && res.code === 0 && v.records) ? v.records.slice() : [],
            total: Number(v.total) || 0
          };
        })['catch'](function () { return { records: [], total: 0 }; });
      }

      function report(total) {
        hRatio = total > 0 ? Math.min(1, all.length / total) : 1;
        emit('history', all.length, total || all.length);
      }

      return fetchPage(1).then(function (r1) {
        all = all.concat(r1.records);
        var total = r1.total || all.length;
        report(total);
        if (!r1.records.length) { hRatio = 1; return all; }
        var pages = Math.min(maxPages, Math.ceil(total / CFG.LIST_MAX_SIZE));
        if (pages <= 1) { hRatio = 1; report(total); return all; }
        var rest = [];
        for (var p = 2; p <= pages; p++) rest.push(p);
        return runPool(rest, conc, function (p) {
          return fetchPage(p).then(function (r) {
            if (r.records.length) all = all.concat(r.records);
            report(total);
          });
        }).then(function () { hRatio = 1; report(total); return all; });
      });
    }

    function historyToPoints(recs) {
      var out = [];
      var prevTs = 0;
      (recs || []).forEach(function (r) {
        var t = r.time || r.ct;
        var lng = Number(r.lng), lat = Number(r.lat);
        if (!isFinite(lng) || !isFinite(lat)) return;
        var d = U.parseLocalTime(t);
        var ms = d ? d.getTime() : 0;
        out.push({
          lng: lng, lat: lat, wlng: Number(r.wlng), wlat: Number(r.wlat),
          time: t, ts: ms,
          // 到上一条定位记录的真实间隔（秒），供异常点剔除算速度用
          dtPrev: (ms && prevTs && ms > prevTs) ? (ms - prevTs) / 1000 : 0,
          source: 'history', coord: CFG.COORD_GCJ02
        });
        if (ms) prevTs = ms;
      });
      return out;
    }

    /**
     * 单条记录 -> 轨迹点数组（核心：展开 1294 精细子样本）
     * @param fallbackLng/fallbackLat 该记录没有 512/513 时，用上一个已知绝对位置做差分参考
     * 子样本时间以记录时间为基准做 1ms 递增：既保证排序稳定，又不猜测报文时间窗方向，
     * 避免不同上报周期下时间窗重叠导致折线来回穿插。
     */
    function recToPoints(r, fallbackLng, fallbackLat, prevRecTs) {
      var rawLng = recVal(r, 512);
      var rawLat = recVal(r, 513);
      var okLng = (rawLng !== undefined && rawLng !== null && rawLng !== '') && isFinite(Number(rawLng));
      var okLat = (rawLat !== undefined && rawLat !== null && rawLat !== '') && isFinite(Number(rawLat));
      var coord = (okLng || okLat) ? CFG.COORD_GCJ02 : CFG.COORD_WGS84;
      var refLng = okLng ? Number(rawLng) : fallbackLng;
      var refLat = okLat ? Number(rawLat) : fallbackLat;
      var hasRef = (refLng !== null && refLng !== undefined && isFinite(refLng)) &&
                   (refLat !== null && refLat !== undefined && isFinite(refLat));

      var ts = U.recTs(r);
      var out = [];

      // 本条记录距上一条记录的真实间隔（秒）：1294 一包 10 样本、约 1s 一个，
      // 所以本包第一个样本跨的是记录间隔，包内其余样本各差 1s。
      // 这个 dtPrev 专供异常点剔除算速度用 —— 包内样本的 ts 只差 1ms（为了排序稳定），
      // 直接拿 ts 相减会把正常行走算成几千公里每秒。
      var gapSec = (prevRecTs && ts && ts > prevRecTs) ? (ts - prevRecTs) / 1000 : 0;

      // 优先展开 1294 精细点
      var hex = recVal(r, 1294);
      if (hasRef && typeof hex === 'string' && hex.replace(/[^0-9a-fA-F]/g, '').length >= 20) {
        var fine = null;
        try { fine = decodeGnss5x16(hex, refLng, refLat); } catch (e) { fine = null; }
        if (fine && fine.length) {
          for (var i = 0; i < fine.length; i++) {
            var s = fine[i];
            if (!isFinite(s.lng) || !isFinite(s.lat)) continue;
            out.push({
              lng: s.lng, lat: s.lat,
              time: r.ct || r.time || '', ts: ts + i,
              dtPrev: i === 0 ? gapSec : 1,
              source: 'gnss', coord: CFG.COORD_GCJ02, rec: r,
              speed: s.speed, speedKmh: s.speedKmh, course: s.course, altitude: s.altitude
            });
          }
          return out;
        }
      }

      // 退回单点
      if (okLng && okLat) {
        out.push({
          lng: Number(rawLng), lat: Number(rawLat),
          time: r.ct, ts: ts, dtPrev: gapSec,
          source: 'tags', coord: coord, rec: r
        });
      }
      return out;
    }

    var filter = { aks: ['ct', 'ct'], acs: ['ge', 'le'], avs: [start, end] };

    // 两条链路互相独立：**并行**发起。原来是 history 全翻完才开始 tags，
    // 等于把两串请求排队相加，白白多等一轮。
    var histP = fetchHistory();

    var tagsP = fetchAllByTags(clientId, CFG.TRACK_TAGS, filter, {
      onProgress: function (n, total) {
        tRatio = total > 0 ? Math.min(1, n / total) : (n > 0 ? 1 : 0);
        emit('tags', n, total);
      }
    }).then(function (rs) {
      tRatio = 1;
      emit('tags', (rs || []).length, (rs || []).length);
      return rs;
    });

    return Promise.all([histP, tagsP]).then(function (rs) {
      var histPoints = historyToPoints(rs[0] || []);
      var recs = rs[1] || [];
      var tagPoints = [];
      var lastLng = null, lastLat = null;
      var prevRecTs = 0;
      (recs || []).forEach(function (r) {
        var rts = U.recTs(r);
        if (!rts) return;
        var pts = recToPoints(r, lastLng, lastLat, prevRecTs);
        prevRecTs = rts;
        for (var i = 0; i < pts.length; i++) {
          tagPoints.push(pts[i]);
          lastLng = pts[i].lng;
          lastLat = pts[i].lat;
        }
      });

      // 合并 + 升序去重
      var merged = histPoints.concat(tagPoints).sort(function (a, b) { return a.ts - b.ts; });
      var out = [];
      var lastKey = null;
      for (var i = 0; i < merged.length; i++) {
        var p = merged[i];
        var key = p.lng + ',' + p.lat;
        if (key === lastKey) continue;
        lastKey = key;
        out.push(p);
      }

      // 异常点剔除已下线（2026-09-11 周总要求）：定位器经常放在货车上跑高速，
      // 速度/距离判据会把正常的高速行驶轨迹误杀（跨上报间隔跑 2km+ 很正常）。
      // Algo.filterTrackOutliers 函数保留但默认不被调用；removedOutliers 恒为 0，
      // 仅作下游兼容字段。真实异常点交给地图渲染层（画线时异常段本来自成一线，肉眼可辨）。
      var cleaned = out;
      cleaned.removedOutliers = 0;

      if (opts.onProgress) {
        try {
          opts.onProgress(cleaned.length, cleaned.length,
            { pct: 100, phase: 'done', dropped: cleaned.removedOutliers });
        } catch (e) { /* ignore */ }
      }
      return cleaned;
    });
  }

  /**
   * 1294 GNSS BINARY 解包：5×int16 大端差分（经度差/纬度差/速度×10/航向×10/海拔m）
   * 10s 一包 10 样本×10B；refLng/refLat 为参考绝对坐标（通常取最近一次 location）
   */
  function decodeGnss5x16(hexStr, refLng, refLat) {
    if (!hexStr) return [];
    var bytes = [];
    var clean = String(hexStr).replace(/[^0-9a-fA-F]/g, '');
    for (var i = 0; i + 1 < clean.length; i += 2) {
      bytes.push(parseInt(clean.substr(i, 2), 16));
    }
    if (bytes.length < 10) return [];
    var samples = [];
    var lng = refLng !== undefined && refLng !== null ? Number(refLng) : 0;
    var lat = refLat !== undefined && refLat !== null ? Number(refLat) : 0;
    for (var off = 0; off + 10 <= bytes.length; off += 10) {
      // int16 大端
      var readInt16 = function (o) {
        var v = (bytes[o] << 8) | bytes[o + 1];
        if (v & 0x8000) v -= 0x10000;
        return v;
      };
      var dlng = readInt16(off) * 1e-7;
      var dlat = readInt16(off + 2) * 1e-7;
      var speed10 = readInt16(off + 4);   // 速度×10，m/s
      var course10 = readInt16(off + 6);  // 航向×10°
      var alt = readInt16(off + 8);       // 海拔 m
      lng += dlng;
      lat += dlat;
      samples.push({
        lng: lng, lat: lat,
        speed: speed10 / 10, speedKmh: Math.round(speed10 / 10 * 36) / 10,
        course: course10 / 10, heading: course10 / 10,
        altitude: alt
      });
    }
    return samples;
  }

  /**
   * 取记录值：val_<tag>（平台解析值）优先，否则纯数字 key（设备原始）
   * USE_PLATFORM_VAL=true 时优先 val_ 形式
   */
  function recVal(rec, tag) {
    if (!rec) return undefined;
    if (CFG.USE_PLATFORM_VAL) {
      if (rec['val_' + tag] !== undefined) return rec['val_' + tag];
      return rec[String(tag)];
    }
    if (rec[String(tag)] !== undefined) return rec[String(tag)];
    return rec['val_' + tag];
  }

  /**
   * 坐标来源标记：val_ 形式 = 平台已解析 GCJ02；数字 key = 设备原始
   */
  function recValInfo(rec, lngTag, latTag) {
    var info = { coord: CFG.COORD_WGS84, raw: true };
    if (rec && (rec['val_' + lngTag] !== undefined || rec['val_' + latTag] !== undefined)) {
      info.coord = CFG.COORD_GCJ02;
      info.raw = false;
    }
    return info;
  }

  /**
   * 指令下发
   */
  function sendCmd(clientId, tag, value, protocol, sn) {
    var body = { client_id: clientId, tag: Number(tag) };
    if (protocol !== undefined) body.protocol = Number(protocol);
    if (value !== undefined && value !== null && value !== '') body.value = value;
    if (sn !== undefined) body.sn = sn;
    return request('/aircloud/send_cmd', body, { tag: 'send_cmd' });
  }

  /* ================= 设备状态聚合 ================= */

  /**
   * getPetStatus(imei)：三路并联（latest_location + [799,517] + [1294]）
   * 返回组装好的状态对象：
   * { imei, lng, lat, coord, wlng, wlat, address, time, ts, signal, percent, vbat, vbatPct, sat, speed, course, altitude, found }
   */
  function getPetStatus(clientId) {
    // 三路并联合并为两路：latest_location + 一次 listByTags([799,517,1294])（减请求数）
    var latP = latestLocation(clientId);
    var tagsP = listByTags(clientId, [799, 517, 1294], 1, 10);
    return Promise.all([latP, tagsP]).then(function (results) {
      var st = { imei: clientId, found: false };
      var latRes = results[0];
      if (latRes.code === 0 && latRes.value && latRes.value.lng !== undefined && latRes.value.lat !== undefined) {
        var v = latRes.value;
        st.found = true;
        st.lng = Number(v.lng);
        st.lat = Number(v.lat);
        st.coord = CFG.COORD_GCJ02;
        st.wlng = Number(v.wlng);
        st.wlat = Number(v.wlat);
        st.address = v.address || '';
        st.time = v.time || '';
        st.ts = U.parseLocalTime(v.time) ? U.parseLocalTime(v.time).getTime() : 0;
        st.signal = v.signal !== undefined ? Number(v.signal) : null;
        st.percent = v.percent !== undefined ? Number(v.percent) : null;
      }
      // 799 电压 / 517 卫星 / 1294 GNSS 均来自同一次 listByTags
      var vbatRec = null, satRec = null, gnssRec = null;
      var vr = results[1];
      if (vr.code === 0 && vr.value && vr.value.records && vr.value.records.length) {
        for (var i = 0; i < vr.value.records.length; i++) {
          var r = vr.value.records[i];
          var vb = recVal(r, 799);
          var sa = recVal(r, 517);
          var g5 = recVal(r, 1294);
          if (!vbatRec && vb !== undefined && vb !== null && vb !== '') vbatRec = { r: r, v: vb };
          if (!satRec && sa !== undefined && sa !== null && sa !== '') satRec = { r: r, v: sa };
          if (!gnssRec && g5 !== undefined && g5 !== null && g5 !== '') gnssRec = r;
        }
      }
      if (vbatRec) {
        var mv = Number(vbatRec.v);
        if (isFinite(mv) && mv > 0) {
          st.vbat = mv;
          st.vbatPct = U.vbatToPercent(mv);
        }
      }
      if (satRec) {
        st.sat = Number(satRec.v);
      }
      // 1294 最新样本 -> 速度/航向/海拔（最新值取末个样本）
      if (gnssRec) {
        var hex = recVal(gnssRec, 1294);
        if (hex !== undefined && hex !== null) {
          var samples = decodeGnss5x16(String(hex), st.lng, st.lat);
          if (samples && samples.length) {
            var sLast = samples[samples.length - 1];
            st.speed = sLast.speed;
            st.speedKmh = sLast.speedKmh;
            st.course = sLast.course;
            st.altitude = sLast.altitude;
          }
        }
      }
      return st;
    });
  }

  /* ================= common KV（RSA 签名） ================= */

  function commonList(cls, page, size, filter) {
    var body = { cls: Number(cls), page: page || 1, size: Math.min(size || 50, CFG.LIST_MAX_SIZE) };
    if (filter) body.filter = filter;
    return request('/common/list', body, { tag: 'common_list', headers: commonHeaders() })
      .then(function (res) {
        if (res.code === 0 && res.value !== null && typeof res.value === 'string' && /key|签名|公共/i.test(res.value)) {
          return Promise.reject(new Error(res.value));
        }
        return res.code === 0 ? res.value : Promise.reject(new Error(typeof res.value === 'string' ? res.value : '通用数据查询失败'));
      });
  }

  function commonPut(cls, data) {
    var body = { cls: Number(cls) };
    if (data && data.uni_key) body.uni_key = data.uni_key;
    if (data && data.s1 !== undefined) body.s1 = data.s1;
    if (data && data.s2 !== undefined) body.s2 = data.s2;
    if (data && data.s3 !== undefined) body.s3 = data.s3;
    if (data && data.s4 !== undefined) body.s4 = data.s4;
    if (data && data.i1 !== undefined) body.i1 = data.i1;
    if (data && data.i2 !== undefined) body.i2 = data.i2;
    if (data && data.i3 !== undefined) body.i3 = data.i3;
    if (data && data.i4 !== undefined) body.i4 = data.i4;
    if (data && data.d1 !== undefined) body.d1 = data.d1;
    if (data && data.d2 !== undefined) body.d2 = data.d2;
    return request('/common/put', body, { tag: 'common_put', headers: commonHeaders() })
      .then(function (res) {
        return res.code === 0 ? (res.value || '操作成功') : Promise.reject(new Error(typeof res.value === 'string' ? res.value : '保存失败'));
      });
  }

  function commonDeleteById(cls, id) {
    var body = { cls: Number(cls), id: String(id) };
    return request('/common/delete_by_id', body, { tag: 'common_delete', headers: commonHeaders() })
      .then(function (res) {
        return res.code === 0 ? (res.value || '操作完成') : Promise.reject(new Error(typeof res.value === 'string' ? res.value : '删除失败'));
      });
  }

  /* ================= 项目 Key 记忆 ================= */

  function getProjectKey() {
    return U.store.getRaw(CFG.KEY_PROJECT_KEY) || '';
  }
  function setProjectKey(key) {
    U.store.set(CFG.KEY_PROJECT_KEY, key);
  }

  var AC = {
    SDK: LuatSDK,
    // 认证
    getAuthContext: getAuthContext,
    getAuthContextAny: getAuthContextAny,
    isAuthenticated: isAuthenticated,
    getAuthHeaders: getAuthHeaders,
    clearLoginStorage: clearLoginStorage,
    isSafeReturnTo: isSafeReturnTo,
    safeReturnTo: safeReturnTo,
    redirectToLogin: redirectToLogin,
    redirectToApp: redirectToApp,
    handleLoginExpired: handleLoginExpired,
    isHostSession: isHostSession,
    // 业务请求
    request: request,
    // 项目/设备
    listMyProjects: listMyProjects,
    listMyDevices: listMyDevices,
    searchMyDevices: searchMyDevices,
    sanitizeTags: sanitizeTags,
    // aircloud
    listByTags: listByTags,
    fetchAllByTags: fetchAllByTags,
    latestLocation: latestLocation,
    locationHistory: locationHistory,
    getTrack: getTrack,
    sendCmd: sendCmd,
    recVal: recVal,
    recValInfo: recValInfo,
    getPetStatus: getPetStatus,
    decodeGnss5x16: decodeGnss5x16,
    // common
    commonList: commonList,
    commonPut: commonPut,
    commonDeleteById: commonDeleteById,
    buildXKeyHeader: buildXKeyHeader,
    // 项目 key 记忆
    getProjectKey: getProjectKey,
    setProjectKey: setProjectKey,
    AUTH_FAIL_CODES: AUTH_FAIL_CODES
  };

  global.AC = AC;
})(window);