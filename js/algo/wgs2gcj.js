/**
 * algo/wgs2gcj.js —— WGS84 转 GCJ02（国测局）经典算法
 * 挂载：window.Algo.wgs84ToGcj02 / gcj02ToWgs84 / isInChina
 * 注意：平台 latest_location 返回 lng/lat 已是 GCJ02，无需再转；
 * 本转换仅用于设备原始坐标（数字 key 形式）上地图前的处理。
 */
(function (global) {
  'use strict';

  var A = global.Algo || (global.Algo = {});

  var PI = Math.PI;
  var A_6378245 = 6378245.0;
  var EE = 0.00669342162296594323;
  var X_PI = PI * 3000.0 / 180.0;

  function transformLat(x, y) {
    var ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
    ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
    return ret;
  }

  function transformLng(x, y) {
    var ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
    ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
    ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
    ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
    return ret;
  }

  function delta(lng, lat) {
    var dLat = transformLat(lng - 105.0, lat - 35.0);
    var dLng = transformLng(lng - 105.0, lat - 35.0);
    var radLat = lat / 180.0 * PI;
    var magic = Math.sin(radLat);
    magic = 1 - EE * magic * magic;
    var sqrtMagic = Math.sqrt(magic);
    dLat = (dLat * 180.0) / ((A_6378245 * (1 - EE)) / (magic * sqrtMagic) * PI);
    dLng = (dLng * 180.0) / (A_6378245 / sqrtMagic * Math.cos(radLat) * PI);
    return { lat: dLat, lng: dLng };
  }

  /**
   * 粗略中国范围框判断
   */
  function isInChina(lng, lat) {
    var l = Number(lng), la = Number(lat);
    if (!isFinite(l) || !isFinite(la)) return false;
    return la >= 3 && la <= 53.55 && l >= 73.66 && l <= 135.05;
  }

  /**
   * WGS84 -> GCJ02，返回 [lng, lat]
   */
  function wgs84ToGcj02(lng, lat) {
    lng = Number(lng); lat = Number(lat);
    if (!isFinite(lng) || !isFinite(lat)) return [lng, lat];
    if (!isInChina(lng, lat)) return [lng, lat];
    var d = delta(lng, lat);
    return [lng + d.lng, lat + d.lat];
  }

  /**
   * GCJ02 -> WGS84（迭代反算 2 次）
   */
  function gcj02ToWgs84(lng, lat) {
    lng = Number(lng); lat = Number(lat);
    if (!isFinite(lng) || !isFinite(lat)) return [lng, lat];
    if (!isInChina(lng, lat)) return [lng, lat];
    var cl = lng, cla = lat;
    for (var i = 0; i < 2; i++) {
      var d = delta(cl, cla);
      cl = lng - d.lng;
      cla = lat - d.lat;
    }
    return [cl, cla];
  }

  A.sanitizeCoord = function (lng, lat) {
    lng = Number(lng); lat = Number(lat);
    if (!isFinite(lng) || !isFinite(lat)) return null;
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return [lng, lat];
  };

  A.wgs84ToGcj02 = wgs84ToGcj02;
  A.gcj02ToWgs84 = gcj02ToWgs84;
  A.isInChina = isInChina;
})(window);