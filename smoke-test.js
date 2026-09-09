/**
 * smoke-test.js —— 结构级冒烟测试（stub fetch，65 项）
 * 运行：node smoke-test.js
 * 断言：URL 网关路径 / 三鉴权头无 Bearer / Content-Type / 未登录不发请求 /
 *       102 失效清键跳 login / tags 透传 sanitize / recTs 本地钟面恒等 /
 *       tagById(799) 电压 / 轨迹抽稀 / 围栏 GCJ02 判定 / 坐标转换 / …
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
global.document = { addEventListener() {}, readyState: 'complete', getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], body: { contains: () => true } };

// 加载源码（顺序与构建一致）
const fs = require('fs');
const path = require('path');
const ROOT = __dirname;
const files = [
  'js/config.js', 'js/utils.js', 'js/pet-store.js', 'js/fence.js',
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

  /* ================= 汇总 ================= */
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
})['catch'](e => {
  console.error('测试执行异常：', e);
  process.exit(1);
});