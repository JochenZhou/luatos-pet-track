/**
 * loc-cache.js —— 设备最近定位的持久化缓存
 * 挂载：window.LocCache
 *
 * 解决的问题：进入「实时地图」要等轮询拉到最新定位（最长约 10 秒）才上屏，
 * 期间点设备会误报「暂无定位，无法在地图上定位」。
 * 现在每次拿到有效定位就落一份 localStorage，下次进页面先把缓存画上去，
 * 新数据到了再就地刷新 —— 用户不再干等，也没有"假空白"。
 *
 * 设计要点：
 *  - 只存有有效经纬度的状态（st.lng/st.lat 为有限数），无定位不缓存；
 *  - 同一设备只保留 ts 更新的那份（乱序回包不回退）；
 *  - 上限 MAX 台，超出按缓存时间淘汰最旧的，防 localStorage 膨胀；
 *  - 写入失败（隐私模式/存储满）静默忽略，绝不阻塞业务。
 */
(function (global) {
  'use strict';
  var U = global.Utils;
  var CFG = global.CFG;
  var MAX = 50;

  function read() {
    var o = U.store.get(CFG.KEY_LOC_CACHE);
    return (o && typeof o === 'object' && !Array.isArray(o)) ? o : {};
  }

  function write(o) {
    var ks = Object.keys(o);
    if (ks.length > MAX) {
      ks.sort(function (a, b) { return (o[a].t || 0) - (o[b].t || 0); });
      ks.slice(0, ks.length - MAX).forEach(function (k) { delete o[k]; });
    }
    try { U.store.set(CFG.KEY_LOC_CACHE, o); } catch (e) { /* 存储不可用时忽略 */ }
  }

  function hasValidLoc(st) {
    return !!(st && st.lng !== undefined && st.lat !== undefined &&
      isFinite(Number(st.lng)) && isFinite(Number(st.lat)));
  }

  /**
   * 记录一份设备状态（必须是含有效定位的完整状态对象）
   */
  function put(st) {
    if (!st || !st.imei || !hasValidLoc(st)) return false;
    var o = read();
    var prev = o[st.imei];
    // 只存更新的：prev.st.ts 与 st.ts 都是本地钟面毫秒，直接比大小
    if (prev && prev.st && prev.st.ts && st.ts && Number(st.ts) <= Number(prev.st.ts)) return false;
    var copy = U.extend({}, st);
    delete copy._cached;          // 渲染用标记不落盘
    o[st.imei] = { st: copy, t: Date.now() };
    write(o);
    return true;
  }

  /** 取某设备的缓存状态；没有或无有效定位返回 null */
  function get(imei) {
    var e = read()[imei];
    return (e && hasValidLoc(e.st)) ? e.st : null;
  }

  /** 清掉某设备（设备被删除时调用，防串号） */
  function drop(imei) {
    var o = read();
    if (o[imei]) { delete o[imei]; write(o); }
  }

  function clear() {
    try { U.store.remove(CFG.KEY_LOC_CACHE); } catch (e) { /* ignore */ }
  }

  var LocCache = { put: put, get: get, drop: drop, clear: clear, hasValidLoc: hasValidLoc };
  global.LocCache = LocCache;
})(window);
