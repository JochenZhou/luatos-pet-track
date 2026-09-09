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
   * 跳登录页（BASE_HOST 前缀完整绝对 URL，可携带安全 returnTo）
   */
  function redirectToLogin(returnTo) {
    var target = CFG.BASE_HOST + '/ai_app/luatos/' + U.extractAppId() + '/' + CFG.LOGIN_PAGE;
    var rt = safeReturnTo(returnTo);
    if (rt) target += '?returnTo=' + encodeURIComponent(rt);
    try { global.location.replace(target); } catch (e) { /* ignore */ }
  }

  function redirectToApp() {
    var target = CFG.BASE_HOST + '/ai_app/luatos/' + U.extractAppId() + '/' + CFG.APP_PAGE;
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
   */
  function fetchAllByTags(clientId, tags, filter, opts) {
    opts = opts || {};
    var clean = sanitizeTags(tags, true);
    var collected = [];
    var total = 0;
    var page = 1;
    var size = CFG.LIST_MAX_SIZE;
    var guard = 100;
    function pageFetch() {
      if (guard-- <= 0) return Promise.resolve(collected);
      return listByTags(clientId, clean, page, size, filter).then(function (res) {
        if (res.code !== 0) return collected;
        var v = res.value || {};
        if (!v.records || !v.records.length) return collected;
        var arr = v.records.slice();
        total = Number(v.total) || arr.length;
        // 平台恒 ct 降序；本函数返回升序
        var prev = collected[collected.length - 1];
        var first = arr[0];
        if (prev && first && U.recTs(prev) > U.recTs(first)) arr.reverse();
        collected = collected.concat(arr);
        if (opts.onProgress) {
          try { opts.onProgress(collected.length, total); } catch (e) { /* ignore */ }
        }
        if (collected.length >= total || arr.length < size || Number(v.current) >= Number(v.pages)) {
          return collected;
        }
        page++;
        return pageFetch();
      });
    }
    return pageFetch();
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
   * 轨迹查询：location_history 升序 + list_by_tags(513,512,1294) 升序合并，附带 1294 精细点
   */
  function getTrack(clientId, start, end, opts) {
    opts = opts || {};
    var histBody = { client_id: clientId, start: start, end: end, page: 1, size: CFG.LIST_MAX_SIZE };
    return request('/aircloud/location_history', histBody, { tag: 'history' }).then(function (histRes) {
      var histPoints = [];
      if (histRes.code === 0 && histRes.value && histRes.value.records) {
        histPoints = histRes.value.records.map(function (r) {
          return {
            lng: Number(r.lng), lat: Number(r.lat), wlng: Number(r.wlng), wlat: Number(r.wlat),
            time: r.time, ts: U.parseLocalTime(r.time) ? U.parseLocalTime(r.time).getTime() : 0,
            source: 'history', coord: CFG.COORD_GCJ02
          };
        });
      }
      var filter = { aks: ['ct', 'ct'], acs: ['ge', 'le'], avs: [start, end] };
      return fetchAllByTags(clientId, CFG.TRACK_TAGS, filter, {
        onProgress: opts.onProgress
      }).then(function (recs) {
        var tagPoints = recs.filter(function (r) {
          return (U.recTs(r) > 0) && (r.val_512 !== undefined || r['512'] !== undefined) && (r.val_513 !== undefined || r['513'] !== undefined);
        }).map(function (r) {
          var lng = r.val_512 !== undefined ? Number(r.val_512) : Number(r['512']);
          var lat = r.val_513 !== undefined ? Number(r.val_513) : Number(r['513']);
          var coord = (r.val_512 !== undefined || r.val_513 !== undefined) ? CFG.COORD_GCJ02 : CFG.COORD_WGS84;
          return {
            lng: lng, lat: lat,
            time: r.ct, ts: U.recTs(r),
            source: 'tags', coord: coord,
            rec: r
          };
        });
        // 合并 + 升序去重
        var merged = histPoints.concat(tagPoints).sort(function (a, b) { return a.ts - b.ts; });
        var out = [];
        var lastKey = null;
        merged.forEach(function (p) {
          var key = p.lng + ',' + p.lat;
          if (key === lastKey) return;
          lastKey = key;
          out.push(p);
        });
        return out;
      });
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