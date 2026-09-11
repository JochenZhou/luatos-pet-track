/**
 * smoke-test.js —— 结构级冒烟测试（stub fetch，110+ 项）
 * 运行：node smoke-test.js
 * 断言：URL 网关路径 / 三鉴权头无 Bearer / Content-Type / 未登录不发请求 /
 *       102 失效清键跳 login / tags 透传 sanitize / recTs 本地钟面恒等 /
 *       tagById(799) 电压 / 轨迹抽稀 / 围栏 GCJ02 判定 / 坐标转换 /
 *       1294 精细点展开 / 主题预设 CSS↔JS 一致性 / 报警推送通道与去重 / …
 */
'use strict';

/* ---------- 浏览器环境 stub ---------- */
const storeMap = {};
const localStorageStub = {
  getItem: (k) => (k in storeMap ? storeMap[k] : null),
  setItem: (k, v) => { storeMap[k] = String(v); },
  removeItem: (k) => { delete storeMap[k]; },
  key: (i) => Object.keys(storeMap)[i] || null,
  get length() { return Object.keys(storeMap).length; }
};
const sessionStorageStub = { _m: {}, getItem(k) { return this._m[k] || null; }, setItem(k, v) { this._m[k] = v; }, removeItem(k) { delete this._m[k]; } };

let fetchCalls = [];
let fetchImpl = null;
global.localStorage = localStorageStub;
global.sessionStorage = sessionStorageStub;
global.fetch = function (url, opts) {
  fetchCalls.push({ url, opts });
  if (fetchImpl) return fetchImpl(url, opts);
  return Promise.resolve({ text: () => Promise.resolve('{"code":0,"value":{}}') });
};
global.location = { href: 'https://iot.luatos.com/ai_app/luatos/test11/index.html', replace() {}, origin: 'https://iot.luatos.com' };
global.history = { replaceState() {} };
global.window = global;
// document 需要撑到「主题要落 data-* 属性」「推送要判 document.hidden」这两件事
global.document = {
  addEventListener() {},
  readyState: 'complete',
  getElementById: () => null,
  querySelector: () => null,
  querySelectorAll: () => [],
  body: { contains: () => true, appendChild() {} },
  documentElement: {
    _a: {},
    setAttribute(k, v) { this._a[k] = String(v); },
    getAttribute(k) { return this._a[k] || null; }
  },
  hidden: false,
  createElement: () => ({
    style: {}, classList: { add() {}, remove() {}, contains: () => false },
    addEventListener() {}, appendChild() {}, setAttribute() {},
    querySelector: () => null, querySelectorAll: () => []
  })
};
// cssVar 走 getComputedStyle 取色，这里给两个已知变量
global.getComputedStyle = () => ({
  getPropertyValue: (n) => ({ '--brand-600': '#0D9488', '--bg': '#F5F7FB', '--logo': "url(\"data:image/png;base64,AAA\")" }[n] || '')
});

// 加载源码（顺序与构建一致）
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const files = [
  'js/config.js', 'js/utils.js', 'js/theme.js', 'js/pet-store.js', 'js/fence.js', 'js/loc-cache.js', 'js/push.js',
  'js/algo/wgs2gcj.js', 'js/algo/imufilter.js', 'js/algo/stepcount.js',
  'js/algo/attitude.js', 'js/algo/alg.js',
  'js/api/rsa-pkcs1.js', 'js/api/aircloud.js'
];
files.forEach(f => {
  const code = fs.readFileSync(path.join(ROOT, f), 'utf8');
  new Function(code)(); // window=global
});

