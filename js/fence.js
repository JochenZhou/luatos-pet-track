/**
 * fence.js —— 电子围栏本地存储 + 越界判定 + 报警列表
 * 挂载：window.FenceStore
 * 重要：所有围栏坐标均为 GCJ02（与平台 latest_location 一致），
 * isPointInFence 判定禁止再做任何坐标转换。
 */
(function (global) {
  'use strict';
  var U = global.Utils;
  var CFG = global.CFG;

  function all() {
    var f = U.store.get(CFG.KEY_FENCES);
    return Array.isArray(f) ? f : [];
  }
  function save(list) {
    U.store.set(CFG.KEY_FENCES, list);
  }

  function get(id) {
    var list = all();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  function add(fence) {
    if (!fence) return null;
    fence.id = fence.id || U.uid('fence_');
    fence.enabled = fence.enabled !== false;
    fence.created = Date.now();
    var list = all();
    list.push(fence);
    save(list);
    return fence;
  }

  function update(id, patch) {
    var list = all();
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) {
        list[i] = U.extend(list[i], patch || {});
        list[i].id = id;
        save(list);
        return list[i];
      }
    }
    return null;
  }

  function remove(id) {
    var list = all();
    var next = list.filter(function (f) { return f.id !== id; });
    save(next);
  }

  function clear() {
    save([]);
  }

  /* ---------------- 几何判定（全部要求 GCJ02） ---------------- */

  function pointInCircle(pt, center, radiusMeters) {
    if (!pt || !center) return false;
    var R = 6371000;
    var dLat = (pt[1] - center[1]) * Math.PI / 180;
    var dLng = (pt[0] - center[0]) * Math.PI / 180;
    var la1 = center[1] * Math.PI / 180;
    var la2 = pt[1] * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    var c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return (R * c) <= radiusMeters;
  }

  function pointInPolygon(pt, polygon) {
    if (!pt || !polygon || polygon.length < 3) return false;
    var x = pt[0], y = pt[1];
    var inside = false;
    var n = polygon.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = polygon[i][0], yi = polygon[i][1];
      var xj = polygon[j][0], yj = polygon[j][1];
      if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) {
        inside = !inside;
      }
    }
    return inside;
  }

  /**
   * 判定点是否在某围栏内（lng,lat 为 GCJ02）
   */
  function isPointInFence(point, fence) {
    if (!point || !fence) return false;
    var p = [Number(point[0]), Number(point[1])];
    if (!isFinite(p[0]) || !isFinite(p[1])) return false;
    if (fence.kind === 'circle') {
      return pointInCircle(p, [Number(fence.center[0]), Number(fence.center[1])], Number(fence.radius));
    }
    if (fence.kind === 'polygon') {
      return pointInPolygon(p, (fence.points || []).map(function (item) { return [Number(item[0]), Number(item[1])]; }));
    }
    return false;
  }

  /**
   * 围栏是否对某设备生效。
   * fence.imeis 为空/缺省 = 对全部设备生效（兼容旧围栏，行为不变）；
   * 非空 = 只对勾选的设备生效（越界巡检按此过滤，别台设备越界不报这台的围栏）。
   */
  function targetsImei(fence, imei) {
    if (!fence) return false;
    var ts = fence.imeis;
    if (!ts || !ts.length) return true;
    return ts.map(String).indexOf(String(imei)) >= 0;
  }

  /* ---------------- 报警 ---------------- */

  function alerts() {
    var a = U.store.get('pt_fence_alerts');
    return Array.isArray(a) ? a : [];
  }
  function saveAlerts(list) {
    U.store.set('pt_fence_alerts', list);
  }

  /**
   * 记录越界报警（5 分钟去抖，同一围栏+设备）
   */
  function addAlert(imei, fenceId, point, address) {
    var list = alerts();
    var now = Date.now();
    var last = null;
    for (var i = list.length - 1; i >= 0; i--) {
      if (list[i].imei === imei && list[i].fenceId === fenceId) { last = list[i]; break; }
    }
    if (last && (now - last.ts) < CFG.FENCE_ALERT_DEBOUNCE) return null;
    var alert = {
      id: U.uid('al_'),
      imei: imei,
      fenceId: fenceId,
      lng: point[0],
      lat: point[1],
      address: address || '',
      ts: now,
      handled: false
    };
    list.unshift(alert);
    if (list.length > 200) list.length = 200;
    saveAlerts(list);
    return alert;
  }

  function clearAlerts() {
    saveAlerts([]);
  }

  function markHandled(id) {
    var list = alerts();
    var changed = false;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id && !list[i].handled) { list[i].handled = true; changed = true; }
    }
    if (changed) saveAlerts(list);
    return changed;
  }

  function markAllHandled() {
    var list = alerts();
    var changed = false;
    for (var i = 0; i < list.length; i++) {
      if (!list[i].handled) { list[i].handled = true; changed = true; }
    }
    if (changed) saveAlerts(list);
    return changed;
  }

  function unhandledCount() {
    var list = alerts();
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      if (!list[i].handled) n++;
    }
    return n;
  }

  var FenceStore = {
    all: all,
    get: get,
    add: add,
    update: update,
    remove: remove,
    clear: clear,
    isPointInFence: isPointInFence,
    targetsImei: targetsImei,
    pointInCircle: pointInCircle,
    pointInPolygon: pointInPolygon,
    alerts: alerts,
    addAlert: addAlert,
    clearAlerts: clearAlerts,
    markHandled: markHandled,
    markAllHandled: markAllHandled,
    unhandledCount: unhandledCount
  };

  global.FenceStore = FenceStore;
})(window);