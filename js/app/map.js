/**
 * app/map.js —— MapKit 地图管理（腾讯地图 JS API GL / TMap）
 * 挂载：window.MapKit
 * 底图：腾讯矢量底图（GCJ02，与平台数据坐标系一致，无需转换）。
 * 图层治理（防跨页污染核心）：create() 递增 epoch；临时形状统一 tempShapes；
 * 回放/轨迹动画闭包校验 mapAlive() + epoch；所有函数入口先判 mapAlive()。
 * 坐标约定：对外几何接口一律 [lng, lat]（GCJ02），内部转 TMap.LatLng(lat, lng)。
 */
(function (global) {
  'use strict';
  // 主题取色：地图/Canvas 画在 DOM 之外，拿不到 var()，必须显式取色。
  // 取不到 Theme 时退回原硬编码值，保证 theme.js 未加载也不影响绘制。
  var TH = global.Theme || { cssVar: function (n, f) { return f; } };
  var U = global.Utils;
  var CFG = global.CFG;

  var state = {
    map: null,
    epoch: 0,
    petMarkers: {},      // imei -> { info }
    markerLayer: null,   // TMap.MultiMarker（设备标记）
    tempShapes: [],      // 临时形状 handle 列表
    fenceShapes: [],     // 围栏形状列表
    infoWindow: null,    // 复用的 TMap.InfoWindow
    openImei: null,      // 当前打开 popup 的设备
    turbo: null,         // {imei, timer, onTick}
    lockedImei: null     // 卡片点击锁定
  };

  function mapAlive() {
    return !!(state.map);
  }

  /* ---------------- 主题取色 ----------------
     调用方传「CSS 变量名」而不是求值后的色值：换主题时才能就地重算样式，
     否则形状颜色会永远停在图层创建那一刻（表现为「换了主题、地图还是旧色」）。 */
  var TOKEN_FALLBACK = {
    '--brand-500': '#6366F1',
    '--brand-600': '#4F46E5',
    '--ok': '#10B981',
    '--danger': '#F43F5E',
    '--warn': '#F59E0B',
    '--info': '#3B82F6'
  };
  // 未显式指定颜色时的默认 token（按形状类型）
  var TEMP_TOKEN = { dot: '--brand-600', polyline: '--brand-600', circle: '--warn', polygon: '--brand-500' };
  var FENCE_TOKEN = { circle: '--warn', polygon: '--brand-500' };

  function tokenOf(shape, table) {
    if (shape && shape.color) return shape.color;      // 调用方显式给了（token 或色值）
    return (table && table[shape && shape.kind]) || '--brand-600';
  }

  /** token -> 实际色值；非 token（#rrggbb 之类）原样返回 */
  function resolve(token) {
    if (!token) return TOKEN_FALLBACK['--brand-600'];
    if (String(token).indexOf('--') === 0) {
      return TH.cssVar(token, TOKEN_FALLBACK[token] || TOKEN_FALLBACK['--brand-600']);
    }
    return token;
  }

  function destroyMap() {
    state.epoch++;
    state.petMarkers = {};
    state.markerLayer = null;
    state.turbo = null;
    state.openImei = null;
    state.tempShapes = [];
    state.fenceShapes = [];
    state.infoWindow = null;
    if (state.map) {
      try { state.map.destroy(); } catch (e) { /* ignore */ }
      state.map = null;
    }
  }

  function ll(point) {
    return new TMap.LatLng(point[1], point[0]);
  }

  function ensureTMap(cb) {
    if (global.TMap && global.TMap.Map) { cb(); return; }
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      if (global.TMap && global.TMap.Map) { clearInterval(timer); cb(); }
      else if (tries > 50) { clearInterval(timer); }
    }, 100);
  }

  /* ---------------- 样式 ---------------- */

  function svgDataUrl(svg) {
    return 'd\u0061ta:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
  }

  function petMarkerStyle(color) {
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="42" viewBox="0 0 34 42">' +
      '<path d="M17 1C9.3 1 3 7.3 3 15c0 10.4 12.2 25.2 13.2 26.4a1.3 1.3 0 0 0 1.6 0C18.8 40.2 31 25.4 31 15 31 7.3 24.7 1 17 1z" fill="' + color + '" stroke="#ffffff" stroke-width="1.5"/>' +
      '<circle cx="17" cy="15" r="5.5" fill="#ffffff" opacity="0.95"/></svg>';
    return new TMap.MarkerStyle({ width: 34, height: 42, anchor: { x: 17, y: 40 }, src: svgDataUrl(svg) });
  }

  function dotStyle(color, radius) {
    var d = radius * 2;
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="' + d + '" height="' + d + '">' +
      '<circle cx="' + radius + '" cy="' + radius + '" r="' + radius + '" fill="' + color + '" stroke="#ffffff" stroke-width="1.5"/></svg>';
    return new TMap.MarkerStyle({ width: d, height: d, anchor: { x: radius, y: radius }, src: svgDataUrl(svg) });
  }

  function lineStyle(color, weight, opacity, dash) {
    var o = { color: color, width: weight || 4, borderWidth: 0, lineCap: 'round' };
    if (dash) o.dashArray = dash;
    return new TMap.PolylineStyle(o);
  }

  function circleStyle(color, fillOpacity) {
    return new TMap.CircleStyle({ color: color, fillColor: color, fillOpacity: fillOpacity !== undefined ? fillOpacity : 0.08, strokeWidth: 2 });
  }

  function polygonStyle(color, fillOpacity) {
    return new TMap.PolygonStyle({ color: color, fillColor: color, fillOpacity: fillOpacity !== undefined ? fillOpacity : 0.08, strokeWidth: 2 });
  }

  /* ---------------- 创建 / 销毁 ---------------- */

  function create(containerId, opts) {
    opts = opts || {};
    destroyMap();
    var el = document.getElementById(containerId);
    if (!el) return null;
    if (!global.TMap || !global.TMap.Map) {
      ensureTMap(function () { create(containerId, opts); });
      return null;
    }
    state.epoch++;
    var center = opts.center || [30.65, 104.06]; // [lat, lng]
    var map = new TMap.Map(el, {
      center: new TMap.LatLng(center[0], center[1]),
      zoom: opts.zoom || 5,
      viewMode: '2D'
    });
    state.map = map;
    state.tempShapes = [];
    state.fenceShapes = [];
    state.infoWindow = null;
    state.openImei = null;
    // 300ms 校准（页面切换后容器尺寸变化）
    setTimeout(function () {
      if (state.map && state.map === map) {
        try { if (typeof map.resize === 'function') map.resize(); } catch (e) { /* ignore */ }
      }
    }, 300);
    return map;
  }

  function getMap() { return state.map; }
  function epoch() { return state.epoch; }

  /* ---------------- 设备 marker（MultiMarker） ---------------- */

  function markerStyles() {
    return { online: petMarkerStyle(resolve('--brand-600')), offline: petMarkerStyle('#8B96AB') };
  }

  function ensureMarkerLayer() {
    if (!state.markerLayer && state.map) {
      state.markerLayer = new TMap.MultiMarker({
        map: state.map,
        styles: markerStyles(),
        geometries: []
      });
      state.markerLayer.on('click', function (e) {
        if (e.geometry && e.geometry.id) {
          state.lockedImei = e.geometry.id;
          focusOn(e.geometry.id, 18);   // 点击地图上的设备点也放大到该设备
          openPopupFor(e.geometry.id);
        }
      });
    }
    return state.markerLayer;
  }

  function upsertMarker(status) {
    if (!mapAlive() || !status || !status.imei) return null;
    var imei = status.imei;
    var hasLoc = status.lng !== undefined && status.lat !== undefined && isFinite(status.lng) && isFinite(status.lat);
    if (!hasLoc) return null;
    var lng = Number(status.lng);
    var lat = Number(status.lat);
    var offline = status.ts ? (Date.now() - status.ts > 5 * 60 * 1000) : false;
    var layer = ensureMarkerLayer();
    if (!layer) return null;
    var existing = state.petMarkers[imei];
    var geo = { id: imei, position: new TMap.LatLng(lat, lng), styleId: offline ? 'offline' : 'online' };
    if (!existing) {
      state.petMarkers[imei] = { info: status };
      layer.add([geo]);
    } else {
      state.petMarkers[imei].info = status;
      layer.updateGeometries([geo]);
    }
    if (state.openImei === imei) refreshOpenPopups();
    return state.petMarkers[imei];
  }

  function syncMarkerGeometries() {
    if (!state.markerLayer) return;
    var geos = [];
    for (var imei in state.petMarkers) {
      var m = state.petMarkers[imei];
      var st = m.info;
      if (st && st.lng !== undefined && isFinite(st.lng)) {
        var off = st.ts ? (Date.now() - st.ts > 5 * 60 * 1000) : false;
        geos.push({ id: imei, position: new TMap.LatLng(Number(st.lat), Number(st.lng)), styleId: off ? 'offline' : 'online' });
      }
    }
    state.markerLayer.setGeometries(geos);
  }

  /* ---------------- 设备弹窗（InfoWindow 复用） ---------------- */

  function popupHtml(status) {
    if (!status) return '<div class="pp-empty">暂无数据</div>';
    var offline = status.ts ? (Date.now() - status.ts > 5 * 60 * 1000) : false;
    var speedLine = '';
    if (status.speed !== undefined && status.speedKmh !== undefined) {
      speedLine = '<div class="pp-row"><span>🧭 速度·角度·海拔</span><b>' + U.esc(status.speedKmh) + ' km/h · ' + Math.round(Number(status.course || 0)) + '° · ' + Math.round(Number(status.altitude || 0)) + ' m</b></div>';
    }
    var satLine = status.sat !== undefined && status.sat !== null
      ? '<div class="pp-row"><span>🛰️ 卫星</span><b>' + U.esc(status.sat) + ' 颗</b></div>' : '';
    var batLine = '';
    if (status.vbatPct !== undefined && status.vbatPct !== null) {
      batLine = '<div class="pp-row"><span>🔋 电量</span><b>' + U.esc(status.vbatPct) + '%</b></div>';
    } else if (status.percent !== undefined && status.percent !== null) {
      batLine = '<div class="pp-row"><span>🔋 电量</span><b>' + U.esc(status.percent) + '%</b></div>';
    }
    var sigText = status.signal !== undefined && status.signal !== null ? U.signalText(status.signal) : '';
    var turboBtn = offline
      ? '<button class="pp-btn" disabled>超 5 分钟未上报</button>'
      : '<button class="pp-btn pp-turbo" data-turbo="' + U.esc(status.imei) + '">🚀 实时追踪</button>';
    var html =
      '<div class="pp-title">' + U.esc(status.name || status.imei) + '</div>' +
      '<div class="pp-imei">📱 ' + U.esc(status.imei) + '</div>' +
      '<div class="pp-row"><span>📍 位置</span><b>' + Number(status.lng).toFixed(6) + ', ' + Number(status.lat).toFixed(6) + '</b></div>' +
      (status.address ? '<div class="pp-row pp-addr"><span>🏷 地址</span><b>' + U.esc(status.address) + '</b></div>' : '') +
      speedLine +
      satLine +
      batLine +
      (status.signal !== undefined && status.signal !== null ? '<div class="pp-row"><span>📶 信号</span><b>' + U.esc(status.signal) + '（' + U.esc(sigText) + '）</b></div>' : '') +
      '<div class="pp-row"><span>🕒 更新</span><b>' + U.esc(status.time || '') + '</b></div>' +
      '<div class="pp-actions">' + turboBtn + '</div>';
    return '<div class="pp-box">' + html + '</div>';
  }

  function ensureInfoWindow() {
    if (!state.infoWindow && state.map) {
      state.infoWindow = new TMap.InfoWindow({ map: state.map, position: state.map.getCenter(), content: '' });
    }
    return state.infoWindow;
  }

  function openPopupFor(imei) {
    var m = state.petMarkers[imei];
    if (!m || !m.info) return;
    var st = m.info;
    if (!(st.lng !== undefined && isFinite(st.lng))) return;
    var iw = ensureInfoWindow();
    if (!iw) return;
    iw.setPosition(new TMap.LatLng(Number(st.lat), Number(st.lng)));
    iw.setContent(popupHtml(st));
    iw.open();
    state.openImei = imei;
  }

  function refreshOpenPopups() {
    if (!mapAlive() || !state.openImei) return;
    var m = state.petMarkers[state.openImei];
    if (m && m.info) {
      var iw = ensureInfoWindow();
      if (iw) iw.setContent(popupHtml(m.info));
    }
  }

  /* ---------------- 实时追踪 ---------------- */

  function isTurbo() { return !!state.turbo; }

  function stopTurbo() {
    if (state.turbo) {
      if (state.turbo.timer) clearInterval(state.turbo.timer);
      state.turbo = null;
    }
    // 恢复全部 marker
    syncMarkerGeometries();
  }

  function startTurbo(imei, onTick) {
    if (!mapAlive() || !imei || state.turbo) return false;
    state.turbo = { imei: imei, timer: null, onTick: onTick };
    setTurboFocus(imei, true);
    state.turbo.timer = setInterval(function () {
      if (!mapAlive() || !state.turbo) { if (state.turbo) stopTurbo(); return; }
      if (state.openImei === imei) refreshOpenPopups();
      if (typeof onTick === 'function') {
        try { onTick(imei); } catch (e) { /* ignore */ }
      }
    }, 500);
    return true;
  }

  function setTurboFocus(imei, follow) {
    if (!mapAlive()) return;
    var m = state.petMarkers[imei];
    if (!m || !m.info) return;
    // 隐藏其它 marker
    var hideIds = [];
    for (var k in state.petMarkers) {
      if (k !== imei) hideIds.push(k);
    }
    if (state.markerLayer && hideIds.length) {
      try { state.markerLayer.remove(hideIds); } catch (e) { /* ignore */ }
    }
    var st = m.info;
    panTo(new TMap.LatLng(Number(st.lat), Number(st.lng)), follow ? 17 : 16, 600);
  }

  /* ---------------- 卡片 hover/click 缩放 ---------------- */

  /**
   * 平移 + 缩放（关键修复）
   * TMap 的 setCenter 会启动一段平移动画；紧接其后的 setZoom 会被动画终点覆盖或直接丢弃，
   * 表现就是「点击设备卡片地图不放大」。统一改用 easeTo 一次性提交 center + zoom；
   * 无 easeTo 的旧版本退化为「先定级、再平移，并在动画结束后补一次级别」。
   */
  function panTo(pos, z, duration) {
    var map = state.map;
    if (!map) return;
    var dur = duration === undefined ? 420 : duration;
    if (typeof map.easeTo === 'function') {
      try { map.easeTo({ center: pos, zoom: z, duration: dur }); return; } catch (e) { /* 落到回退分支 */ }
    }
    try { if (typeof map.setZoom === 'function') map.setZoom(z); } catch (e) { /* ignore */ }
    try { map.setCenter(pos); } catch (e) { /* ignore */ }
    setTimeout(function () {
      if (mapAlive() && state.map === map) {
        try { map.setZoom(z); } catch (e) { /* ignore */ }
      }
    }, dur + 120);
  }

  /**
   * 设备是否有可用定位（视图层用来区分「不存在」与「无定位」两种情况）
   */
  function canFocus(imei) {
    var m = state.petMarkers[imei];
    if (!m || !m.info) return false;
    var st = m.info;
    return st.lng !== undefined && st.lat !== undefined && isFinite(st.lng) && isFinite(st.lat);
  }

  function focusOn(imei, zoom) {
    var m = state.petMarkers[imei];
    if (!m || !m.info || !mapAlive()) return false;
    var st = m.info;
    if (!(st.lng !== undefined && st.lat !== undefined && isFinite(st.lng) && isFinite(st.lat))) return false;
    var z = zoom || 15;
    // 已锁定的设备保持放大，不被后续 hover 缩小
    if (state.lockedImei === imei) z = Math.max(z, 17);
    panTo(new TMap.LatLng(Number(st.lat), Number(st.lng)), z, 420);
    return true;
  }

  function setLocked(imei) { state.lockedImei = imei; }
  function locked() { return state.lockedImei; }

  /* ---------------- 临时形状（轨迹/围栏绘制预览） ---------------- */

  function addTemp(shape) {
    if (!mapAlive() || !shape) return null;
    var obj = null;
    var token = tokenOf(shape, TEMP_TOKEN);
    var color = resolve(token);
    if (shape.kind === 'dot') {
      obj = new TMap.MultiMarker({
        map: state.map,
        styles: { s: dotStyle(color, shape.radius || 7) },
        geometries: [{ id: 'd', position: ll(shape.point), styleId: 's' }]
      });
    } else if (shape.kind === 'polyline') {
      obj = new TMap.MultiPolyline({
        map: state.map,
        styles: { s: lineStyle(color, shape.weight, shape.opacity, shape.dash) },
        geometries: [{ id: 'l', paths: (shape.points || []).map(ll), styleId: 's' }]
      });
    } else if (shape.kind === 'circle') {
      obj = new TMap.MultiCircle({
        map: state.map,
        styles: { s: circleStyle(color, shape.fillOpacity) },
        geometries: [{ id: 'c', center: ll(shape.center), radius: shape.radius || 100, styleId: 's' }]
      });
    } else if (shape.kind === 'polygon') {
      obj = new TMap.MultiPolygon({
        map: state.map,
        styles: { s: polygonStyle(color, shape.fillOpacity) },
        geometries: [{ id: 'p', paths: (shape.points || []).map(ll), styleId: 's' }]
      });
    }
    if (!obj) return null;
    var handle = {
      kind: shape.kind,
      obj: obj,
      shape: shape,
      token: token,
      applyStyle: function () {
        var c = resolve(token);
        var st = null;
        if (shape.kind === 'dot') st = dotStyle(c, shape.radius || 7);
        else if (shape.kind === 'polyline') st = lineStyle(c, shape.weight, shape.opacity, shape.dash);
        else if (shape.kind === 'circle') st = circleStyle(c, shape.fillOpacity);
        else if (shape.kind === 'polygon') st = polygonStyle(c, shape.fillOpacity);
        if (!st) return;
        try { obj.setStyles({ s: st }); } catch (e) { /* 个别版本无 setStyles，忽略 */ }
      },
      move: function (point) {
        if (shape.kind === 'dot') { try { obj.updateGeometries([{ id: 'd', position: ll(point) }]); } catch (e) {} }
        else if (shape.kind === 'circle') { try { obj.updateGeometries([{ id: 'c', center: ll(point) }]); } catch (e) {} }
      },
      setPath: function (points) {
        if (shape.kind === 'polyline' || shape.kind === 'polygon') {
          var id = shape.kind === 'polyline' ? 'l' : 'p';
          try { obj.updateGeometries([{ id: id, paths: (points || []).map(ll) }]); } catch (e) {}
        }
      },
      setRadius: function (r) {
        if (shape.kind === 'circle') { try { obj.updateGeometries([{ id: 'c', radius: r }]); } catch (e) {} }
      },
      remove: function () {
        try { obj.setMap(null); } catch (e) {}
        var idx = state.tempShapes.indexOf(handle);
        if (idx >= 0) state.tempShapes.splice(idx, 1);
      }
    };
    state.tempShapes.push(handle);
    return handle;
  }

  function clearTemp() {
    state.tempShapes.forEach(function (h) { try { h.obj.setMap(null); } catch (e) {} });
    state.tempShapes = [];
  }

  /* ---------------- 围栏形状 ---------------- */

  /**
   * 主题变了：就地重算图层样式。
   * 不销毁重建地图 —— 否则会闪一下、丢掉视野与选中态。
   */
  function applyTheme() {
    if (!mapAlive()) return 0;
    var n = 0;
    if (state.markerLayer) {
      try { state.markerLayer.setStyles(markerStyles()); n++; } catch (e) { /* ignore */ }
    }
    state.tempShapes.concat(state.fenceShapes).forEach(function (h) {
      if (h && typeof h.applyStyle === 'function') { h.applyStyle(); n++; }
    });
    return n;
  }

  function clearFences() {
    state.fenceShapes.forEach(function (rec) { try { rec.obj.setMap(null); } catch (e) {} });
    state.fenceShapes = [];
  }

  /** 已保存围栏的填充透明度：明显半透明（一眼看出围栏范围），比绘制期预览更实 */
  var FENCE_FILL = 0.25;

  function addFence(shape) {
    if (!mapAlive() || !shape) return null;
    var obj = null;
    if (shape.kind === 'circle') {
      obj = new TMap.MultiCircle({
        map: state.map,
        styles: { s: circleStyle(resolve(tokenOf(shape, FENCE_TOKEN)), FENCE_FILL) },
        geometries: [{ id: 'f', center: ll(shape.center), radius: shape.radius || 100, styleId: 's' }]
      });
    } else if (shape.kind === 'polygon') {
      obj = new TMap.MultiPolygon({
        map: state.map,
        styles: { s: polygonStyle(resolve(tokenOf(shape, FENCE_TOKEN)), FENCE_FILL) },
        geometries: [{ id: 'f', paths: (shape.points || []).map(ll), styleId: 's' }]
      });
    }
    if (!obj) return null;
    obj.on('click', function (e) {
      var iw = ensureInfoWindow();
      if (!iw) return;
      var c = e.latLng || (shape.kind === 'circle' ? ll(shape.center) : null);
      if (!c) return;
      iw.setPosition(c);
      iw.setContent('<div class="pp-box"><div class="pp-title">' + U.esc(shape.name || '') + '</div>' +
        (shape.kind === 'circle' ? '<div class="pp-row">半径 ' + (shape.radius || 0) + 'm</div>' : '') + '</div>');
      iw.open();
    });
    state.fenceShapes.push({ kind: shape.kind, obj: obj });
    return obj;
  }

  /* ---------------- 视野 / 事件 / 委托 ---------------- */

  function fitBounds(points, opts) {
    if (!mapAlive() || !points || !points.length) return;
    opts = opts || {};
    var minLat = Infinity, maxLat = -Infinity, minLng = Infinity, maxLng = -Infinity;
    points.forEach(function (p) {
      var lng = p[0], lat = p[1];
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
    });
    var bounds = new TMap.LatLngBounds(new TMap.LatLng(minLat, minLng), new TMap.LatLng(maxLat, maxLng));
    state.map.fitBounds(bounds, { padding: opts.padding || 40 });
  }

  function focusPoint(point, zoom) {
    if (!mapAlive() || !point) return;
    if (zoom) { panTo(ll(point), zoom, 420); return; }
    try { state.map.setCenter(ll(point)); } catch (e) { /* ignore */ }
  }

  function on(evt, fn) {
    if (!state.map) return;
    state.map.on(evt, function (e) {
      if (e && e.latLng) {
        fn({ lat: e.latLng.getLat(), lng: e.latLng.getLng() });
      }
    });
  }

  function bindDelegates() {
    document.addEventListener('click', function (evt) {
      var t = evt.target;
      while (t && t !== document) {
        if (t.getAttribute && t.getAttribute('data-turbo')) {
          var imei = t.getAttribute('data-turbo');
          if (typeof global.Views !== 'undefined' && global.Views.startTurboFromMap) {
            global.Views.startTurboFromMap(imei);
          }
          return;
        }
        t = t.parentNode;
      }
    });
  }

  var MapKit = {
    create: create,
    getMap: getMap,
    epoch: epoch,
    mapAlive: mapAlive,
    destroyMap: destroyMap,
    upsertMarker: upsertMarker,
    popupHtml: popupHtml,
    openPopupFor: openPopupFor,
    refreshOpenPopups: refreshOpenPopups,
    startTurbo: startTurbo,
    stopTurbo: stopTurbo,
    isTurbo: isTurbo,
    setTurboFocus: setTurboFocus,
    focusOn: focusOn,
    canFocus: canFocus,
    panTo: panTo,
    setLocked: setLocked,
    locked: locked,
    addTemp: addTemp,
    clearTemp: clearTemp,
    clearFences: clearFences,
    addFence: addFence,
    applyTheme: applyTheme,
    fitBounds: fitBounds,
    focusPoint: focusPoint,
    on: on,
    bindDelegates: bindDelegates,
    state: state
  };

  /* 换主题 → 就地重算图层样式（不销毁重建地图） */
  if (document.addEventListener) {
    document.addEventListener('themechange', function () { applyTheme(); });
  }

  global.MapKit = MapKit;
})(window);
