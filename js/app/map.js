/**
 * app/map.js —— MapKit 地图管理（Leaflet + 本地 Canvas 网格底图）
 * 挂载：window.MapKit
 * 底图：L.GridLayer.extend 画浅色网格 + 中心经纬度标注，零外部请求（审核合规）。
 * 图层治理（防跨页污染核心）：create() 递增 epoch；临时图层统一 tempGroup；
 * 回放/轨迹动画闭包校验 mapAlive() + epoch；所有函数入口先判 mapAlive()。
 */
(function (global) {
  'use strict';
  var U = global.Utils;
  var CFG = global.CFG;

  var state = {
    map: null,
    epoch: 0,
    tempGroup: null,
    fenceGroup: null,
    petMarkers: {},      // imei -> {layer, info}
    turbo: null,         // {imei, timer, onTick}
    lockedImei: null,    // 卡片点击锁定
    focusZoom: 15
  };

  function mapAlive() {
    return !!(state.map && state.map._container && document.body.contains(state.map._container));
  }

  function destroyMap() {
    state.epoch++;
    state.petMarkers = {};
    state.turbo = null;
    state.tempGroup = null;
    state.fenceGroup = null;
    if (state.map) {
      try { state.map.remove(); } catch (e) { /* ignore */ }
      state.map = null;
    }
  }

  /**
   * Canvas 网格底图：浅色网格 + 中心经纬度标注
   */
  var GridLayer = L.GridLayer.extend({
    createTile: function (coords) {
      var tile = document.createElement('canvas');
      var size = this.getTileSize();
      tile.width = size.x;
      tile.height = size.y;
      var ctx = tile.getContext('2d');
      var bg = '#f4f7fb';
      ctx.fillStyle = bg;
      ctx.fillRect(0, 0, size.x, size.y);
      ctx.strokeStyle = '#dde5ef';
      ctx.lineWidth = 1;
      var step = 40;
      for (var x = 0; x <= size.x; x += step) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, size.y);
        ctx.stroke();
      }
      for (var y = 0; y <= size.y; y += step) {
        ctx.beginPath();
        ctx.moveTo(0, y);
        ctx.lineTo(size.x, y);
        ctx.stroke();
      }
      // 中心经纬度标注
      var nw = this._map && this._map.options.crs ? this._map.unproject(coords.scaleBy(size), coords.z) : null;
      if (nw) {
        ctx.fillStyle = '#9aa8bd';
        ctx.font = '11px sans-serif';
        ctx.fillText(nw.lat.toFixed(3) + ',' + nw.lng.toFixed(3), 8, 20);
      }
      return tile;
    }
  });

  /**
   * 创建地图（容器必须在 DOM 中）
   * 底图：高德瓦片（GCJ02，与平台数据坐标系一致，无需转换），
   * 失败时降级 Canvas 网格底图（tileerror 自动切换）。
   */
  function create(containerId, opts) {
    opts = opts || {};
    destroyMap(); // 防重复实例
    var el = document.getElementById(containerId);
    if (!el) return null;
    state.epoch++;
    var myEpoch = state.epoch;
    var map = L.map(el, {
      center: opts.center || [30.65, 104.06],
      zoom: opts.zoom || 5,
      zoomControl: true,
      attributionControl: false, // 审核要求
      zoomSnap: 1
    });
    state.map = map;
    // 底层：Canvas 网格（瓦片加载失败时的兜底底色）
    map.addLayer(new GridLayer());
    // 上层：高德瓦片（GCJ02）。子域 01-04 轮询；加载失败自动移除露出网格
    var tileErrors = 0;
    var tiles = L.tileLayer('https://webrd0{s}.is.autonavi.com/appmaptile?lang=zh_cn&size=1&scale=1&style=8&x={x}&y={y}&z={z}', {
      subdomains: ['1', '2', '3', '4'],
      maxZoom: 18,
      minZoom: 3,
      crossOrigin: true,
      errorTileUrl: 'data:image/gif;base64,R0lGODlhAQABAIAAAP///wAAACwAAAAAAQABAAACAkQBADs='
    });
    tiles.on('tileerror', function () {
      tileErrors++;
      // 连续多块失败（断网/被墙）则移除瓦片层，保留网格兜底
      if (tileErrors >= 8 && tiles._map) {
        try { map.removeLayer(tiles); } catch (e) { /* ignore */ }
      }
    });
    tiles.addTo(map);
    state.tempGroup = L.layerGroup().addTo(map);
    state.fenceGroup = L.layerGroup().addTo(map);
    // 300ms 校准（页面切换后容器尺寸变化）
    setTimeout(function () {
      if (state.map && state.map === map && mapAlive()) {
        try { map.invalidateSize(); } catch (e) { /* ignore */ }
      }
    }, 300);
    return map;
  }

  function getMap() { return state.map; }
  function epoch() { return state.epoch; }

  /* ---------------- 设备 marker ---------------- */

  function markerIcon(kind) {
    var color = kind === 'offline' ? '#9aa3b2' : '#2f7bff';
    var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="42" viewBox="0 0 34 42">' +
      '<path d="M17 1C9.3 1 3 7.3 3 15c0 10.4 12.2 25.2 13.2 26.4a1.3 1.3 0 0 0 1.6 0C18.8 40.2 31 25.4 31 15 31 7.3 24.7 1 17 1z" fill="' + color + '" stroke="#ffffff" stroke-width="1.5"/>' +
      '<circle cx="17" cy="15" r="5.5" fill="#ffffff" opacity="0.95"/></svg>';
    var icon = L.divIcon({
      className: 'pet-marker',
      html: svg,
      iconSize: [34, 42],
      iconAnchor: [17, 40],
      popupAnchor: [0, -36]
    });
    return icon;
  }

  /**
   * upsert 设备 marker（status 对象见 AC.getPetStatus）
   */
  function upsertMarker(status) {
    if (!mapAlive() || !status || !status.imei) return null;
    var imei = status.imei;
    var hasLoc = status.lng !== undefined && status.lat !== undefined && isFinite(status.lng) && isFinite(status.lat);
    var lng = Number(status.lng);
    var lat = Number(status.lat);
    if (!hasLoc) return null;
    var offline = status.ts ? (Date.now() - status.ts > 5 * 60 * 1000) : false;
    var existing = state.petMarkers[imei];
    var layer = existing ? existing.layer : null;
    if (!layer) {
      layer = L.marker([lat, lng], { icon: markerIcon(offline ? 'offline' : 'online'), title: imei }).addTo(state.map);
      layer.bindPopup('', { maxWidth: 340, minWidth: 300, className: 'pet-popup' });
      layer.on('click', function () {
        state.lockedImei = imei;
        openPopupFor(imei);
      });
      state.petMarkers[imei] = { layer: layer, info: status };
    } else {
      layer.setLatLng([lat, lng]);
      layer.setIcon(markerIcon(offline ? 'offline' : 'online'));
      state.petMarkers[imei].info = status;
    }
    // 同步 popup 内容（打开中实时更新）
    if (layer.isPopupOpen()) {
      layer.setPopupContent(popupHtml(status));
    }
    return layer;
  }

  /**
   * 设备弹窗 HTML（核心：IMEI/经纬/地址/速度角度海拔/卫星/电量/信号/时间/实时追踪按钮）
   */
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
    return html;
  }

  function openPopupFor(imei) {
    var m = state.petMarkers[imei];
    if (m && m.layer) {
      m.layer.setPopupContent(popupHtml(m.info));
      try { m.layer.openPopup(); } catch (e) { /* ignore */ }
    }
  }

  function refreshOpenPopups() {
    if (!mapAlive()) return;
    for (var imei in state.petMarkers) {
      var m = state.petMarkers[imei];
      if (m.layer && m.layer.isPopupOpen()) {
        m.layer.setPopupContent(popupHtml(m.info));
      }
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
    for (var imei in state.petMarkers) {
      var m = state.petMarkers[imei];
      if (m.layer && !m.layer._map) {
        try { m.layer.addTo(state.map); } catch (e) { /* ignore */ }
      }
    }
  }

  function startTurbo(imei, onTick) {
    if (!mapAlive() || !imei || state.turbo) return false;
    state.turbo = { imei: imei, timer: null, onTick: onTick };
    setTurboFocus(imei, true);
    // 500ms 轮询刷新
    state.turbo.timer = setInterval(function () {
      if (!mapAlive() || !state.turbo) { if (state.turbo) stopTurbo(); return; }
      var m = state.petMarkers[imei];
      if (m && m.layer && m.layer.isPopupOpen()) {
        m.layer.setPopupContent(popupHtml(m.info));
      }
      if (typeof onTick === 'function') {
        try { onTick(imei); } catch (e) { /* ignore */ }
      }
    }, 500);
    return true;
  }

  function setTurboFocus(imei, follow) {
    if (!mapAlive()) return;
    var m = state.petMarkers[imei];
    if (!m || !m.layer) return;
    // 隐藏其它
    for (var k in state.petMarkers) {
      if (k === imei) continue;
      var other = state.petMarkers[k];
      if (other.layer && other.layer._map) {
        try { other.layer.remove(); } catch (e) { /* ignore */ }
      }
    }
    if (follow) {
      state.map.setView(m.layer.getLatLng(), 18);
    } else {
      state.map.setView(m.layer.getLatLng(), 16);
    }
  }

  /* ---------------- 卡片 hover/click 缩放 ---------------- */

  function focusOn(imei, zoom) {
    var m = state.petMarkers[imei];
    if (!m || !m.layer || !mapAlive()) return false;
    var hasLoc = m.info && m.info.lng !== undefined && isFinite(m.info.lng);
    if (!hasLoc) return false;
    if (state.lockedImei === imei) {
      state.map.setView(m.layer.getLatLng(), Math.max(zoom, 16));
    } else {
      state.map.setView(m.layer.getLatLng(), zoom || 15);
    }
    return true;
  }

  function setLocked(imei) { state.lockedImei = imei; }
  function locked() { return state.lockedImei; }

  /* ---------------- 临时图层（轨迹/围栏绘制预览） ---------------- */

  function addTemp(layer) {
    if (!state.tempGroup) return;
    layer.addTo(state.tempGroup);
  }
  function clearTemp() {
    if (state.tempGroup) state.tempGroup.clearLayers();
  }
  function fenceGroup() { return state.fenceGroup; }
  function clearFences() {
    if (state.fenceGroup) state.fenceGroup.clearLayers();
  }
  function addFence(layer) {
    if (!state.fenceGroup) return;
    layer.addTo(state.fenceGroup);
  }

  /* ---------------- document 委托：data-turbo ---------------- */

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
    setLocked: setLocked,
    locked: locked,
    addTemp: addTemp,
    clearTemp: clearTemp,
    fenceGroup: fenceGroup,
    clearFences: clearFences,
    addFence: addFence,
    bindDelegates: bindDelegates,
    state: state
  };

  global.MapKit = MapKit;
})(window);