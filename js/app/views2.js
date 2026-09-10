/**
 * app/views2.js —— 轨迹回放 / 电子围栏 / 报警 / 设备状态 / 性能监控
 * 挂载：window.Views（合并进主 Views 对象）
 */
(function (global) {
  'use strict';
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
        U.toast('共 ' + trData.points.length + ' 个轨迹点');
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
    if (path.length) {
      MapKit.addTemp({ kind: 'polyline', points: path, color: '#2f7bff', weight: 4, opacity: 0.85 });
      MapKit.addTemp({ kind: 'dot', point: path[0], radius: 8, color: '#1abc5a' });
      MapKit.addTemp({ kind: 'dot', point: path[path.length - 1], radius: 8, color: '#e74c3c' });
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
    var m = MapKit.addTemp({ kind: 'dot', point: [pts[0].lng, pts[0].lat], radius: 7, color: '#ff9f43' });
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

  function renderFence() {
    Views.state.view = 'fence';
    Views.activeNav('fence');
    var root = document.getElementById('view-root');
    root.innerHTML =
      '<div class="home-wrap">' +
      '  <div id="fence-map" class="map-full"></div>' +
      '  <aside class="fence-panel">' +
      '    <div class="fp-cards">' +
      '      <button id="f-circle" class="fp-btn-card"><span class="fp-ic">⭕</span><b>圆形围栏</b><i>点选圆心，再点定半径</i></button>' +
      '      <button id="f-polygon" class="fp-btn-card"><span class="fp-ic">⬠</span><b>多边形围栏</b><i>依次加点，双击完成</i></button>' +
      '    </div>' +
      '  </aside>' +
      '  <div id="fence-list" class="fence-list"></div>' +
      '  <div id="fence-tip" class="fence-tip hidden"></div>' +
      '</div>';
    Views.clearTimers();

    var map = MapKit.create('fence-map', { center: [30.65, 104.06], zoom: 12 });
    renderFenceList();
    drawAllFences();

    var st = { mode: 'idle', circleCenter: null, polyPoints: [], preview: null, previewCircle: null };

    function tip(msg) {
      var el = document.getElementById('fence-tip');
      if (!el) return;
      el.textContent = msg;
      el.classList.remove('hidden');
    }
    function hideTip() {
      var el = document.getElementById('fence-tip');
      if (el) el.classList.add('hidden');
    }

    function resetMode() {
      st.mode = 'idle';
      st.circleCenter = null;
      st.polyPoints = [];
      if (st.preview) { st.preview.remove(); st.preview = null; }
      if (st.previewCircle) { st.previewCircle.remove(); st.previewCircle = null; }
      hideTip();
    }

    document.getElementById('f-circle').addEventListener('click', function () {
      resetMode();
      st.mode = 'circle_center';
      tip('⭕ 请在地图上点击圆心位置');
    });
    document.getElementById('f-polygon').addEventListener('click', function () {
      resetMode();
      st.mode = 'polygon';
      tip('⬠ 依次点击加顶点，双击完成绘制');
    });

    MapKit.on('click', function (e) {
      if (!MapKit.mapAlive()) return;
      var lat = e.lat, lng = e.lng;
      if (st.mode === 'circle_center') {
        st.circleCenter = [lng, lat];
        st.mode = 'circle_radius';
        st.preview = MapKit.addTemp({ kind: 'dot', point: [lng, lat], radius: 5, color: '#2f7bff' });
        tip('再点一处确定半径（≥20 米）');
      } else if (st.mode === 'circle_radius') {
        var R = 6371000;
        var dLat = (lat - st.circleCenter[1]) * Math.PI / 180;
        var dLng = (lng - st.circleCenter[0]) * Math.PI / 180;
        var la1 = st.circleCenter[1] * Math.PI / 180, la2 = lat * Math.PI / 180;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        var dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        if (dist < 20) { U.toast('半径需 ≥ 20 米', 'err'); return; }
        var name = promptWithDefault('围栏名称：', '我的围栏');
        if (name === null) { resetMode(); return; }
        FenceStore.add({ kind: 'circle', name: name || '我的围栏', center: st.circleCenter, radius: Math.round(dist) });
        U.toast('✅ 围栏已保存');
        resetMode();
        renderFenceList();
        drawAllFences();
      } else if (st.mode === 'polygon') {
        st.polyPoints.push([lng, lat]);
        if (!st.preview) {
          st.preview = MapKit.addTemp({ kind: 'polyline', points: [], color: '#9b59b6', weight: 3, dash: '6 4' });
        }
        st.preview.setPath(st.polyPoints);
        tip('已加 ' + st.polyPoints.length + ' 个顶点，双击地图完成');
      }
    });

    MapKit.on('mousemove', function (e) {
      if (st.mode === 'circle_radius' && st.circleCenter && MapKit.mapAlive()) {
        var R = 6371000;
        var dLat = (e.lat - st.circleCenter[1]) * Math.PI / 180;
        var dLng = (e.lng - st.circleCenter[0]) * Math.PI / 180;
        var la1 = st.circleCenter[1] * Math.PI / 180, la2 = e.lat * Math.PI / 180;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        var dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        if (!st.previewCircle) {
          st.previewCircle = MapKit.addTemp({ kind: 'circle', center: st.circleCenter, radius: dist, color: '#2f7bff', fillOpacity: 0.08 });
        } else {
          st.previewCircle.setRadius(dist);
        }
      }
    });

    MapKit.on('dblclick', function () {
      if (st.mode === 'polygon' && st.polyPoints.length >= 3) {
        var name = promptWithDefault('围栏名称：', '我的多边形围栏');
        if (name === null) { resetMode(); return; }
        FenceStore.add({ kind: 'polygon', name: name || '多边形围栏', points: st.polyPoints.slice() });
        U.toast('✅ 多边形围栏已保存');
        resetMode();
        renderFenceList();
        drawAllFences();
      }
    });
  }

  function promptWithDefault(msg, def) {
    try { return global.prompt(msg, def); } catch (e) { return null; }
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
      return '<div class="fl-item" data-id="' + U.esc(f.id) + '">' +
        '<div class="fl-main"><b>' + U.esc(f.name) + '</b><span class="fl-sub">' +
        (f.kind === 'circle' ? '⭕ 圆形 · ' + f.radius + 'm' : '⬠ 多边形 · ' + (f.points || []).length + ' 点') +
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
            if (global.confirm('删除围栏「' + (f && f.name) + '」？')) {
              FenceStore.remove(id);
              renderFenceList();
              drawAllFences();
            }
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
    root.innerHTML = '<div class="page"><h2>🚨 越界报警</h2><div id="al-list"></div></div>';
    Views.clearTimers();
    renderAlertsList();
    Views.state.timers.push(setInterval(renderAlertsList, 15000));
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
          drawLineChart(cv, series, { color: k === 'sig' ? '#2f7bff' : '#27ae60' });
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
    var color = opts.color || '#2f7bff';
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
    ctx.fillStyle = '#fbfcfe';
    ctx.fillRect(0, 0, cssW, cssH);

    // 横向网格 + y 轴刻度
    ctx.font = '10px sans-serif';
    ctx.lineWidth = 1;
    var steps = 3;
    for (i = 0; i <= steps; i++) {
      var v = max - (max - min) * i / steps;
      var y = Y(v);
      ctx.strokeStyle = '#eef2f7';
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(cssW - padR, y); ctx.stroke();
      ctx.fillStyle = '#9aa3b2';
      ctx.textAlign = 'left';
      ctx.fillText(String(Math.round(v)), 4, y + 3);
    }

    // x 轴刻度（首/中/尾，本地钟面直出）
    ctx.fillStyle = '#9aa3b2';
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