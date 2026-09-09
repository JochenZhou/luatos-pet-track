/**
 * app/views3.js —— #/report 日报卡片
 * 挂载：window.Views（合并进主 Views 对象）
 * 数据：全部来自真实平台接口（当日报表）：
 *   - 移动距离/活跃时段：getTrack（轨迹点累计）
 *   - 步数/步频：1293 gsensor（PetStatus.analyze）
 *   - 电量消耗：799 电压序列（首尾差 + mV/h）
 *   - 在线状态：782 信号记录覆盖时段
 * 卡片导出：Canvas 绘制 + toDataURL 长按保存（Webview 兼容下载链接）
 */
(function (global) {
  'use strict';
  var U = global.Utils;
  var CFG = global.CFG;
  var AC = global.AC;
  var Algo = global.Algo;
  var MapKit = global.MapKit;
  var PetStore = global.PetStore;
  var PetStatus = global.PetStatus;
  var Views = global.Views;

  /* ================= 工具：Haversine 距离 ================= */

  function haversineM(lng1, lat1, lng2, lat2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * 轨迹统计：总距离 + 最远点 + 活跃时段直方图（24h）
   */
  function trackStats(points) {
    var total = 0;
    var maxSeg = 0;
    var first = null, last = null;
    var hours = [];
    for (var h = 0; h < 24; h++) hours.push(0);
    var prev = null;
    points.forEach(function (p) {
      if (!isFinite(p.lng) || !isFinite(p.lat)) return;
      var c = p.coord === CFG.COORD_WGS84 ? Algo.wgs84ToGcj02(p.lng, p.lat) : [p.lng, p.lat];
      if (!first) first = { lng: c[0], lat: c[1], ts: p.ts };
      last = { lng: c[0], lat: c[1], ts: p.ts };
      if (prev) {
        var d = haversineM(prev.lng, prev.lat, c[0], c[1]);
        // 过滤 GPS 漂移（单段 > 500m 且速度 > 120km/h 视为跳点）
        var dt = (p.ts - prev.ts) / 1000;
        var spd = dt > 0 ? d / dt : 0;
        if (d < 500 || spd < 33.3) {
          total += d;
          if (d > maxSeg) maxSeg = d;
        }
      }
      var hr = new Date(p.ts).getHours();
      hours[hr] += 1;
      prev = { lng: c[0], lat: c[1], ts: p.ts };
    });
    return { total: total, maxSeg: maxSeg, first: first, last: last, hours: hours };
  }

  /**
   * 电量统计：首尾电压差 + 每小时耗电 + 是否充电（电压回升）
   */
  function batteryStats(recs) {
    var v = [];
    recs.forEach(function (r) {
      var vb = AC.recVal(r, 799);
      if (vb !== undefined && vb !== null && vb !== '') {
        var n = Number(vb);
        if (isFinite(n) && n > 0) v.push({ ts: U.recTs(r), mv: n });
      }
    });
    if (v.length < 2) return null;
    v.sort(function (a, b) { return a.ts - b.ts; });
    var first = v[0], last = v[v.length - 1];
    var spanH = (last.ts - first.ts) / 3600000;
    var delta = first.mv - last.mv; // 正 = 放电
    var charging = delta < -20;     // 电压明显回升 = 充电中
    var perHour = spanH > 0.2 ? Math.round(delta / spanH) : null;
    var pctFirst = U.vbatToPercent(first.mv);
    var pctLast = U.vbatToPercent(last.mv);
    return {
      count: v.length, firstMv: first.mv, lastMv: last.mv,
      pctFirst: pctFirst, pctLast: pctLast,
      delta: delta, perHour: perHour, spanH: spanH, charging: charging
    };
  }

  /**
   * 在线统计：782 信号记录覆盖的小时数（有记录≈在线上报）
   */
  function onlineStats(recs, dayStart, dayEnd) {
    var byHour = {};
    var count = 0;
    recs.forEach(function (r) {
      var sig = AC.recVal(r, 782);
      if (sig === undefined) return;
      var ts = U.recTs(r);
      if (ts < dayStart || ts > dayEnd) return;
      count++;
      var h = new Date(ts).getHours();
      byHour[h] = (byHour[h] || 0) + 1;
    });
    var covered = Object.keys(byHour).length;
    return { reports: count, hoursCovered: covered, byHour: byHour };
  }

  /* ================= #/report 路由 ================= */

  function renderReport(imeiArg) {
    Views.state.view = 'report';
    var root = document.getElementById('view-root');
    var devices = Views.state.devices || [];
    root.innerHTML =
      '<div class="page">' +
      '  <h2>📋 日报</h2>' +
      '  <div class="track-bar">' +
      '    <select id="rp-imei" class="sel">' +
      (devices.length ? devices.map(function (d) {
        return '<option value="' + U.esc(d.deviceid) + '"' + (d.deviceid === imeiArg ? ' selected' : '') + '>' + U.esc(PetStore.nameOf(d.deviceid)) + '</option>';
      }).join('') : '') +
      '    </select>' +
      '    <input type="date" id="rp-date">' +
      '    <button id="rp-go" class="btn">生成日报</button>' +
      '  </div>' +
      '  <div id="rp-body"></div>' +
      '</div>';
    Views.clearTimers();
    document.getElementById('rp-date').value = U.todayLocal();

    if (!devices.length) {
      Views.ensureProject().then(function (key) {
        if (!key) return;
        return Views.loadDevices().then(function (devs) {
          var sel = document.getElementById('rp-imei');
          if (!sel || !sel.isConnected) return;
          sel.innerHTML = devs.map(function (d) {
            return '<option value="' + U.esc(d.deviceid) + '">' + U.esc(PetStore.nameOf(d.deviceid)) + '</option>';
          }).join('');
        });
      })['catch'](function () { /* ignore */ });
    }

    document.getElementById('rp-go').addEventListener('click', function () {
      var imei = document.getElementById('rp-imei').value;
      var date = document.getElementById('rp-date').value;
      if (!imei || !date) { U.toast('请选择设备与日期', 'err'); return; }
      generateReport(imei, date);
    });
  }

  function generateReport(imei, date) {
    var box = document.getElementById('rp-body');
    if (!box) return;
    box.innerHTML = '<div class="empty">📊 正在统计当日数据…（轨迹+传感+电量）</div>';

    var dayStart = date + ' 00:00:00';
    var dayEnd = date + ' 23:59:59';
    var filter = { aks: ['ct', 'ct'], acs: ['ge', 'le'], avs: [dayStart, dayEnd] };

    // 三路数据并行：轨迹 / 传感+电量 / 最新位置
    Promise.all([
      AC.getTrack(imei, dayStart, dayEnd, {}),
      AC.fetchAllByTags(imei, [799, 782, 1293, 517, 256, 519], filter, {}),
      AC.latestLocation(imei)
    ]).then(function (results) {
      if (!box.isConnected) return; // 页面已切换
      var trackPts = results[0] || [];
      var recs = results[1] || [];
      var latest = (results[2].code === 0 && results[2].value) ? results[2].value : null;

      var ts1 = trackStats(trackPts);
      var bat = batteryStats(recs);
      var online = onlineStats(recs, U.parseLocalTime(dayStart).getTime(), U.parseLocalTime(dayEnd).getTime());

      // 步数：当日 1293 解包（可能数据量大，限制最近 60 条记录）
      var steps = null;
      var gsRecs = recs.filter(function (r) { return AC.recVal(r, 1293) !== undefined; });
      if (gsRecs.length) {
        var analysis = PetStatus.analyze(gsRecs.slice(0, 60), {});
        steps = analysis.steps;
      }

      // 温度
      var temp = null;
      for (var i = recs.length - 1; i >= 0; i--) {
        var t = AC.recVal(recs[i], 256);
        if (t !== undefined && t !== null && t !== '') { temp = Number(t); break; }
      }

      var model = {
        imei: imei,
        name: PetStore.nameOf(imei),
        date: date,
        distance: ts1.total,
        trackCount: trackPts.length,
        first: ts1.first, last: ts1.last,
        hours: ts1.hours,
        steps: steps,
        temp: temp,
        bat: bat,
        online: online,
        latest: latest
      };
      currentModel = model;
      renderCard(model);
    })['catch'](function () {
      if (box && box.isConnected) box.innerHTML = '<div class="empty">统计失败，请重试</div>';
    });
  }

  var currentModel = null;

  function fmtDist(m) {
    if (m === null || m === undefined || !isFinite(m)) return '--';
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toFixed(2) + ' km';
  }

  function renderCard(model) {
    var box = document.getElementById('rp-body');
    if (!box) return;
    var batLine = '--';
    if (model.bat) {
      batLine = model.bat.pctFirst !== null && model.bat.pctLast !== null
        ? (model.bat.pctFirst + '% → ' + model.bat.pctLast + '%')
        : (model.bat.firstMv + '→' + model.bat.lastMv + ' mV');
    }
    var onlinePct = model.online.reports > 0
      ? Math.min(100, Math.round(model.online.hoursCovered / 24 * 100))
      : 0;

    box.innerHTML =
      '<div id="rp-card" class="report-card">' +
      '  <div class="rc-head">' +
      '    <div class="rc-brand">📋 日报 · 合宙IoT-运动传感器</div>' +
      '    <div class="rc-date">' + U.esc(model.date) + '</div>' +
      '  </div>' +
      '  <div class="rc-device">' + U.esc(model.name) + '<span class="rc-imei">' + U.esc(model.imei) + '</span></div>' +
      '  <div class="rc-hero">' +
      '    <div class="rc-big">' + fmtDist(model.distance) + '</div>' +
      '    <div class="rc-big-label">今日移动距离</div>' +
      '  </div>' +
      '  <div class="rc-grid">' +
      '    <div class="rc-item"><span>🚶 步数</span><b>' + (model.steps !== null ? model.steps : '--') + '</b></div>' +
      '    <div class="rc-item"><span>📍 轨迹点</span><b>' + model.trackCount + '</b></div>' +
      '    <div class="rc-item"><span>🔋 电量</span><b>' + U.esc(batLine) + '</b></div>' +
      '    <div class="rc-item"><span>⚡ 耗速</span><b>' + (model.bat && model.bat.perHour !== null ? model.bat.perHour + ' mV/h' : '--') + '</b></div>' +
      '    <div class="rc-item"><span>📶 在线覆盖</span><b>' + onlinePct + '%</b></div>' +
      '    <div class="rc-item"><span>🌡 温度</span><b>' + (model.temp !== null ? model.temp + ' ℃' : '--') + '</b></div>' +
      '  </div>' +
      '  <canvas id="rp-hours" width="640" height="120"></canvas>' +
      '  <div class="rc-foot">📍 位置：' + (model.latest && model.latest.address ? U.esc(model.latest.address) : '--') + '</div>' +
      '</div>' +
      '<div class="rp-actions">' +
      '  <button id="rp-save" class="btn">💾 保存图片</button>' +
      '  <button id="rp-share" class="btn ghost">🔗 复制文字版</button>' +
      '</div>';

    drawHours(model.hours);
    bindCardActions(model);
  }

  /**
   * 活跃时段直方图（Canvas，24h）
   */
  function drawHours(hours) {
    var cv = document.getElementById('rp-hours');
    if (!cv) return;
    var ctx = cv.getContext('2d');
    var W = cv.width, H = cv.height;
    var pad = 30;
    var max = Math.max.apply(null, hours) || 1;
    ctx.clearRect(0, 0, W, H);
    // 底色
    ctx.fillStyle = '#f4f6fb';
    ctx.fillRect(0, 0, W, H);
    // 柱
    var bw = (W - pad * 2) / 24;
    for (var h = 0; h < 24; h++) {
      var bh = hours[h] / max * (H - 42);
      if (hours[h] > 0) {
        ctx.fillStyle = '#2f7bff';
        ctx.globalAlpha = 0.35 + 0.65 * (hours[h] / max);
        ctx.fillRect(pad + h * bw + 2, H - 26 - bh, bw - 4, bh);
        ctx.globalAlpha = 1;
      }
      // 刻度（每 6 小时）
      if (h % 6 === 0) {
        ctx.fillStyle = '#8a94a6';
        ctx.font = '16px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(h + '时', pad + h * bw + bw / 2, H - 8);
      }
    }
    // 标题
    ctx.fillStyle = '#1f2937';
    ctx.font = 'bold 18px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('活跃时段（上报点分布）', pad, 22);
  }

  function bindCardActions(model) {
    var save = document.getElementById('rp-save');
    if (save) {
      save.addEventListener('click', function () {
        // 卡片 → 高分辨率离屏 canvas（含标题/品牌，可直接保存分享）
        var card = document.getElementById('rp-card');
        var hoursCv = document.getElementById('rp-hours');
        if (!card || !hoursCv) return;
        var W = 640;
        var scale = 2;
        var off = document.createElement('canvas');
        off.width = W * scale;
        var ctx = off.getContext('2d');
        // 预排版高度
        var topH = 150, devH = 60, heroH = 150, gridH = 170, hoursH = 140, footH = 60, pad = 24;
        var totalH = topH + devH + heroH + gridH + hoursH + footH + pad * 2;
        off.height = totalH * scale;
        ctx.scale(scale, scale);
        // 背景
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, totalH);
        // 头部渐变条
        var grad = ctx.createLinearGradient(0, 0, W, topH);
        grad.addColorStop(0, '#2f7bff');
        grad.addColorStop(1, '#5c9dff');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, W, topH);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 24px sans-serif';
        ctx.fillText('📋 日报 · 合宙IoT-运动传感器', pad, 44);
        ctx.font = '20px sans-serif';
        ctx.fillText(model.date, pad, 76);
        ctx.font = 'bold 30px sans-serif';
        ctx.fillText(model.name, pad, 118);
        ctx.font = '16px sans-serif';
        ctx.globalAlpha = 0.85;
        ctx.fillText(model.imei, pad, 140);
        ctx.globalAlpha = 1;
        var y = topH + pad;
        // 设备行
        ctx.fillStyle = '#1f2937';
        ctx.font = '18px sans-serif';
        y = topH + 8; // 设备名已在头部
        // Hero 距离
        y = topH + 20;
        ctx.fillStyle = '#2f7bff';
        ctx.font = 'bold 64px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(fmtDist(model.distance), W / 2, y + 80);
        ctx.fillStyle = '#8a94a6';
        ctx.font = '20px sans-serif';
        ctx.fillText('今日移动距离', W / 2, y + 112);
        ctx.textAlign = 'left';
        // 六宫格
        y = topH + heroH;
        var items = [
          ['🚶 步数', model.steps !== null ? String(model.steps) : '--'],
          ['📍 轨迹点', String(model.trackCount)],
          ['🔋 电量', model.bat ? (model.bat.pctFirst !== null && model.bat.pctLast !== null ? model.bat.pctFirst + '%→' + model.bat.pctLast + '%' : '--') : '--'],
          ['⚡ 耗速', model.bat && model.bat.perHour !== null ? model.bat.perHour + ' mV/h' : '--'],
          ['📶 在线', model.online.reports > 0 ? Math.min(100, Math.round(model.online.hoursCovered / 24 * 100)) + '%' : '0%'],
          ['🌡 温度', model.temp !== null ? model.temp + '℃' : '--']
        ];
        var gw = (W - pad * 2) / 3, gh = (gridH - 20) / 2;
        items.forEach(function (it, idx) {
          var gx = pad + (idx % 3) * gw;
          var gy = y + Math.floor(idx / 3) * gh;
          ctx.fillStyle = '#f4f6fb';
          ctx.fillRect(gx + 4, gy + 4, gw - 8, gh - 8);
          ctx.fillStyle = '#8a94a6';
          ctx.font = '15px sans-serif';
          ctx.fillText(it[0], gx + 16, gy + 30);
          ctx.fillStyle = '#1f2937';
          ctx.font = 'bold 21px sans-serif';
          ctx.fillText(it[1], gx + 16, gy + 58);
        });
        // 活跃时段（把已画的 canvas 拷贝进来）
        y = topH + heroH + gridH;
        ctx.drawImage(hoursCv, 0, y, W, hoursH - 10);
        // 页脚
        y = topH + heroH + gridH + hoursH;
        ctx.fillStyle = '#8a94a6';
        ctx.font = '15px sans-serif';
        var addr = model.latest && model.latest.address ? model.latest.address : '--';
        if (addr.length > 34) addr = addr.slice(0, 33) + '…';
        ctx.fillText('📍 ' + addr, pad, y + 24);
        ctx.textAlign = 'right';
        ctx.fillText('AirCloud · 真实数据', W - pad, y + 24);
        ctx.textAlign = 'left';

        // 导出：优先下载；Webview 不支持时提示长按
        try {
          var url = off.toDataURL('image/png');
          var isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
          if (!isMobile && navigator.download !== undefined) { /* noop */ }
          var a = document.createElement('a');
          a.href = url;
          a.download = '日报_' + model.name + '_' + model.date + '.png';
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);
          U.toast('📱 已生成图片' + (isMobile ? '，若未弹出保存可长按页面图片' : ''));
          // 同时把图放进卡片下方方便长按
          var img = document.createElement('img');
          img.src = url;
          img.className = 'rp-export-img';
          img.alt = '日报图片（长按保存）';
          var old = document.querySelector('.rp-export-img');
          if (old) old.remove();
          document.getElementById('rp-body').appendChild(img);
        } catch (e) {
          U.toast('生成失败：' + e.message, 'err');
        }
      });
    }
    var share = document.getElementById('rp-share');
    if (share) {
      share.addEventListener('click', function () {
        var m = model;
        var lines = [
          '📋 ' + m.date + ' 日报 · ' + m.name,
          '🚶 步数：' + (m.steps !== null ? m.steps : '--'),
          '🏃 移动：' + fmtDist(m.distance) + '（' + m.trackCount + ' 个轨迹点）',
          '🔋 电量：' + (m.bat ? (m.bat.pctFirst !== null && m.bat.pctLast !== null ? m.bat.pctFirst + '% → ' + m.bat.pctLast + '%' : m.bat.firstMv + '→' + m.bat.lastMv + 'mV') : '--'),
          '📶 在线覆盖：' + (m.online.reports > 0 ? Math.min(100, Math.round(m.online.hoursCovered / 24 * 100)) + '%' : '0%')
        ];
        var text = lines.join('\n');
        function done(ok) { U.toast(ok ? '✅ 已复制，去粘贴分享吧' : '复制失败', ok ? '' : 'err'); }
        function copyNow() {
          if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () { done(true); }, function () { fallbackCopyText(text, done); });
          } else {
            fallbackCopyText(text, done);
          }
        }
        copyNow();
      });
    }
  }

  function fallbackCopyText(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(!!ok);
    } catch (e) { done(false); }
  }

  /* ================= 合并进 Views ================= */

  Views.renderReport = renderReport;
})(window);