/* ---------- 断言框架 ---------- */
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); }
}
function eq(a, b, name) { ok(JSON.stringify(a) === JSON.stringify(b), name + ' (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }

const CFG = global.CFG, U = global.Utils, AC = global.AC, Algo = global.Algo, FenceStore = global.FenceStore, PetStore = global.PetStore;
const Theme = global.Theme, Push = global.Push, LocCache = global.LocCache;

/* ================= 认证与请求层 ================= */

// 1-4 网关与域名
ok(CFG.API_BASE === 'https://api-iot.luatos.com/iot/open_api', 'T1 网关地址');
ok(CFG.OAUTH_URL.indexOf('https://api-iot.luatos.com/') === 0, 'T2 OAuth 域名');
ok(CFG.BASE_HOST === 'https://iot.luatos.com', 'T3 页面域名');
ok(CFG.API_HOST === 'https://api-iot.luatos.com', 'T4 API 域名');

// 5 未登录不发请求
fetchCalls = [];
const unauthCalls = fetchCalls;
const unauthP = AC.listMyProjects().then(r => {
  ok(r.code === -101, 'T5 未登录返回 -101');
  ok(unauthCalls.length === 0, 'T6 未登录不发请求');
});

// 7-10 登录态注入头
storeMap['my_auth'] = JSON.stringify({ token: 'TK123', salt: 'SALT' });
storeMap['my_service'] = JSON.stringify({ sid: 'SID9' });
fetchCalls = [];
return AC.request('/list_my_projects', {}).then(r => {
  const h = fetchCalls[0].opts.headers;
  ok(h.authorization === 'TK123', 'T7 authorization 无 Bearer 前缀');
  ok(h.salt === 'SALT', 'T8 salt 头');
  ok(h.sid === 'SID9', 'T9 sid 头');
  ok(fetchCalls[0].opts.headers['Content-Type'] === 'application/json', 'T10 Content-Type JSON');

  // 11 请求 URL
  ok(fetchCalls[0].url === 'https://api-iot.luatos.com/iot/open_api/list_my_projects', 'T11 网关路径拼接');

  // 12-13 失效码
  fetchImpl = () => Promise.resolve({ text: () => Promise.resolve('{"code":102}') });
  return AC.request('/list_my_projects', {});
}).then(r => {
  ok(r.code === -100, 'T12 code102 -> -100');
  ok(!storeMap['my_auth'], 'T13 失效清 my_auth');

  // 重新登录
  storeMap['my_auth'] = JSON.stringify({ token: 'TK123', salt: 'SALT' });
  storeMap['my_service'] = JSON.stringify({ sid: 'SID9' });
  fetchImpl = () => Promise.resolve({ text: () => Promise.resolve('{"code":103}') });
  return AC.request('/x', {});
}).then(r => {
  ok(r.code === -100, 'T14 code103 失效');
  storeMap['my_auth'] = JSON.stringify({ token: 'TK2', salt: 'S2' });
  storeMap['my_service'] = JSON.stringify({ sid: 'SID2' });
  fetchImpl = () => Promise.resolve({ text: () => Promise.resolve('{"code":105}') });
  return AC.request('/x', {});
}).then(r => {
  ok(r.code === -100, 'T15 code105 失效');

  // 16 网络异常永不 reject
  storeMap['my_auth'] = JSON.stringify({ token: 'TK3', salt: 'S3' });
  storeMap['my_service'] = JSON.stringify({ sid: 'SID3' });
  fetchImpl = () => Promise.reject({ type: 'network' });
  return AC.request('/x', {});
}).then(r => {
  ok(r.code === -102, 'T16 网络异常 -> -102');
  fetchImpl = () => new Promise(() => { throw new Error('timeout'); });
  return AC.request('/x', {});
}).then(r => {
  ok(r.code === -102, 'T17 异常不 reject');

  /* ================= sanitizeTags / recVal ================= */
  const clean = AC.sanitizeTags([513, 512, 999, '799'], false);
  eq(clean, [513, 512, 799], 'T18 sanitizeTags 官方过滤');
  const clean2 = AC.sanitizeTags([1293, 513], false);
  eq(clean2, [513], 'T19 私有 tag 默认拦截');
  const clean3 = AC.sanitizeTags([1293], true);
  eq(clean3, [1293], 'T20 allowCustom 放行私有');
  const rec = { val_799: '3900', '512': 104.5, val_513: 30.6 };
  ok(AC.recVal(rec, 799) === '3900', 'T21 recVal val_ 优先');
  ok(AC.recVal(rec, 512) === 104.5, 'T22 recVal 数字 key 回退');
  const info = AC.recValInfo(rec, 512, 513);
  ok(info.coord === 'gcj02', 'T23 val_ 坐标源 GCJ02');
  const info2 = AC.recValInfo({ '512': 1, '513': 2 }, 512, 513);
  ok(info2.coord === 'wgs84', 'T24 数字 key 坐标源 WGS84');

  /* ================= 时间（v48 本地钟面） ================= */
  const ts = U.parseLocalTime('2026-09-08 18:53:54').getTime();
  const back = U.fmtFull(ts);
  ok(back === '2026-09-08 18:53:54', 'T25 recTs/fmt 本地钟面 roundtrip 恒等');
  const ts2 = U.recTs({ ct: '2026-09-08 18:53:54' });
  ok(new Date(ts2).getHours() === 18, 'T26 ct 解析钟面小时');
  const ts3 = U.recTs({ batch_time: 1757330434000, ct: '2026-09-08 18:53:54' });
  ok(ts3 === 1757330434000, 'T27 batch_time 优先');
  ok(U.timeAgo(Date.now() - 35000) === '35 秒前', 'T28 timeAgo 秒');
  ok(U.timeAgo(Date.now() - 7200000) === '2 小时前', 'T29 timeAgo 时');

  /* ================= 电压/信号 ================= */
  ok(U.vbatToPercent(4200) === 100, 'T30 vbat 4200=100%');
  ok(U.vbatToPercent(3600) === 50, 'T31 vbat 3600=50%');
  ok(U.vbatToPercent(3000) === 0, 'T32 vbat 3000=0%');
  ok(U.vbatToPercent(9999) === 100, 'T33 vbat 越界钳制');
  ok(U.signalText(5) === '弱', 'T34 信号弱');
  ok(U.signalText(15) === '一般', 'T35 信号一般');
  ok(U.signalText(30) === '强', 'T36 信号强');
  ok(U.maskPhone('18101796680') === '181****6680', 'T37 手机脱敏');

  /* ================= returnTo 安全 ================= */
  ok(AC.isSafeReturnTo('/index.html'), 'T38 安全 returnTo');
  ok(!AC.isSafeReturnTo('javascript:alert(1)'), 'T39 协议拦截');
  ok(!AC.isSafeReturnTo('//evil.com'), 'T40 协议相对拦截');
  ok(!AC.isSafeReturnTo('https://evil.com'), 'T41 绝对外域拦截');
  ok(!AC.isSafeReturnTo('/x?token=abc'), 'T42 敏感参数拦截');
  ok(!AC.isSafeReturnTo(''), 'T43 空拦截');

  /* ================= 坐标转换 ================= */
  const gcj = Algo.wgs84ToGcj02(104.06, 30.66);
  ok(Math.abs(gcj[0] - 104.06) < 0.01 && gcj[0] !== 104.06, 'T44 WGS->GCJ 经度偏移');
  ok(Math.abs(gcj[1] - 30.66) < 0.01, 'T45 WGS->GCJ 纬度偏移幅度');
  const back2 = Algo.gcj02ToWgs84(gcj[0], gcj[1]);
  ok(Math.abs(back2[0] - 104.06) < 0.0005, 'T46 GCJ->WGS 反算近似');
  const noMove = Algo.wgs84ToGcj02(-0.12, 51.5);
  ok(noMove[0] === -0.12 && noMove[1] === 51.5, 'T47 境外不偏移');
  ok(Algo.isInChina(104, 30) === true, 'T48 中国框内');
  ok(Algo.isInChina(-74, 40) === false, 'T49 中国框外');

  /* ================= 围栏判定 ================= */
  const fCircle = { kind: 'circle', center: [104.06, 30.66], radius: 500 };
  ok(FenceStore.isPointInFence([104.0601, 30.6601], fCircle), 'T50 圆内判定');
  ok(!FenceStore.isPointInFence([104.10, 30.70], fCircle), 'T51 圆外判定');
  const fPoly = { kind: 'polygon', points: [[104.05, 30.65], [104.07, 30.65], [104.07, 30.67], [104.05, 30.67]] };
  ok(FenceStore.isPointInFence([104.06, 30.66], fPoly), 'T52 多边形内');
  ok(!FenceStore.isPointInFence([104.09, 30.66], fPoly), 'T53 多边形外');

  /* ================= 1294 GNSS 解包 ================= */
  // 构造：经度差+100(1e-7°=0.00001)、纬度差+50、速度15(1.5m/s)、航向900(90°)、海拔50
  function i16(v) { return [(v >> 8) & 0xFF, v & 0xFF]; }
  const bytes = [].concat(i16(100), i16(50), i16(15), i16(900), i16(50));
  const hex = bytes.map(b => b.toString(16).padStart(2, '0')).join('');
  const samps = AC.decodeGnss5x16(hex, 104.0, 30.0);
  ok(samps.length === 1, 'T54 1294 样本数');
  ok(Math.abs(samps[0].lng - 104.00001) < 1e-9, 'T55 1294 经度差分');
  ok(Math.abs(samps[0].lat - 30.000005) < 1e-9, 'T56 1294 纬度差分');
  ok(samps[0].speed === 1.5, 'T57 1294 速度');
  ok(samps[0].course === 90, 'T58 1294 航向');
  ok(samps[0].altitude === 50, 'T59 1294 海拔');

  /* ================= 计步/姿态/跌倒 ================= */
  // 模拟 20Hz 10 秒：每秒 2 步（正弦冲击）
  const walk = [];
  for (let i = 0; i < 200; i++) {
    const ph = (i % 10) / 10;
    const m = 1 + (ph < 0.5 ? Math.sin(ph * Math.PI * 2) * 0.4 : 0);
    walk.push({ x: 0, y: 0, z: m, t: i * 50 });
  }
  const stepsR = Algo.countSteps(walk, { sampleRate: 20 });
  ok(stepsR.steps >= 15 && stepsR.steps <= 25, 'T60 计步 20 步附近 (got ' + stepsR.steps + ')');
  const att = Algo.estimateAttitude({ x: 0, y: 0, z: 1 });
  ok(att.roll === 0 && att.pitch === 0, 'T61 静止姿态');
  // 跌倒：冲击 + 静止
  const fallSeq = [];
  for (let i = 0; i < 60; i++) {
    let m = 1;
    if (i >= 20 && i < 24) m = 4.5;   // 冲击
    if (i >= 30) m = 1.02;            // 静止躺
    fallSeq.push({ x: 0, y: 0, z: m, t: i * 50 });
  }
  const fallR = Algo.detectFall(fallSeq, { sampleRate: 20 });
  ok(fallR.fall === true, 'T62 跌倒检测命中');
  const noFall = Algo.detectFall(walk, { sampleRate: 20 });
  ok(noFall.fall === false, 'T63 正常行走无误报');

  /* ================= PetStore ================= */
  const p1 = PetStore.getOrCreate('861234567890123');
  ok(p1.name === '未命名设备', 'T64 自动建档未命名');
  ok(U.esc('<b>&"\'') === '&lt;b&gt;&amp;&quot;&#39;', 'T65 esc 转义');

  /* ================= 轨迹精细度：1294 逐包展开 ================= */
  // 构造 10 个 10B 样本的一包 1294（dlng=+100、dlat=+50、speed=15、course=900、alt=50）
  const pkt = [];
  for (let i = 0; i < 10; i++) {
    pkt.push(...i16(100), ...i16(50), ...i16(15), ...i16(900), ...i16(50));
  }
  const gnssHex = pkt.map(b => b.toString(16).padStart(2, '0')).join('');
  ok(gnssHex.length === 200, 'T66 1294 报文长度 100B/10 样本');

  storeMap['my_auth'] = JSON.stringify({ token: 'TK9', salt: 'S9' });
  storeMap['my_service'] = JSON.stringify({ sid: 'SID9' });
  fetchImpl = (url) => {
    if (url.indexOf('location_history') >= 0) {
      return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({
        code: 0, value: { total: '1', records: [{ lng: 104.0, lat: 30.0, time: '2026-09-10 10:00:00' }] }
      })) });
    }
    return Promise.resolve({ text: () => Promise.resolve(JSON.stringify({
      code: 0, value: {
        total: '1', current: 1, pages: 1,
        records: [{ ct: '2026-09-10 10:00:00', val_512: 104.0, val_513: 30.0, val_1294: gnssHex }]
      }
    })) });
  };
  /* ---------- 结果汇总 ---------- */
  function summarize() {
    console.log('');
    console.log('======== 冒烟测试 ========');
    console.log('通过: ' + pass + ' / ' + (pass + fail));
    if (fail > 0) {
      console.log('失败项：');
      failures.forEach(f => console.log('  ✗ ' + f));
      process.exit(1);
    } else {
      console.log('全部通过 ✓');
    }
  }

  /* ---------- 并行翻页 / 阶段进度（多页 stub） ----------
     请求数不变、只是不再排队等，所以这里同时验「页数全取到」和「在途峰值 > 1」。 */
  function parallelChecks() {
    storeMap['my_auth'] = JSON.stringify({ token: 'TK9', salt: 'S9' });
    storeMap['my_service'] = JSON.stringify({ sid: 'SID9' });

    let inflight = 0, peak = 0;
    const calls = [];
    fetchImpl = (url, opts) => {
      const body = JSON.parse((opts && opts.body) || '{}');
      const isHist = url.indexOf('location_history') >= 0;
      const page = Number(body.page) || 1;
      const size = Number(body.size) || 100;
      calls.push((isHist ? 'h' : 't') + page);
      inflight++;
      if (inflight > peak) peak = inflight;
      const total = 500;
      const n = Math.max(0, Math.min(size, total - (page - 1) * size));
      const records = [];
      for (let i = 0; i < n; i++) {
        const k = (page - 1) * size + i;
        const t = '2026-09-10 00:' + String(Math.floor(k / 60) % 60).padStart(2, '0') + ':' + String(k % 60).padStart(2, '0');
        records.push(isHist
          ? { lng: 104.0 + k * 1e-5, lat: 30.0 + k * 1e-5, time: t }
          : { ct: t, val_512: 104.0 + k * 1e-5, val_513: 30.0 + k * 1e-5 });
      }
      return new Promise(resolve => {
        setTimeout(() => {
          inflight--;
          resolve({
            text: () => Promise.resolve(JSON.stringify({
              code: 0,
              value: { total: String(total), current: page, pages: Math.ceil(total / size), records }
            }))
          });
        }, 25);
      });
    };

    const seen = [];
    const filter = { aks: ['ct', 'ct'], acs: ['ge', 'le'], avs: ['2026-09-10 00:00:00', '2026-09-10 23:59:59'] };
    function timedTags(conc) {
      const t0 = Date.now();
      return AC.fetchAllByTags('861234567890123', [513], filter, { concurrency: conc })
        .then(() => Date.now() - t0);
    }

    return AC.getTrack('861234567890123', '2026-09-10 00:00:00', '2026-09-10 23:59:59', {
      onProgress: (n, total, info) => { if (info) seen.push(info); }
    }).then(pts => {
      const h = calls.filter(c => c[0] === 'h');
      const t = calls.filter(c => c[0] === 't');
      ok(h.length === 5, 'T139 location_history 5 页全部取到 (got ' + h.length + ')');
      ok(t.length === 5, 'T140 list_by_tags 5 页全部取到 (got ' + t.length + ')');
      ok(peak >= 3, 'T141 翻页确实并发（在途峰值 ' + peak + '）—— 串行实现峰值恒为 1');
      const phases = [...new Set(seen.map(s => s.phase))].sort();
      ok(phases.indexOf('history') >= 0 && phases.indexOf('tags') >= 0,
        'T142 进度回调覆盖 history 与 tags 两阶段 [' + phases.join(',') + ']');
      let mono = seen.length > 0;
      for (let i = 1; i < seen.length; i++) if (seen[i].pct < seen[i - 1].pct - 0.01) mono = false;
      ok(mono && seen[seen.length - 1].pct === 100,
        'T143 总进度单调不减且收尾 100%（' + seen.length + ' 次回调）');
      ok(pts.length > 0 && typeof pts.removedOutliers === 'number',
        'T144 getTrack 返回带 removedOutliers（已剔除异常点数=' + pts.removedOutliers + '）');

      // 耗时对照：同样 5 页、每页固定 25ms，串行要等 5 个往返，并发只要 2 个
      return timedTags(1).then(tSerial => timedTags(4).then(tConc => {
        ok(tConc < tSerial * 0.75,
          'T145 同样 5 页：并发 ' + tConc + 'ms < 串行 ' + tSerial + 'ms（≤75%）');
      }));
    });
  }

  return AC.getTrack('861234567890123', '2026-09-10 00:00:00', '2026-09-10 23:59:59', {}).then(pts => {
    const gnss = pts.filter(p => p.source === 'gnss');
    ok(gnss.length === 10, 'T67 1294 展开为 10 个精细点 (got ' + gnss.length + ')');
    ok(pts.length === 11, 'T68 轨迹总点数 = 历史 1 + 精细 10 (got ' + pts.length + ')');
    ok(Math.abs(gnss[0].lng - 104.00001) < 1e-9, 'T69 首个精细点经度差分解算正确');
    ok(gnss.every(p => p.coord === 'gcj02'), 'T70 精细点坐标标记 GCJ02');
    ok(gnss[0].ts > 0 && gnss[9].ts > gnss[0].ts, 'T71 精细点时间递增，排序稳定');

    /* ================= 主题（配色 + 明暗） ================= */

    // CSS 与 JS 的预设必须一一对应：只改一边会「选得中、样式不生效」
    const cssText = fs.readFileSync(path.join(ROOT, 'css/style.css'), 'utf8');
    const cssKeys = (cssText.match(/\[data-accent="\w+"\]/g) || [])
      .map(m => m.match(/"(\w+)"/)[1]);
    const jsKeys = Theme.PRESETS.map(p => p.key);
    ok(cssKeys.length === jsKeys.length && jsKeys.every(k => cssKeys.indexOf(k) >= 0),
      'T72 CSS 与 theme.js 的配色预设一一对应 (css=' + cssKeys.length + ' js=' + jsKeys.length + ')');

    // 每个预设必须自带完整色阶，且 600（主色）与 theme.js 的 swatch 相同。
    // 漏 --brand-600 会退化成「只有浅色底变了、主色还是默认靛蓝」= 主题看着没生效。
    let stepBad = [], swatchBad = [];
    Theme.PRESETS.forEach(p => {
      const m = cssText.match(new RegExp('\\[data-accent="' + p.key + '"\\] \\{([\\s\\S]*?)\\n\\}'));
      if (!m) { stepBad.push(p.key + ':缺块'); return; }
      const body = m[1];
      ['50', '100', '200', '300', '400', '500', '600', '700', '800'].forEach(n => {
        if (body.indexOf('--brand-' + n + ':') < 0) stepBad.push(p.key + ':' + n);
      });
      const six = body.match(/--brand-600:\s*([^;]+);/);
      if (!six || six[1].trim().toUpperCase() !== p.swatch.toUpperCase()) {
        swatchBad.push(p.key + '(' + (six ? six[1].trim() : '无') + '≠' + p.swatch + ')');
      }
    });
    ok(stepBad.length === 0, 'T73 每套配色色阶齐备 50~800' + (stepBad.length ? ' 缺:' + stepBad.join(',') : ''));
    ok(swatchBad.length === 0, 'T74 预设主色 brand-600 与选择器色块一致' + (swatchBad.length ? ' 差异:' + swatchBad.join(' ') : ''));

    Theme.setAccent('teal');
    ok(Theme.accent() === 'teal' && localStorageStub.getItem('pt_accent') === 'teal',
      'T75 setAccent 写入 localStorage');
    ok(document.documentElement.getAttribute('data-accent') === 'teal',
      'T76 setAccent 落到 <html data-accent>');
    Theme.setAccent('不存在的配色');
    ok(Theme.accent() === Theme.DEFAULT_ACCENT, 'T77 非法配色回落默认');

    Theme.setMode('dark');
    ok(document.documentElement.getAttribute('data-theme') === 'dark' && Theme.mode() === 'dark',
      'T78 setMode 落盘 data-theme=dark');
    ok(Theme.toggleMode() === 'light' && Theme.mode() === 'light', 'T79 toggleMode 往返正常');
    Theme.setMode('乱填');
    ok(Theme.mode() === Theme.DEFAULT_MODE, 'T80 非法明暗值回落默认');

    ok(Theme.cssVar('--brand-600', '#000') === '#0D9488', 'T81 cssVar 读到当前主题主色');
    ok(Theme.cssVar('--not-exist', '#ABCDEF') === '#ABCDEF', 'T82 cssVar 取不到时用兜底值');

    // 防闪脚本必须与 theme.js 用同一批存储键，否则会先闪一帧默认配色
    const tplText = fs.readFileSync(path.join(ROOT, 'index.tpl.html'), 'utf8');
    ok(tplText.indexOf("getItem('pt_accent')") > 0 && tplText.indexOf("getItem('pt_theme_mode')") > 0,
      'T83 index.tpl.html 防闪脚本读同一批主题键');
    ok(CFG.KEY_ACCENT === 'pt_accent' && CFG.KEY_THEME_MODE === 'pt_theme_mode' && CFG.KEY_PUSH === 'pt_push',
      'T84 主题/推送存储键与防闪脚本一致');

    /* ================= 报警消息推送 ================= */

    const nativeCalls = [];
    delete global.AndroidBridge;
    Push.setEnabled(false);
    ok(Push.supported().native === false, 'T85 无 AndroidBridge 时原生通道不可用');
    ok(Push.channelName().indexOf('应用内') >= 0, 'T86 无系统通道时回落到应用内提示');

    global.AndroidBridge = {
      notify(t, b, h) { nativeCalls.push({ t: t, b: b, h: h }); },
      requestNotifyPermission() { nativeCalls.push({ perm: true }); }
    };
    Push._reset();
    ok(Push.supported().native === true, 'T87 有 AndroidBridge.notify 时原生通道可用');
    ok(Push.channelName().indexOf('原生') >= 0, 'T88 通道名显示 APP 原生通知');

    Push.setEnabled(false);
    ok(Push.enabled() === false, 'T89 推送默认关闭（需用户显式开启）');
    Push.setEnabled(true);
    ok(Push.enabled() === true && localStorageStub.getItem('pt_push') === '1', 'T90 开启开关写 pt_push=1');

    Push.setEnabled(false);
    ok(Push.alarm({ imei: '861', fenceId: 'f1', lng: 1, lat: 2 }, { name: '家' }, '布丁') === 'off',
      'T91 开关关闭时不推送');

    Push.setEnabled(true);
    Push._reset();
    nativeCalls.length = 0;
    document.hidden = false;
    ok(Push.alarm({ imei: '861', fenceId: 'f1', lng: 1, lat: 2 }, { name: '家' }, '布丁') === 'foreground',
      'T92 页面在前台时只走应用内提示');
    ok(nativeCalls.length === 0, 'T93 前台不产生系统通知（不重复打扰）');

    document.hidden = true;
    Push._reset();
    nativeCalls.length = 0;
    const rPush = Push.alarm(
      { imei: '862', fenceId: 'f2', lng: 3, lat: 4, address: '成都市' }, { name: '公司' }, '布丁');
    ok(rPush === 'native' && nativeCalls.length === 1, 'T94 后台越界走原生通知');
    ok(nativeCalls[0] && nativeCalls[0].t.indexOf('越界') >= 0 &&
      nativeCalls[0].b.indexOf('公司') >= 0 && nativeCalls[0].b.indexOf('布丁') >= 0 &&
      nativeCalls[0].b.indexOf('成都市') >= 0,
      'T95 通知文案含围栏/设备/地址');
    ok(nativeCalls[0] && nativeCalls[0].h === '#/alerts', 'T96 通知带跳转 hash #/alerts');

    ok(Push.alarm({ imei: '862', fenceId: 'f2', lng: 3, lat: 4 }, { name: '公司' }, '布丁') === 'dup' &&
      nativeCalls.length === 1, 'T97 同一设备+围栏去重，不刷屏');

    // 未命名设备只写「未命名设备」的话，通知栏里认不出是哪一台 —— 必须带 IMEI 尾号
    // （放在去重用例之后，避免 _reset() 把去重表清掉导致 T97 失效）
    Push._reset();
    nativeCalls.length = 0;
    Push.alarm({ imei: '861234567890999', fenceId: 'f9', lng: 1, lat: 2 },
      { name: '公司' }, CFG.DEV_PLACEHOLDER_NAME);
    ok(nativeCalls[0] && nativeCalls[0].b.indexOf('尾号890999') >= 0,
      'T97b 未命名设备的通知带 IMEI 尾号 (got ' + (nativeCalls[0] ? nativeCalls[0].b : '-') + ')');

    global.AndroidBridge = { notify() { throw new Error('boom'); } };
    Push._reset();
    ok(Push.alarm({ imei: '863', fenceId: 'f3', lng: 5, lat: 6 }, { name: '公园' }, '布丁') === 'none',
      'T98 原生桥异常时降级为 none，不把异常抛给调用方');

    global.AndroidBridge = { notify(t, b, h) { nativeCalls.push({ t: t, b: b, h: h }); } };
    nativeCalls.length = 0;
    Push.setEnabled(false);
    ok(Push.test() === 'native' && nativeCalls.length === 1, 'T99 测试推送不受开关限制');
    ok(typeof Push.requestPermission === 'function', 'T100 提供授权申请入口');
    document.hidden = false;
    Push._reset();

    /* ================= 定位缓存（LocCache） ================= */

    LocCache.clear();
    ok(!LocCache.get('860000000000001'), 'T101 无缓存返回 null');
    ok(LocCache.put({ imei: '860000000000001', lng: 104.1, lat: 30.5, ts: 1000, name: '布丁', _cached: false }) === true,
      'T102 put 有效定位成功');
    const c1 = LocCache.get('860000000000001');
    ok(c1 && c1.lng === 104.1 && c1.lat === 30.5, 'T103 get 取回缓存定位');
    ok(c1 && c1._cached === undefined, 'T104 渲染标记 _cached 不落盘');
    ok(LocCache.put({ imei: '860000000000001', lng: 104.2, lat: 30.6, ts: 500 }) === false,
      'T105 ts 更旧的状态不覆盖新缓存');
    ok(LocCache.get('860000000000001').lng === 104.1, 'T106 旧包不回退定位');
    ok(LocCache.put({ imei: '860000000000001', lng: 104.3, lat: 30.7, ts: 2000 }) === true &&
       LocCache.get('860000000000001').lng === 104.3, 'T107 ts 更新的状态正常覆盖');
    ok(LocCache.put({ imei: '860000000000002' }) === false &&
       !LocCache.get('860000000000002'), 'T108 无经纬度不缓存（防「暂无定位」缓存假象）');
    for (let i = 0; i < 55; i++) {
      LocCache.put({ imei: 'bulk' + i, lng: 104 + i * 0.01, lat: 30, ts: 3000 + i });
    }
    const bulkKeys = Object.keys(JSON.parse(storeMap['pt_loc_cache']));
    ok(bulkKeys.length <= 50, 'T109 缓存条目有上限淘汰 (got ' + bulkKeys.length + ')');
    // 上限淘汰按 t 从旧到新删：最早的 bulk0..4 与更早的测试条目已被淘汰，最新的必须还在
    ok(!!LocCache.get('bulk54') && !!LocCache.get('bulk53'), 'T110 淘汰只删最旧、保留最新');
    LocCache.drop('bulk54');
    ok(!LocCache.get('bulk54') && !!LocCache.get('bulk53'), 'T111 drop 单台清除');
    LocCache.clear();
    ok(storeMap['pt_loc_cache'] === undefined, 'T112 clear 清空缓存');
    ok(CFG.KEY_LOC_CACHE === 'pt_loc_cache', 'T113 定位缓存存储键');
    ok(LocCache.hasValidLoc({ lng: NaN, lat: 30 }) === false, 'T114 非法坐标判无效');

    /* ================= 围栏指定生效设备 ================= */

    const fT = FenceStore.add({ kind: 'circle', name: '家', center: [104, 30], radius: 200, imeis: ['861', '862'] });
    ok(FenceStore.get(fT.id) && FenceStore.get(fT.id).imeis.join(',') === '861,862',
      'T115 围栏 imeis 字段落盘');
    ok(FenceStore.targetsImei(fT, '861') && FenceStore.targetsImei(fT, 862) === true,
      'T116a 指定围栏命中列表内设备（数字 imei 兼容）');
    ok(!FenceStore.targetsImei(fT, '863'), 'T116b 指定围栏不命中列表外设备');
    const fAll = FenceStore.add({ kind: 'circle', name: '旧围栏', center: [104, 30], radius: 200 });
    ok(FenceStore.targetsImei(fAll, 'anything'), 'T117 无 imeis 的旧围栏对全部设备生效（向后兼容）');
    FenceStore.remove(fT.id); FenceStore.remove(fAll.id);

    /* ================= 登录页 / APP 侧边栏 跟随主题色 ================= */

    // 登录页 :root 的品牌色必须与 css/style.css 的默认（合宙青）一致。
    // 这里曾经脱节：业务页默认早换成合宙青，登录页还留着旧「极光靛蓝」，
    // 于是就出现「登录按钮一直是蓝的」——用断言钉死，别再犯。
    const loginText = fs.readFileSync(path.join(ROOT, 'login.html'), 'utf8');
    const defaultRoot = cssText.match(/:root \{([\s\S]*?)\n\}/)[1];
    const loginRootM = loginText.match(/:root \{([\s\S]*?)\n {4}\}/);
    const loginRoot = loginRootM ? loginRootM[1] : '';
    const pick = (text, name) => {
      const m = text.match(new RegExp('--' + name + '\\s*:\\s*([^;]+);'));
      return m ? m[1].trim().toUpperCase() : null;
    };
    const loginBad = ['brand-500', 'brand-600', 'brand-700']
      .filter(n => pick(loginRoot, n) !== pick(defaultRoot, n));
    ok(loginBad.length === 0 && pick(loginRoot, 'brand-600') === '#0D9488',
      'T118 登录页品牌色与业务页默认（合宙青）一致'
      + (loginBad.length ? ' 差异:' + loginBad.join(',') : ''));

    // 登录按钮必须是业务页主按钮同一套双档渐变。
    // 早先末端还接 --aurora-500，合宙青下末端偏天蓝，看着仍像「蓝按钮」。
    ok(/\.btn-login \{[\s\S]*?linear-gradient\(135deg, var\(--brand-600\), var\(--brand-500\)\)/
      .test(loginText),
      'T119 登录按钮渐变为品牌双档 brand-600 → brand-500');

    // APP 侧边栏头部/进度条由 MainActivity 的 ACCENTS 表驱动（原生拿不到 CSS 变量）。
    // 这张表是配色的第 3 份副本，必须与 CSS 预设逐项一致，否则又会出现
    // 「网页变了青、APP 侧栏还是靛蓝」。
    const javaText = fs.readFileSync(path.join(ROOT,
      'android/app/src/main/java/com/jochen/luatos_pet_track/MainActivity.java'), 'utf8');
    const javaKeys = (javaText.match(/\{"(\w+)",\s*"#/g) || [])
      .map(s => s.match(/"(\w+)"/)[1]);
    ok(Theme.PRESETS.length === javaKeys.length
      && Theme.PRESETS.every(p => javaKeys.indexOf(p.key) >= 0),
      'T120 APP 侧边栏配色表键与 theme.js 预设一一对应 (java=' + javaKeys.length + ')');

    const javaRows = (javaText.match(
      /\{"\w+",\s*"#\w{6}",\s*"#\w{6}",\s*"#\w{6}",\s*"#\w{6}",\s*"#\w{6}"\}/g) || [])
      .map(r => r.match(/"#\w{6}"/g).map(s => s.replace(/"/g, '').toUpperCase()));
    const paletteBad = [];
    Theme.PRESETS.forEach(p => {
      const i = javaKeys.indexOf(p.key);
      if (i < 0 || !javaRows[i]) { paletteBad.push(p.key + ':缺行'); return; }
      const bodyM = cssText.match(new RegExp('\\[data-accent="' + p.key + '"\\] \\{([\\s\\S]*?)\\n\\}'));
      const body = bodyM ? bodyM[1] : '';
      // 顺序与 Java 侧数组一致：700 / 600 / 100 / 50 / aurora-500
      ['brand-700', 'brand-600', 'brand-100', 'brand-50', 'aurora-500'].forEach((n, j) => {
        const want = pick(body, n);
        if (want !== javaRows[i][j]) {
          paletteBad.push(p.key + '.' + n + '(' + javaRows[i][j] + '≠' + want + ')');
        }
      });
    });
    ok(paletteBad.length === 0,
      'T121 APP 侧边栏配色表与 CSS 预设逐色一致'
      + (paletteBad.length ? ' 差异:' + paletteBad.join(' ') : ''));

    // 网页端切配色必须通知原生，否则侧边栏不会变
    const themeText = fs.readFileSync(path.join(ROOT, 'js/theme.js'), 'utf8');
    ok(themeText.indexOf('syncNativeAccent(accent())') > 0
      && /AndroidBridge[\s\S]{0,80}setAccent/.test(themeText)
      && themeText.indexOf('syncNativeAccent: syncNativeAccent') > 0,
      'T122 theme.js 切换配色时通知 AndroidBridge.setAccent');
    const layoutText = fs.readFileSync(path.join(ROOT,
      'android/app/src/main/res/layout/activity_main.xml'), 'utf8');
    ok(layoutText.indexOf('@+id/drawer_header') > 0
      && javaText.indexOf('public void setAccent(String key)') > 0
      && javaText.indexOf('applyAccent(savedAccent())') > 0,
      'T123 侧边栏头部有 id，且桥方法/启动同步齐备');

    /* ================= 设备列表增量渲染 + 请求失败保留旧数据 ================= */
    const viewsText = fs.readFileSync(path.join(ROOT, 'js/app/views.js'), 'utf8');
    // 卡片列表必须按 imei 增量更新：整表 innerHTML 重建会让毛玻璃(backdrop-filter)
    // 合成层反复销毁重建，移动端表现为肉眼可见的闪烁
    ok(viewsText.indexOf('box.innerHTML = html') < 0
      && viewsText.indexOf('function makeCard(imei)') > 0
      && viewsText.indexOf('function paintCard(el, st)') > 0
      && viewsText.indexOf('cardNodes[imei]') > 0,
      'T124 设备卡片按 imei 增量渲染（不再整表 innerHTML 重建）');
    // 单台设备的回调必须合并成一次重绘，否则一轮 N 台设备就重画 N 遍
    ok(viewsText.indexOf('function scheduleCardsPaint()') > 0
      && /cardsScheduled\s*=\s*setTimeout/.test(viewsText),
      'T125 单台设备回调合并为一次重绘');
    // 本轮拿不到定位（AC.request 永不 reject，失败是 resolve 成 found:false）
    // 不能把卡片打回「无定位」——那是「一会有数据一会没数据」的根因
    ok(viewsText.indexOf('function keepPrevious(imei, name)') > 0
      && /if \(!st\.found\) \{[\s\S]{0,200}keepPrevious\(imei/.test(viewsText)
      && viewsText.indexOf('out[imei] = prev;') > 0,
      'T126 本轮无定位时沿用上一轮有效数据，不打回无定位');

    /* ================= 构建号防缓存（合宙平台不发 Cache-Control） ================= */
    const cfgText = fs.readFileSync(path.join(ROOT, 'js/config.js'), 'utf8');
    const buildM = cfgText.match(/var BUILD = '([\d.]+)'/);
    const gradleText = fs.readFileSync(path.join(ROOT, 'android/app/build.gradle'), 'utf8');
    const gradleVer = (gradleText.match(/versionName "([\d.]+)"/) || [])[1];
    const loginBuildM = loginText.match(/var BUILD = '([\d.]+)'/);
    ok(!!buildM && !!gradleVer && !!loginBuildM
      && buildM[1] === gradleVer && loginBuildM[1] === gradleVer
      && cfgText.indexOf('BUILD: BUILD') > 0,
      'T127 BUILD 三处一致（config.js / login.html / build.gradle versionName）'
      + (buildM ? ' [config=' + buildM[1] + ' login=' + (loginBuildM && loginBuildM[1])
        + ' gradle=' + gradleVer + ']' : ''));
    // 页面跳转必须带 ?v=，否则浏览器/WebView 复用旧 HTML
    // （登录按钮改成青色后用户仍看到旧蓝色，就是这么来的）
    const airText = fs.readFileSync(path.join(ROOT, 'js/api/aircloud.js'), 'utf8');
    ok(airText.indexOf('function withBuild(url)') > 0
      && /function redirectToLogin[\s\S]{0,300}withBuild\(/.test(airText)
      && /function redirectToApp[\s\S]{0,200}withBuild\(/.test(airText)
      && /location\.replace\(withBuild\(target\)\)/.test(loginText)
      && loginText.indexOf('http-equiv="Cache-Control"') > 0
      && tplText.indexOf('http-equiv="Cache-Control"') > 0,
      'T128 页面跳转统一带构建号 + HTML 声明 no-cache');
    // 原生外壳：加载 URL 带版本号，且换版本时清一次 HTTP 缓存（不动 localStorage）
    ok(javaText.indexOf('private String withBuild(String url)') > 0
      && javaText.indexOf('webView.loadUrl(loginUrl())') > 0
      && javaText.indexOf('webView.loadUrl(indexUrl() + hash)') > 0
      && javaText.indexOf('private void clearStaleWebCache()') > 0
      && javaText.indexOf('webView.clearCache(true)') > 0
      && javaText.indexOf('clearStaleWebCache();') > 0
      && javaText.indexOf('import android.content.SharedPreferences;') > 0,
      'T129 Android 加载 URL 带版本号 + 换版本清 HTTP 缓存');

    /* ================= 轨迹异常点剔除（太跳跃的点直接抛弃） ================= */
    const D_LAT = 10 / 111320;   // 向北 10m
    const D_LNG = 10 / 96486;    // 北纬 30° 向东 10m
    const mkPt = (lng, lat, i, dtPrev) =>
      ({ lng, lat, ts: 1000000 + i * 10000, dtPrev: dtPrev === undefined ? (i ? 10 : 0) : dtPrev });

    // 正常行走：每 10s 走 10m（1m/s）
    const walkPts = [];
    for (let i = 0; i < 6; i++) walkPts.push(mkPt(104.0, 30.0 + i * D_LAT, i));
    const walkKept = Algo.filterTrackOutliers(walkPts, {}, {});
    ok(walkKept.length === 6, 'T130 正常行走轨迹一点不删 (got ' + walkKept.length + '/6)');

    // 单点漂移：中间插一个偏东约 1000m 的点，前后都正常
    const driftPts = walkPts.slice();
    driftPts.splice(3, 0, { lng: 104.0 + 1000 / 96486, lat: 30.0 + 3 * D_LAT, ts: 1025000, dtPrev: 5 });
    const driftStat = {};
    const driftKept = Algo.filterTrackOutliers(driftPts, {}, driftStat);
    ok(driftKept.length === 6 && driftStat.dropped === 1,
      'T131 单点漂移（约 1000m/5s）被剔除，其余保留 (kept=' + driftKept.length + ' dropped=' + driftStat.dropped + ')');

    // 整包偏移：某条记录参考点取错，连着 5 个点整体偏出去 1.5km
    const bulkPts = [];
    for (let i = 0; i < 3; i++) bulkPts.push(mkPt(104.0, 30.0 + i * D_LAT, i));
    for (let i = 0; i < 5; i++) bulkPts.push(mkPt(104.0 + 1500 / 96486, 30.0 + (3 + i) * D_LAT, 3 + i));
    const bulkStat = {};
    const bulkKept = Algo.filterTrackOutliers(bulkPts, {}, bulkStat);
    ok(bulkKept.length === 3 && bulkStat.dropped === 5,
      'T132 整包偏移连着 5 个点一起丢，不留半截飞出去的线段 (kept=' + bulkKept.length + ')');

    // 1294 包内 10 个样本：ts 只差 1ms，实际是 1s 一个 —— 必须靠 dtPrev 判定
    const pktPts = [];
    for (let i = 0; i < 10; i++) {
      pktPts.push({ lng: 104.0, lat: 30.0 + i / 111320, ts: 5000 + i, dtPrev: i ? 1 : 0 });
    }
    const pktKept = Algo.filterTrackOutliers(pktPts, {}, {});
    ok(pktKept.length === 10, 'T133 1294 包内 1ms 时间戳不被误判为瞬移 (kept=' + pktKept.length + '/10)');
    // 反向对照：去掉 dtPrev 后同一批点确实会被误删 —— 证明该字段不是可选项
    const noHintKept = Algo.filterTrackOutliers(pktPts.map(p => ({ lng: p.lng, lat: p.lat, ts: p.ts })), {}, {});
    ok(noHintKept.length < 10, 'T134 反向对照：缺 dtPrev 时确实误删 (kept=' + noHintKept.length + '/10)');

    /* ================= 日报 / 回放：耗时与反馈的源码级约束 ================= */
    const v2Text = fs.readFileSync(path.join(ROOT, 'js/app/views2.js'), 'utf8');
    const v3Text = fs.readFileSync(path.join(ROOT, 'js/app/views3.js'), 'utf8');
    const acText = fs.readFileSync(path.join(ROOT, 'js/api/aircloud.js'), 'utf8');
    // 日报原来跑两次完整 getTrack（当天 + 近 7 天），7 天那次的 location_history 翻页
    // 是「生成很慢、网络里一堆 location_history」的主因；现在只用轻量 513 记录算打卡
    const gtCount = (v3Text.match(/AC\.getTrack\(/g) || []).length;
    ok(gtCount === 1, 'T135 日报只跑一次 getTrack（原来两次）[got ' + gtCount + ']');
    ok(v3Text.indexOf('id="rp-progress"') > 0 && v3Text.indexOf('Views.progressCtl') > 0,
      'T136 日报有进度条（长查询不再是「黑屏等」）');
    ok(v2Text.indexOf('Views.progressCtl(prog)') > 0
      && v2Text.indexOf("info.phase === 'history'") > 0,
      'T137 轨迹回放进度条覆盖 history 阶段（原来该阶段完全没有反馈）');
    ok(viewsText.indexOf('function progressCtl(host)') > 0
      && viewsText.indexOf('progressCtl: progressCtl') > 0,
      'T138 通用进度条控制器已挂到 Views');
    ok(acText.indexOf('runPool(') > 0 && acText.indexOf('page++;') < 0,
      'T139 翻页改为并发（存在 runPool，串行 step 递归已移除）');
    ok(acText.indexOf('Alg.filterTrackOutliers') > 0,
      'T140 getTrack 出口统一做异常点剔除（日报与回放共用）');

    return parallelChecks();
  }).then(summarize);
})['catch'](e => {
  console.error('测试执行异常：', e);
  process.exit(1);
});