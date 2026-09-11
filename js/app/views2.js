/**
 * app/views2.js —— 轨迹回放 / 电子围栏 / 报警 / 设备状态 / 性能监控
 * 挂载：window.Views（合并进主 Views 对象）
 */
(function (global) {
  'use strict';
  // 主题取色：地图/Canvas 画在 DOM 之外，拿不到 var()，必须显式取色。
  // 取不到 Theme 时退回原硬编码值，保证 theme.js 未加载也不影响绘制。
  var TH = global.Theme || { cssVar: function (n, f) { return f; } };
  var U = global.Utils;
  var CFG = global.CFG;
  var AC = global.AC;
  var MapKit = global.MapKit;
  var PetStore = global.PetStore;
  var FenceStore = global.FenceStore;
  var PetStatus = global.PetStatus;
  var Views = global.Views;

  /* ================= #/track 轨迹回放 ================= */

  function renderTrack(imei) {
    Views.state.view = 'track';
    Views.activeNav('track');
    var root = document.getElementById('view-root');
    var devices = Views.state.devices || [];
    root.innerHTML =
      '<div class="page-wide">' +
      '  <h2>🛤️ 轨迹回放' + (imei ? ' · ' + U.esc(imei) : '') + '</h2>' +
      '  <div class="track-bar">' +
      '    <select id="tr-imei" class="sel">' +
      (devices.length ? devices.map(function (d) {
        return '<option value="' + U.esc(d.deviceid) + '"' + (d.deviceid === imei ? ' selected' : '') + '>' + U.esc(PetStore.nameOf(d.deviceid)) + ' · ' + U.esc(d.deviceid) + '</option>';
      }).join('') : '') +
      '    </select>' +
      '    <input type="date" id="tr-start"> <span class="mute">至</span> <input type="date" id="tr-end">' +
      '    <button id="tr-query" class="btn">🔍 查询</button>' +
      '    <button id="tr-play" class="btn" disabled>▶️ 回放</button>' +
      '    <button id="tr-stop" class="btn ghost" disabled>⏹ 停止</button>' +
      '    <select id="tr-speed" class="sel" title="回放倍率">' +
      '      <option value="1">1×</option><option value="4">4×</option><option value="16">16×</option><option value="60">60×</option><option value="120" selected>120×</option><option value="240">240×</option><option value="600">600×</option><option value="1200">1200×</option><option value="2400">2400×</option>' +
      '    </select>' +
      '  </div>' +
      '  <div id="tr-progress" class="tr-progress hidden"><div class="tr-bar"><div class="tr-fill"></div></div><span class="tr-text"></span></div>' +
      '  <div id="track-map" class="map-track"></div>' +
      '</div>';
    Views.clearTimers();

    var today = U.todayLocal();
    var start = document.getElementById('tr-start');
    var end = document.getElementById('tr-end');
    start.value = today;
    end.value = today;

    var trData = { points: [], playTimer: null, marker: null };

    if (!devices.length) {
      // 拉到设备列表后填充下拉
      Views.ensureProject().then(function (key) {
        if (!key) return null;
        return Views.loadDevices().then(function (devs) {
          var sel = document.getElementById('tr-imei');
          if (!sel || !sel.isConnected) return; // 页面已切换
          sel.innerHTML = devs.map(function (d) {
            return '<option value="' + U.esc(d.deviceid) + '">' + U.esc(PetStore.nameOf(d.deviceid)) + ' · ' + U.esc(d.deviceid) + '</option>';
          }).join('');
        });
      })['catch'](function () { /* ignore */ });
    }

    document.getElementById('tr-query').addEventListener('click', function () {
      var imeiSel = document.getElementById('tr-imei').value;
      if (!imeiSel) { U.toast('请先选择设备', 'err'); return; }
      var s = start.value + ' 00:00:00';
      var e = end.value + ' 23:59:59';
      if (!start.value || !end.value) { U.toast('请选择日期范围', 'err'); return; }
      MapKit.create('track-map', { center: [30.65, 104.06], zoom: 5 });
      MapKit.clearTemp();
      var prog = document.getElementById('tr-progress');
      var fill = prog.querySelector('.tr-fill');
      var ptext = prog.querySelector('.tr-text');
      prog.classList.remove('hidden');
      document.getElementById('tr-play').disabled = true;
      AC.getTrack(imeiSel, s, e, {
        onProgress: function (n, total) {
          var pct = total > 0 ? Math.min(100, Math.round(n / total * 100)) : 100;
          fill.style.width = pct + '%';
          ptext.textContent = '已加载 ' + n + ' / ' + (total || n) + ' 条';
        }
      }).then(function (points) {
        prog.classList.add('hidden');
        trData.points = points || [];
        if (!trData.points.length) {
          U.toast('该时间段内无轨迹数据');
          return;
        }
        drawTrack(trData.points);
        document.getElementById('tr-play').disabled = false;
        // 反馈精细度构成，便于判断 1294 差分点是否生效
        var gnss = 0;
        for (var i = 0; i < trData.points.length; i++) {
          if (trData.points[i].source === 'gnss') gnss++;
        }
        trData.gnssCount = gnss;
        U.toast('共 ' + trData.points.length + ' 个轨迹点' + (gnss ? '（含 ' + gnss + ' 个 GNSS 精细点）' : ''));
      });
    });

    document.getElementById('tr-play').addEventListener('click', function () {
      if (!trData.points.length) return;
      var spdSel = document.getElementById('tr-speed');
      trData.speed = spdSel ? (Number(spdSel.value) || 120) : 120;
      startReplay(trData);
    });
    var spdSel = document.getElementById('tr-speed');
    if (spdSel) {
      spdSel.addEventListener('change', function () {
        if (trData.playTimer) { startReplay(trData); }
      });
    }
    document.getElementById('tr-stop').addEventListener('click', function () {
      stopReplay(trData);
    });
  }

  function drawTrack(points) {
    if (!MapKit.mapAlive()) return;
    MapKit.clearTemp();
    var path = [];
    points.forEach(function (p) {
      if (isFinite(p.lng) && isFinite(p.lat)) {
        var c = p.coord === CFG.COORD_WGS84 ? Algo.wgs84ToGcj02(p.lng, p.lat) : [p.lng, p.lat];
        path.push(c);
      }
    });
    // 展开 1294 后点数可达数千；极端情况下等距抽稀，避免渲染卡顿
    if (path.length > 20000) {
      var thin = [];
      var stride = Math.ceil(path.length / 20000);
      for (var k = 0; k < path.length; k += stride) thin.push(path[k]);
      thin.push(path[path.length - 1]);
      path = thin;
    }
    if (path.length) {
      MapKit.addTemp({ kind: 'polyline', points: path, color: '--brand-600', weight: 4, opacity: 0.85 });
      MapKit.addTemp({ kind: 'dot', point: path[0], radius: 8, color: '--ok' });
      MapKit.addTemp({ kind: 'dot', point: path[path.length - 1], radius: 8, color: '--danger' });
      MapKit.fitBounds(path, { padding: 40 });
    }
  }

  function startReplay(trData) {
    stopReplay(trData);
    if (trData.marker) { trData.marker.remove(); trData.marker = null; }
    var myEpoch = MapKit.epoch();
    var pts = trData.points.filter(function (p) { return isFinite(p.lng) && isFinite(p.lat); });
    if (!pts.length) return;
    var idx = 0;
    var m = MapKit.addTemp({ kind: 'dot', point: [pts[0].lng, pts[0].lat], radius: 7, color: '--warn' });
    trData.marker = m;
    // 回放倍率（speed 由 UI 控制，默认 120）
    var speed = trData.speed || 120;
    var rawSpan = (pts[pts.length - 1].ts - pts[0].ts) || 60000;
    var totalMs = Math.max(2000, rawSpan / speed);
    var stepMs = totalMs / pts.length;
    trData.playTimer = setInterval(function () {
      if (!MapKit.mapAlive() || MapKit.epoch() !== myEpoch) { stopReplay(trData); return; }
      if (idx >= pts.length) { stopReplay(trData); return; }
      var p = pts[idx];
      if (m) m.move([p.lng, p.lat]);
      idx++;
    }, Math.max(16, stepMs));
  }

  function stopReplay(trData) {
    if (trData.playTimer) { clearInterval(trData.playTimer); trData.playTimer = null; }
  }

  /* ================= #/fence 电子围栏 ================= */

  /** 两点球面距离（米） */
  function distanceM(lng1, lat1, lng2, lat2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var la1 = lat1 * Math.PI / 180, la2 = lat2 * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  function renderFence() {
    Views.state.view = 'fence';
    Views.activeNav('fence');
    var root = document.getElementById('view-root');
    root.innerHTML =
      '<div class="home-wrap">' +
      '  <div id="fence-map" class="map-full"></div>' +
      '  <aside class="fence-panel">' +
      '    <div class="fp-cards">' +
      '      <button id="f-circle" class="fp-btn-card"><span class="fp-ic">⭕</span><b>圆形围栏</b><i>点圆心 → 点半径</i></button>' +
      '      <button id="f-polygon" class="fp-btn-card"><span class="fp-ic">⬠</span><b>多边形围栏</b><i>依次点顶点 → 完成</i></button>' +
      '    </div>' +
      '  </aside>' +
      '  <div id="fence-list" class="fence-list"></div>' +
      '  <div id="fence-tip" class="fence-tip hidden"></div>' +
      '  <div id="fence-actions" class="fence-actions hidden">' +
      '    <button id="f-undo" class="btn sm ghost hidden">↩ 撤销一点</button>' +
      '    <button id="f-cancel" class="btn sm ghost">取消</button>' +
      '    <button id="f-done" class="btn sm hidden">✓ 完成绘制</button>' +
      '  </div>' +
      '</div>';
    Views.clearTimers();

    var map = MapKit.create('fence-map', { center: [30.65, 104.06], zoom: 12 });
    renderFenceList();
    drawAllFences();

    var st = { mode: 'idle', circleCenter: null, polyPoints: [], preview: null, previewCircle: null };

    // 保存围栏时要选「针对哪台设备」，设备列表走缓存（60s TTL），进页面就预热
    var fenceDevices = [];
    Views.loadDevices().then(function (ds) { fenceDevices = ds || []; })['catch'](function () { /* ignore */ });

    function $(id) { return document.getElementById(id); }

    /**
     * 围栏保存弹窗：名称输入 + 生效设备多选。
     * ID 沿用 dlg-input / dlg-ok / dlg-cancel（离线验证 harness 按这三个 ID 驱动）。
     * 不勾任何设备 = 对全部设备生效（兼容旧数据）。
     */
    function fenceSaveDialog(opts, onOk) {
      var rows = fenceDevices.map(function (d) {
        return '<label class="fd-item">' +
          '<input type="checkbox" value="' + U.esc(d.deviceid) + '">' +
          '<span>' + U.esc(PetStore.nameOf(d.deviceid)) + '</span>' +
          '<i>' + U.esc(d.deviceid) + '</i></label>';
      }).join('');
      var body =
        '<div class="form">' +
        '  <label>围栏名称</label>' +
        '  <input id="dlg-input" type="text" value="' + U.esc(opts.nameValue || '') + '">' +
        (opts.hint ? '  <div class="mute" style="margin-top:4px">' + U.esc(opts.hint) + '</div>' : '') +
        '</div>' +
        '<div class="fd-head">生效设备</div>' +
        '<div class="fd-sub">不勾选 = 对全部设备生效</div>' +
        '<div class="fd-list">' + (rows || '<div class="fd-empty">设备列表加载中…（保存后仍可生效于全部设备）</div>') + '</div>';
      var box = Views.modal(opts.title || '保存围栏', body,
        '<button class="btn ghost" id="dlg-cancel">取消</button>' +
        '<button class="btn" id="dlg-ok">' + U.esc(opts.okText || '保存围栏') + '</button>');
      var input = box.querySelector('#dlg-input');
      var okBtn = box.querySelector('#dlg-ok');
      function finish(save) {
        if (!box.parentNode) return;
        box.parentNode.removeChild(box);
        if (!save) return;
        var imeis = [];
        Array.prototype.forEach.call(box.querySelectorAll('.fd-item input:checked'), function (cb) {
          imeis.push(cb.value);
        });
        onOk(input ? input.value.trim() : '', imeis);
      }
      var x = box.querySelector('.modal-close');
      if (x) x.addEventListener('click', function () { finish(false); });
      box.addEventListener('click', function (e) { if (e.target === box) finish(false); });
      var cancel = box.querySelector('#dlg-cancel');
      if (cancel) cancel.addEventListener('click', function () { finish(false); });
      if (okBtn) okBtn.addEventListener('click', function () { finish(true); });
      if (input) setTimeout(function () { try { input.focus(); input.select(); } catch (e) { /* ignore */ } }, 60);
    }

    function tip(msg) {
      var el = $('fence-tip');
      if (!el) return;
      el.textContent = msg;
      el.classList.remove('hidden');
    }
    function hideTip() {
      var el = $('fence-tip');
      if (el) el.classList.add('hidden');
    }
    /** 绘制期操作条：按模式显示「撤销一点 / 取消 / 完成绘制」 */
    function showActions(opts) {
      var bar = $('fence-actions');
      if (!bar) return;
      if (!opts) { bar.classList.add('hidden'); return; }
      bar.classList.remove('hidden');
      var undo = $('f-undo'), done = $('f-done');
      if (undo) undo.classList[opts.undo ? 'remove' : 'add']('hidden');
      if (done) done.classList[opts.done ? 'remove' : 'add']('hidden');
    }

    function resetMode() {
      st.mode = 'idle';
      st.circleCenter = null;
      st.polyPoints = [];
      if (st.preview) { st.preview.remove(); st.preview = null; }
      if (st.previewCircle) { st.previewCircle.remove(); st.previewCircle = null; }
      hideTip();
      showActions(null);
    }

    /**
     * 完成多边形绘制并保存
     * 原实现只支持「双击地图完成」，触屏上双击极易与缩放/单击冲突导致围栏存不下来；
     * 现改为显式按钮，双击仅作为桌面端的快捷方式保留。
     */
    function finishPolygon() {
      if (st.mode !== 'polygon' || st.polyPoints.length < 3) {
        U.toast('至少需要 3 个顶点', 'err');
        return;
      }
      var pts = st.polyPoints.slice();
      st.mode = 'idle';
      showActions(null);
      hideTip();
      fenceSaveDialog({
        title: '⬠ 保存多边形围栏',
        nameValue: '我的多边形围栏',
        hint: '共 ' + pts.length + ' 个顶点',
        okText: '保存围栏'
      }, function (name, imeis) {
        FenceStore.add({ kind: 'polygon', name: name || '多边形围栏', points: pts, imeis: imeis });
        U.toast('✅ 多边形围栏已保存' + (imeis.length ? '（针对 ' + imeis.length + ' 台设备）' : '（全部设备）'));
        resetMode();
        renderFenceList();
        drawAllFences();
      });
    }

    $('f-circle').addEventListener('click', function () {
      resetMode();
      st.mode = 'circle_center';
      tip('⭕ 请在地图上点击圆心位置');
      showActions({});
    });
    $('f-polygon').addEventListener('click', function () {
      resetMode();
      st.mode = 'polygon';
      tip('⬠ 依次点击加顶点（≥3 个），完成后点「完成绘制」');
      showActions({});
    });
    $('f-cancel').addEventListener('click', function () { resetMode(); U.toast('已取消绘制'); });
    $('f-undo').addEventListener('click', function () {
      if (st.mode !== 'polygon' || !st.polyPoints.length) return;
      st.polyPoints.pop();
      if (st.preview) st.preview.setPath(st.polyPoints);
      var n = st.polyPoints.length;
      tip(n >= 3 ? ('已加 ' + n + ' 个顶点，可点「完成绘制」') : ('已加 ' + n + ' 个顶点，至少需要 3 个'));
      showActions({ undo: n > 0, done: n >= 3 });
    });
    $('f-done').addEventListener('click', finishPolygon);

    MapKit.on('click', function (e) {
      if (!MapKit.mapAlive()) return;
      var lat = e.lat, lng = e.lng;
      if (st.mode === 'circle_center') {
        st.circleCenter = [lng, lat];
        st.mode = 'circle_radius';
        st.preview = MapKit.addTemp({ kind: 'dot', point: [lng, lat], radius: 5, color: '--brand-600' });
        // 圆心一落点就建预览圆（半径 0 起步）：触屏没有 mousemove，
        // 不建的话第二次点击前用户完全看不到圆在长多大
        if (!st.previewCircle) {
          st.previewCircle = MapKit.addTemp({
            kind: 'circle', center: [lng, lat], radius: 0,
            color: '--brand-600', fillOpacity: FENCE_PREVIEW_FILL
          });
        }
        tip('再点一处确定半径（≥20 米）；鼠标移动可实时预览大小');
      } else if (st.mode === 'circle_radius') {
        var dist = distanceM(st.circleCenter[0], st.circleCenter[1], lng, lat);
        if (dist < 20) { U.toast('半径需 ≥ 20 米', 'err'); return; }
        var radius = Math.round(dist);
        var center = [st.circleCenter[0], st.circleCenter[1]];
        // 定格最终半径：触屏没有 mousemove，第二击必须补上预览圆，
        // 否则保存弹窗期间用户看到的还是「裸圆心」，不知道自己画了多大
        if (!st.previewCircle) {
          st.previewCircle = MapKit.addTemp({
            kind: 'circle', center: center, radius: dist,
            color: '--brand-600', fillOpacity: FENCE_PREVIEW_FILL
          });
        } else {
          st.previewCircle.setRadius(dist);
        }
        st.mode = 'idle';                     // 冻结绘制，避免弹窗期间继续改半径
        showActions(null);
        fenceSaveDialog({
          title: '⭕ 保存圆形围栏',
          nameValue: '我的围栏',
          hint: '半径 ' + radius + ' 米 · 圆心 ' + center[0].toFixed(5) + ', ' + center[1].toFixed(5),
          okText: '保存围栏'
        }, function (name, imeis) {
          FenceStore.add({ kind: 'circle', name: name || '我的围栏', center: center, radius: radius, imeis: imeis });
          U.toast('✅ 围栏已保存' + (imeis.length ? '（针对 ' + imeis.length + ' 台设备）' : '（全部设备）'));
          resetMode();
          renderFenceList();
          drawAllFences();
        });
      } else if (st.mode === 'polygon') {
        st.polyPoints.push([lng, lat]);
        if (!st.preview) {
          st.preview = MapKit.addTemp({ kind: 'polyline', points: [], color: '--brand-500', weight: 3, dash: '6 4' });
        }
        st.preview.setPath(st.polyPoints);
        var n = st.polyPoints.length;
        tip(n >= 3 ? ('已加 ' + n + ' 个顶点，可点「完成绘制」') : ('已加 ' + n + ' 个顶点，至少需要 3 个'));
        showActions({ undo: true, done: n >= 3 });
      }
    });

    /** 绘制期预览圆的填充透明度（保存后的围栏更实一些，见 map.js addFence） */
    var FENCE_PREVIEW_FILL = 0.18;

    MapKit.on('mousemove', function (e) {
      if (st.mode === 'circle_radius' && st.circleCenter && MapKit.mapAlive()) {
        var dist = distanceM(st.circleCenter[0], st.circleCenter[1], e.lng, e.lat);
        if (!st.previewCircle) {
          st.previewCircle = MapKit.addTemp({ kind: 'circle', center: st.circleCenter, radius: dist, color: '--brand-600', fillOpacity: FENCE_PREVIEW_FILL });
        } else {
          st.previewCircle.setRadius(dist);
        }
        // 实时报半径：用户拖动时能直接看到「这个围栏大概多大」
        tip('半径约 ' + Math.round(dist) + ' 米 · 点击地图确定（≥20 米）');
      }
    });

    MapKit.on('dblclick', function () {
      if (st.mode === 'polygon' && st.polyPoints.length >= 3) finishPolygon();
    });
  }

  function drawAllFences() {
    if (!MapKit.mapAlive()) return;
    MapKit.clearFences();
    FenceStore.all().forEach(function (f) {
      if (!f.enabled) return;
      if (f.kind === 'circle') {
        MapKit.addFence({ kind: 'circle', center: f.center, radius: f.radius, name: f.name });
      } else if (f.kind === 'polygon') {
        MapKit.addFence({ kind: 'polygon', points: f.points, name: f.name });
      }
    });
  }

  function renderFenceList() {
    var box = document.getElementById('fence-list');
    if (!box) return;
    var list = FenceStore.all();
    if (!list.length) { box.innerHTML = '<div class="empty-card">暂无围栏</div>'; box.style.display = 'none'; return; }
    box.style.display = '';
    box.innerHTML = list.map(function (f) {
      // 生效设备：空 = 全部设备；多台超 2 个折叠显示，避免列表撑爆
      var imeis = (f.imeis || []).map(String);
      var target;
      if (!imeis.length) {
        target = '全部设备';
      } else if (imeis.length <= 2) {
        target = imeis.map(function (i) { return PetStore.nameOf(i); }).join('、');
      } else {
        target = PetStore.nameOf(imeis[0]) + ' 等 ' + imeis.length + ' 台';
      }
      return '<div class="fl-item" data-id="' + U.esc(f.id) + '">' +
        '<div class="fl-main"><b>' + U.esc(f.name) + '</b><span class="fl-sub">' +
        (f.kind === 'circle' ? '⭕ 圆形 · ' + f.radius + 'm' : '⬠ 多边形 · ' + (f.points || []).length + ' 点') +
        ' · 🐾 ' + U.esc(target) +
        '</span></div>' +
        '<div class="fl-acts">' +
        '<button class="btn xs" data-act="toggle">' + (f.enabled ? '停用' : '启用') + '</button>' +
        '<button class="btn xs" data-act="loc">📍</button>' +
        '<button class="btn xs danger" data-act="del">🗑</button>' +
        '</div></div>';
    }).join('');
    U.$all('.fl-item', box).forEach(function (item) {
      var id = item.getAttribute('data-id');
      U.$all('button', item).forEach(function (btn) {
        btn.addEventListener('click', function (evt) {
          evt.stopPropagation();
          var act = btn.getAttribute('data-act');
          var f = FenceStore.get(id);
          if (act === 'toggle') {
            FenceStore.update(id, { enabled: !f.enabled });
            renderFenceList();
            drawAllFences();
          } else if (act === 'loc') {
            var c = f.kind === 'circle' ? f.center : f.points[0];
            if (c && MapKit.mapAlive()) MapKit.focusPoint(c, 15);
          } else if (act === 'del') {
            Views.confirmDialog({
              title: '🗑 删除围栏',
              html: '确定删除围栏「<b>' + U.esc(f ? f.name : '') + '</b>」吗？<br>' +
                    '<span class="mute">该围栏的越界报警记录会保留在报警列表中。</span>',
              okText: '删除',
              danger: true
            }, function () {
              FenceStore.remove(id);
              renderFenceList();
              drawAllFences();
              U.toast('已删除围栏');
            });
          }
        });
      });
    });
  }

  /* ================= #/alerts 报警 ================= */

  function renderAlerts() {
    Views.state.view = 'alerts';
    Views.activeNav('alerts');
    var root = document.getElementById('view-root');
    root.innerHTML =
      '<div class="page">' +
      '  <h2>🚨 越界报警</h2>' +
      '  <div id="push-row"></div>' +
      '  <div id="al-list"></div>' +
      '</div>';
    Views.clearTimers();
    renderPushRow();
    renderAlertsList();
    Views.state.timers.push(setInterval(renderAlertsList, 15000));
  }

  /**
   * 推送设置行：开关 + 测试
   * 测试按钮不受开关限制，方便用户先确认通道是否通，再决定开不开。
   */
  function renderPushRow() {
    var box = document.getElementById('push-row');
    if (!box) return;
    var on = global.Push ? Push.enabled() : false;
    var ch = global.Push ? Push.channelName() : '不可用';
    box.innerHTML =
      '<div class="push-row">' +
      '  <div class="pr-main">' +
      '    <b>报警消息推送</b>' +
      '    <div class="pr-sub">' + (on ? '已开启' : '已关闭') + ' · 通道：' + U.esc(ch) + '</div>' +
      '  </div>' +
      '  <div class="pr-side">' +
      '    <button class="btn sm" type="button" id="push-test">测试</button>' +
      '    <button class="switch' + (on ? ' on' : '') + '" type="button" id="push-switch"' +
      ' role="switch" aria-checked="' + (on ? 'true' : 'false') + '" aria-label="报警消息推送"></button>' +
      '  </div>' +
      '</div>';

    var sw = document.getElementById('push-switch');
    if (sw) {
      sw.addEventListener('click', function () {
        var next = !Push.enabled();
        Push.setEnabled(next);
        renderPushRow();          // 先立即重绘：开关要马上给出视觉反馈
        if (next) {
          // 浏览器通道需要用户授权；APP 原生通道无需授权。
          // 授权结论回来后刷新一次通道文案。
          Push.requestPermission()['catch'](function () { return null; })['then'](function () {
            renderPushRow();
          });
          U.toast('✅ 已开启报警推送（' + Push.channelName() + '）');
        } else {
          U.toast('已关闭报警推送');
        }
      });
    }

    var t = document.getElementById('push-test');
    if (t) {
      t.addEventListener('click', function () {
        var used = Push.test();
        if (used === 'native') U.toast('已推送到系统通知栏，请下拉查看');
        else if (used === 'web') U.toast('已通过浏览器通知发送');
        else U.toast('当前环境不支持系统通知（WebView 需走 APP 端），仅能应用内提示', 'err');
      });
    }
  }

  function renderAlertsList() {
    var box = document.getElementById('al-list');
    if (!box) return;
    var list = FenceStore.alerts();
    if (!list.length) {
      box.innerHTML = '<div class="empty">暂无越界报警</div>';
      return;
    }
    var unhandled = list.filter(function (a) { return !a.handled; }).length;
    var toolbar = unhandled > 0
      ? '<div class="al-toolbar"><span class="al-count">未处理 <b>' + unhandled + '</b> 条</span><button class="btn sm" id="al-all-handled">✅ 全部标记已处理</button></div>'
      : '';
    box.innerHTML = toolbar + list.map(function (a) {
      var f = FenceStore.get(a.fenceId);
      var doneCls = a.handled ? ' al-done' : '';
      var tag = a.handled
        ? '<span class="al-done-tag">✅ 已处理</span>'
        : '<button class="btn sm" data-mark="' + U.esc(a.id) + '">✅ 标记已处理</button>';
      return '<div class="al-item' + doneCls + '" data-id="' + U.esc(a.id) + '">' +
        '<div class="al-main"><b>' + U.esc(f ? f.name : '围栏已删除') + '</b> · <span>' + U.esc(PetStore.nameOf(a.imei)) + '</span></div>' +
        '<div class="al-sub">' + U.esc(U.fmtFull(a.ts)) + ' · ' + (a.address ? U.esc(a.address) : Number(a.lng).toFixed(5) + ',' + Number(a.lat).toFixed(5)) + '</div>' +
        '<div class="al-act">' + tag + '</div>' +
        '</div>';
    }).join('');

    U.$all('[data-mark]', box).forEach(function (btn) {
      btn.addEventListener('click', function () {
        FenceStore.markHandled(btn.getAttribute('data-mark'));
        Views.updateAlertDot();
        renderAlertsList();
      });
    });
    var allBtn = document.getElementById('al-all-handled');
    if (allBtn) {
      allBtn.addEventListener('click', function () {
        FenceStore.markAllHandled();
        Views.updateAlertDot();
        renderAlertsList();
      });
    }
  }

  /* ================= #/status 设备状态 ================= */

  function renderStatus(imei) {
    Views.state.view = 'status';
    Views.activeNav('status');
    var root = document.getElementById('view-root');
    var devices = Views.state.devices || [];
    root.innerHTML =
      '<div class="page">' +
      '  <h2>📊 设备状态（步数/姿态/跌倒）</h2>' +
      '  <div class="track-bar">' +
      '    <select id="st-imei" class="sel">' +
      (devices.length ? devices.map(function (d) {
        return '<option value="' + U.esc(d.deviceid) + '"' + (d.deviceid === imei ? ' selected' : '') + '>' + U.esc(PetStore.nameOf(d.deviceid)) + '</option>';
      }).join('') : '') +
      '    </select>' +
      '    <input type="date" id="st-date">' +
      '    <select id="st-tag" class="sel">' +
      CFG.TAG_LIST.map(function (t) { return '<option value="' + t.id + '">' + U.esc(t.name) + '</option>'; }).join('') +
      '    </select>' +
      '    <button id="st-go" class="btn">查询</button>' +
      '  </div>' +
      '  <div id="st-result"></div>' +
      '</div>';
    Views.clearTimers();
    document.getElementById('st-date').value = U.todayLocal();
    if (!devices.length) {
      // 拉到设备列表后重渲染下拉（statusSel 填充）
      Views.ensureProject().then(function (key) {
        if (!key) return;
        return Views.loadDevices().then(function (devs) {
          var sel = document.getElementById('st-imei');
          if (!sel || !sel.isConnected) return; // 页面已切换
          sel.innerHTML = devs.map(function (d) {
            return '<option value="' + U.esc(d.deviceid) + '">' + U.esc(PetStore.nameOf(d.deviceid)) + '</option>';
          }).join('');
        });
      })['catch'](function () { /* ignore */ });
    }
    document.getElementById('st-go').addEventListener('click', function () {
      var imeiSel = document.getElementById('st-imei').value;
      var date = document.getElementById('st-date').value;
      var tagSel = Number(document.getElementById('st-tag').value);
      if (!imeiSel || !date) { U.toast('请选择设备与日期', 'err'); return; }
      var box = document.getElementById('st-result');
      box.innerHTML = '<div class="empty">查询中…</div>';
      // 1293 私有 tag 需 allowCustom（listByTags 内部已放行）
      var filter = { aks: ['ct', 'ct'], acs: ['ge', 'le'], avs: [date + ' 00:00:00', date + ' 23:59:59'] };
      AC.fetchAllByTags(imeiSel, [1293, tagSel === 1293 ? 517 : tagSel], filter, {}).then(function (recs) {
        var analysis = PetStatus.analyze(recs, {});
        var sat = null;
        recs.forEach(function (r) {
          var v = AC.recVal(r, 517);
          if (v !== undefined && sat === null) sat = v;
        });
        if (!recs.length) {
          box.innerHTML = '<div class="empty">该日期无上报数据</div>';
          return;
        }
        box.innerHTML =
          '<div class="st-cards">' +
          stCard('👟', '步数', analysis.steps + ' 步') +
          stCard('🏃', '步频', analysis.cadence + ' 步/分') +
          stCard('🧭', '姿态', analysis.attitude ? ('横滚 ' + analysis.attitude.roll.toFixed(1) + '° / 俯仰 ' + analysis.attitude.pitch.toFixed(1) + '°') : '--') +
          stCard('🛰️', '卫星', sat !== null ? sat + ' 颗' : '--') +
          stCard('🚨', '跌倒检测', analysis.fall && analysis.fall.fall ? '⚠️ 检测到疑似跌倒（置信度 ' + Math.round(analysis.fall.confidence * 100) + '%）' : '未检测到') +
          stCard('📦', '数据包', recs.length + ' 条') +
          '</div>';
      });
    });
  }

  function stCard(icon, label, value) {
    return '<div class="st-card"><div class="st-ic">' + icon + '</div><div class="st-lb">' + U.esc(label) + '</div><div class="st-vl">' + U.esc(String(value)) + '</div></div>';
  }

  /* ================= #/debug 性能监控 ================= */

  function renderDebug() {
    Views.state.view = 'debug';
    Views.activeNav('debug');
    var root = document.getElementById('view-root');
    root.innerHTML = '<div class="page"><h2>🔧 性能监控</h2><div id="db-body"></div></div>';
    Views.clearTimers();

    function loadAll() {
      Views.ensureProject().then(function (key) {
        if (!key) return;
        var body = document.getElementById('db-body');
        if (!body) return; // 页面已切换
        body.innerHTML = '<div class="empty">加载中…</div>';
        Views.fillProjectSelect();
        return Views.loadDevices().then(function (devs) {
          if (!body.isConnected) return; // 页面已切换
          if (!devs || !devs.length) {
            body.innerHTML = '<div class="empty">暂无设备</div>';
            return;
          }
          body.innerHTML = devs.map(function (d) {
            var imei = d.deviceid;
            return '<div class="db-card" id="db-' + U.esc(imei) + '">' +
              '<div class="db-head"><b>' + U.esc(PetStore.nameOf(imei)) + '</b><span class="db-imei">' + U.esc(imei) + '</span>' +
              '<div class="pf-ranges" id="pfr-' + U.esc(imei) + '">' +
              ['半小时', '1小时', '6小时', '当自然天', '当自然月'].map(function (label, i) {
                return '<button class="pf-range dis' + (i === 3 ? ' sel' : '') + '" data-h="' + [0.5, 1, 6, 24, 720][i] + '">' + label + '</button>';
              }).join('') +
              '</div></div>' +
              '<div class="db-body" id="dbb-' + U.esc(imei) + '"><div class="empty">数据加载中…</div></div>' +
              '</div>';
          }).join('');
          devs.forEach(function (d, idx) {
            setTimeout(function () { debugOne(d.deviceid, 24); }, idx * 150);
          });
          bindRangeButtons();
        });
      })['catch'](function (e) {
        var body = document.getElementById('db-body');
        if (body) body.innerHTML = '<div class="empty">加载失败，请刷新重试</div>';
      });
    }
    loadAll();

    function bindRangeButtons() {
      U.$all('.db-card').forEach(function (card) {
        var imei = card.id.replace('db-', '');
        U.$all('.pf-range', card).forEach(function (btn) {
          btn.addEventListener('click', function () {
            if (btn.classList.contains('dis')) return;
            U.$all('.pf-range', card).forEach(function (b) { b.classList.remove('sel'); });
            btn.classList.add('sel');
            debugOne(imei, Number(btn.getAttribute('data-h')));
          });
        });
      });
    }
  }

  /**
   * 单设备性能数据（时间窗口小时数）
   */
  function debugOne(imei, hours) {
    var box = document.getElementById('dbb-' + imei);
    if (!box) return; // 异步页面归属守卫
    var end = new Date();
    var start = new Date(Date.now() - hours * 3600000);
    var filter = { aks: ['ct', 'ct'], acs: ['ge', 'le'], avs: [U.fmtFull(start.getTime()), U.fmtFull(end.getTime())] };
    AC.fetchAllByTags(imei, CFG.DEFAULT_STATUS_TAGS.concat([777]), filter, {}).then(function (recs) {
      if (!box.isConnected) return; // 页面已切换
      var ranges = document.getElementById('pfr-' + imei);
      if (ranges) {
        U.$all('.pf-range', ranges).forEach(function (b) { b.classList.remove('dis'); });
      }
      if (!recs || !recs.length) {
        box.innerHTML = '<div class="empty">窗口内无数据</div>';
        return;
      }
      // 电压序列
      var vbat = [], sig = [], cn = [], reboots = 0, lastBoot = null;
      recs.forEach(function (r) {
        var ts = U.recTs(r);
        var v = AC.recVal(r, 799);
        if (v !== undefined) vbat.push({ ts: ts, v: Number(v) });
        var s = AC.recVal(r, 782);
        if (s !== undefined) sig.push({ ts: ts, v: Number(s) });
        var c = AC.recVal(r, 515);
        if (c !== undefined) cn.push({ ts: ts, v: Number(c) });
        var bt = AC.recVal(r, 777);
        if (bt !== undefined) {
          var n = Number(bt);
          if (lastBoot !== null && n > lastBoot) reboots++;
          lastBoot = n;
        }
      });
      // 每小时耗电（首尾电压降 / 小时数）
      var drain = '--';
      if (vbat.length >= 2) {
        var dv = vbat[0].v - vbat[vbat.length - 1].v;
        var hrs = (vbat[vbat.length - 1].ts - vbat[0].ts) / 3600000;
        if (hrs > 0.2) drain = Math.round(dv / hrs) + ' mV/h';
      }
      var sigChart = sig.length >= 2
        ? '<div class="db-chart"><div class="db-chart-t">📶 信号（' + U.signalText(sig[sig.length - 1].v) + '）</div><canvas class="db-canvas" data-k="sig"></canvas></div>'
        : '';
      var vbatChart = vbat.length >= 2
        ? '<div class="db-chart"><div class="db-chart-t">🔋 电压（mV）</div><canvas class="db-canvas" data-k="vbat"></canvas></div>'
        : '';
      box.innerHTML =
        sigChart + vbatChart +
        '<div class="db-grid">' +
        dbItem('📶 信号', sig.length ? (sig[sig.length - 1].v + '（' + U.signalText(sig[sig.length - 1].v) + '）') : '--') +
        dbItem('🔋 电压', vbat.length ? (vbat[vbat.length - 1].v + ' mV · 耗电 ' + drain) : '--') +
        dbItem('⭐ 最强CN值', cn.length ? String(cn[cn.length - 1].v) : '--') +
        dbItem('🔄 重启次数', String(reboots)) +
        dbItem('📦 数据包', recs.length + ' 条') +
        dbItem('📈 采样率', Math.round(recs.length / Math.max(0.1, hours)) + ' 条/小时') +
        '</div>' +
        '<details class="db-recs"><summary>📤 上报数据（最新 200 条）</summary><div class="db-rec-list">' +
        recs.slice(-200).reverse().map(function (r) {
          return '<div class="db-rec" data-imei="' + U.esc(imei) + '">🕒 ' + U.esc(r.ct || '') + ' · ' + U.esc(r.device_type || '') + ' · ' + Object.keys(r).filter(function (k) { return k.indexOf('val_') === 0 || /^\d+$/.test(k); }).map(function (k) { return U.esc(k) + '=' + U.esc(String(r[k])); }).join(' · ') + '</div>';
        }).join('') +
        '</div></details>';
      // 画信号/电压曲线（布局完成后）
      var drawCharts = function () {
        U.$all('.db-canvas', box).forEach(function (cv) {
          var k = cv.getAttribute('data-k');
          var series = k === 'sig' ? thinSeries(sig) : thinSeries(vbat);
          drawLineChart(cv, series, { color: k === 'sig' ? TH.cssVar('--brand-600', '#4F46E5') : TH.cssVar('--ok', '#10B981') });
        });
      };
      if (typeof global.requestAnimationFrame === 'function') {
        global.requestAnimationFrame(drawCharts);
      } else {
        drawCharts();
      }
      // 点击数据包弹全字段
      U.$all('.db-rec', box).forEach(function (el2) {
        el2.addEventListener('click', function () {
          var ct = el2.getAttribute('data-ct');
          renderRecModal(imei, recs, el2.textContent);
        });
      });
    });
  }

  /* ---------------- 曲线图工具（纯 Canvas，无依赖） ---------------- */

  function tickLabel(ts) {
    var d = new Date(ts);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function thinSeries(arr, maxN) {
    maxN = maxN || 200;
    if (!arr || arr.length <= maxN) return arr || [];
    var out = [];
    var step = arr.length / maxN;
    for (var i = 0; i < maxN; i++) out.push(arr[Math.floor(i * step)]);
    out.push(arr[arr.length - 1]);
    return out;
  }

  function drawLineChart(canvas, data, opts) {
    opts = opts || {};
    var color = opts.color || TH.cssVar('--brand-600', '#4F46E5');
    if (!canvas || !data || data.length < 2) return;
    var dpr = global.devicePixelRatio || 1;
    var cssW = canvas.clientWidth || 600;
    var cssH = canvas.clientHeight || 160;
    canvas.width = cssW * dpr;
    canvas.height = cssH * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    var padL = 46, padR = 10, padT = 12, padB = 20;
    var plotW = cssW - padL - padR;
    var plotH = cssH - padT - padB;
    if (plotW <= 0 || plotH <= 0) return;

    var min = Infinity, max = -Infinity, i;
    for (i = 0; i < data.length; i++) {
      if (data[i].v < min) min = data[i].v;
      if (data[i].v > max) max = data[i].v;
    }
    if (min === max) { min -= 1; max += 1; }
    var pad = (max - min) * 0.12 || 1;
    min -= pad; max += pad;
    var t0 = data[0].ts, t1 = data[data.length - 1].ts;
    var span = Math.max(1, t1 - t0);
    function X(t) { return padL + (t - t0) / span * plotW; }
    function Y(v) { return padT + (1 - (v - min) / (max - min)) * plotH; }

    // 背景
    ctx.fillStyle = '#FAFBFE';
    ctx.fillRect(0, 0, cssW, cssH);

    // 横向网格 + y 轴刻度
    ctx.font = '10px sans-serif';
    ctx.lineWidth = 1;
    var steps = 3;
    for (i = 0; i <= steps; i++) {
      var v = max - (max - min) * i / steps;
      var y = Y(v);
      ctx.strokeStyle = '#E8ECF4';
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke();
      ctx.fillStyle = '#8B96AB';
      ctx.textAlign = 'left';
      ctx.fillText(String(Math.round(v)), 4, y + 3);
    }

    // x 轴刻度（首/中/尾，本地钟面直出）
    ctx.fillStyle = '#8B96AB';
    ctx.textAlign = 'left';
    ctx.fillText(tickLabel(t0), padL, cssH - 6);
    ctx.textAlign = 'center';
    ctx.fillText(tickLabel(t0 + span / 2), padL + plotW / 2, cssH - 6);
    ctx.textAlign = 'right';
    ctx.fillText(tickLabel(t1), cssW - padR, cssH - 6);

    // 面积渐变
    ctx.beginPath();
    ctx.moveTo(X(t0), Y(data[0].v));
    for (i = 0; i < data.length; i++) ctx.lineTo(X(data[i].ts), Y(data[i].v));
    ctx.lineTo(X(t1), padT + plotH);
    ctx.lineTo(X(t0), padT + plotH);
    ctx.closePath();
    var grad = ctx.createLinearGradient(0, padT, 0, padT + plotH);
    grad.addColorStop(0, color + '33');
    grad.addColorStop(1, color + '00');
    ctx.fillStyle = grad;
    ctx.fill();

    // 折线
    ctx.beginPath();
    for (i = 0; i < data.length; i++) {
      var px = X(data[i].ts), py = Y(data[i].v);
      if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.6;
    ctx.stroke();

    // 末点
    ctx.beginPath();
    ctx.arc(X(t1), Y(data[data.length - 1].v), 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
  }

  function dbItem(label, value) {
    return '<div class="db-item"><span>' + U.esc(label) + '</span><b>' + U.esc(String(value)) + '</b></div>';
  }

  function renderRecModal(imei, recs, textContent) {
    // 按 textContent 匹配记录展示全字段
    var rec = null;
    for (var i = 0; i < recs.length; i++) {
      if (textContent.indexOf(String(recs[i].ct || '\x00')) >= 0 && textContent.indexOf(String(recs[i].ct || '')) > 0) { rec = recs[i]; break; }
    }
    if (!rec) rec = recs[recs.length - 1];
    var html = '<table class="kv-table">' +
      Object.keys(rec).map(function (k) {
        return '<tr><td>' + U.esc(k) + '</td><td>' + U.esc(String(rec[k])) + '</td></tr>';
      }).join('') +
      '</table>';
    Views.modal('数据包详情 · ' + U.esc(imei), html);
  }

  /* ================= 合并进 Views ================= */

  Views.renderTrack = renderTrack;
  Views.renderFence = renderFence;
  Views.renderAlerts = renderAlerts;
  Views.renderStatus = renderStatus;
  Views.renderDebug = renderDebug;
})(window);