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
      startReplay(trData);
    });
    document.getElementById('tr-stop').addEventListener('click', function () {
      stopReplay(trData);
    });
  }

  function drawTrack(points) {
    if (!MapKit.mapAlive()) return;
    MapKit.clearTemp();
    var latlngs = [];
    points.forEach(function (p) {
      if (isFinite(p.lng) && isFinite(p.lat)) {
        var c = p.coord === CFG.COORD_WGS84 ? Algo.wgs84ToGcj02(p.lng, p.lat) : [p.lng, p.lat];
        latlngs.push([c[1], c[0]]);
      }
    });
    if (latlngs.length) {
      var line = L.polyline(latlngs, { color: '#2f7bff', weight: 4, opacity: 0.85 });
      MapKit.addTemp(line);
      var first = latlngs[0], last = latlngs[latlngs.length - 1];
      MapKit.addTemp(L.circleMarker(first, { radius: 8, color: '#1abc5a', fillColor: '#1abc5a', fillOpacity: 1 }).bindPopup('起点'));
      MapKit.addTemp(L.circleMarker(last, { radius: 8, color: '#e74c3c', fillColor: '#e74c3c', fillOpacity: 1 }).bindPopup('终点'));
      MapKit.getMap().fitBounds(latlngs, { padding: [40, 40] });
    }
  }

  function startReplay(trData) {
    stopReplay(trData);
    var myEpoch = MapKit.epoch();
    var pts = trData.points.filter(function (p) { return isFinite(p.lng) && isFinite(p.lat); });
    if (!pts.length) return;
    var idx = 0;
    var m = L.circleMarker([pts[0].lat, pts[0].lng], { radius: 7, color: '#ff9f43', fillColor: '#ff9f43', fillOpacity: 1 });
    MapKit.addTemp(m);
    trData.marker = m;
    // ×2400 等效：轨迹总时长压缩为 60 秒左右回放
    var totalMs = Math.max(2000, Math.min(60000, (pts[pts.length - 1].ts - pts[0].ts) || 60000));
    var stepMs = totalMs / pts.length;
    trData.playTimer = setInterval(function () {
      if (!MapKit.mapAlive() || MapKit.epoch() !== myEpoch) { stopReplay(trData); return; }
      if (idx >= pts.length) { stopReplay(trData); return; }
      var p = pts[idx];
      m.setLatLng([p.lat, p.lng]);
      idx++;
    }, Math.max(16, stepMs));
  }

  function stopReplay(trData) {
    if (trData.playTimer) { clearInterval(trData.playTimer); trData.playTimer = null; }
  }

  /* ================= #/fence 电子围栏 ================= */

  function renderFence() {
    Views.state.view = 'fence';
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
      if (st.preview) { MapKit.getMap().removeLayer(st.preview); st.preview = null; }
      if (st.previewCircle) { MapKit.getMap().removeLayer(st.previewCircle); st.previewCircle = null; }
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

    map.on('click', function (e) {
      if (!MapKit.mapAlive()) return;
      var lat = e.latlng.lat, lng = e.latlng.lng;
      if (st.mode === 'circle_center') {
        st.circleCenter = [lng, lat];
        st.mode = 'circle_radius';
        st.preview = L.circleMarker([lat, lng], { radius: 5, color: '#2f7bff', fillOpacity: 1 }).addTo(map);
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
          st.preview = L.polyline([], { color: '#9b59b6', weight: 3, dashArray: '6 4' }).addTo(map);
        }
        st.preview.setLatLngs(st.polyPoints.map(function (p) { return [p[1], p[0]]; }));
        tip('已加 ' + st.polyPoints.length + ' 个顶点，双击地图完成');
      }
    });

    map.on('mousemove', function (e) {
      if (st.mode === 'circle_radius' && st.circleCenter && MapKit.mapAlive()) {
        var R = 6371000;
        var dLat = (e.latlng.lat - st.circleCenter[1]) * Math.PI / 180;
        var dLng = (e.latlng.lng - st.circleCenter[0]) * Math.PI / 180;
        var la1 = st.circleCenter[1] * Math.PI / 180, la2 = e.latlng.lat * Math.PI / 180;
        var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
        var dist = R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
        if (!st.previewCircle) {
          st.previewCircle = L.circle([st.circleCenter[1], st.circleCenter[0]], { radius: dist, color: '#2f7bff', fillOpacity: 0.08, weight: 2 }).addTo(map);
        } else {
          st.previewCircle.setRadius(dist);
        }
      }
    });

    map.on('dblclick', function () {
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
      var layer = null;
      if (f.kind === 'circle') {
        layer = L.circle([f.center[1], f.center[0]], { radius: f.radius, color: '#e67e22', fillOpacity: 0.08, weight: 2 })
          .bindPopup(U.esc(f.name) + ' · 半径 ' + f.radius + 'm');
      } else if (f.kind === 'polygon') {
        layer = L.polygon(f.points.map(function (p) { return [p[1], p[0]]; }), { color: '#9b59b6', fillOpacity: 0.08, weight: 2 })
          .bindPopup(U.esc(f.name));
      }
      if (layer) MapKit.addFence(layer);
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
            if (c && MapKit.mapAlive()) MapKit.getMap().setView([c[1], c[0]], 15);
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
    box.innerHTML = list.map(function (a) {
      var f = FenceStore.get(a.fenceId);
      return '<div class="al-item">' +
        '<div class="al-main"><b>' + U.esc(f ? f.name : '围栏已删除') + '</b> · <span>' + U.esc(PetStore.nameOf(a.imei)) + '</span></div>' +
        '<div class="al-sub">' + U.esc(U.fmtFull(a.ts)) + ' · ' + (a.address ? U.esc(a.address) : Number(a.lng).toFixed(5) + ',' + Number(a.lat).toFixed(5)) + '</div>' +
        '</div>';
    }).join('');
  }

  /* ================= #/status 设备状态 ================= */

  function renderStatus(imei) {
    Views.state.view = 'status';
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
      box.innerHTML =
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
      // 点击数据包弹全字段
      U.$all('.db-rec', box).forEach(function (el2) {
        el2.addEventListener('click', function () {
          var ct = el2.getAttribute('data-ct');
          renderRecModal(imei, recs, el2.textContent);
        });
      });
    });
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