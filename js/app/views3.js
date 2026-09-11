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
  // 主题取色：地图/Canvas 画在 DOM 之外，拿不到 var()，必须显式取色。
  // 取不到 Theme 时退回原硬编码值，保证 theme.js 未加载也不影响绘制。
  var TH = global.Theme || { cssVar: function (n, f) { return f; } };
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
    var durationMs = (first && last && last.ts > first.ts) ? (last.ts - first.ts) : 0;
    var avgKmh = (durationMs > 60000 && total > 0) ? Math.round(total * 3600 / durationMs * 100) / 100 : null;
    return { total: total, maxSeg: maxSeg, first: first, last: last, hours: hours, durationMs: durationMs, avgKmh: avgKmh };
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
    Views.activeNav('report');
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
    box.innerHTML =
      '<div id="rp-progress" class="tr-progress">' +
      '  <div class="tr-bar"><div class="tr-fill"></div></div>' +
      '  <span class="tr-text"></span>' +
      '</div>';
    // 日报要拉当天轨迹 + 传感 + 电量 + 近 7 天打卡，本身就是几秒级的多页查询，
    // 没有进度显示时用户只会以为网页卡死了。
    var pc = Views.progressCtl('rp-progress');
    pc.set(0, '正在统计当日数据…');

    var dayStart = date + ' 00:00:00';
    var dayEnd = date + ' 23:59:59';
    var filter = { aks: ['ct', 'ct'], acs: ['ge', 'le'], avs: [dayStart, dayEnd] };
    // 近 7 天起点（用于连续打卡统计，真实上报判定）
    var base = U.parseLocalTime(date + ' 00:00:00');
    var streakStart = base ? (dateStr(new Date(base.getTime() - 6 * 86400000)) + ' 00:00:00') : dayStart;
    var weekFilter = { aks: ['ct', 'ct'], acs: ['ge', 'le'], avs: [streakStart, dayEnd] };

    // 四路并行，各自按权重贡献总进度（轨迹 45 / 传感 30 / 打卡 20 / 最新 5）
    var W = { track: 45, sensor: 30, week: 20, latest: 5 };
    var R = { track: 0, sensor: 0, week: 0, latest: 0 };
    var phaseLabel = '正在统计当日数据…';
    function tick(label) {
      if (label) phaseLabel = label;
      pc.set(W.track * R.track + W.sensor * R.sensor + W.week * R.week + W.latest * R.latest, phaseLabel);
    }
    function ratio(n, total) { return total > 0 ? Math.min(1, n / total) : 0; }

    Promise.all([
      // 1) 当日轨迹（含 location_history 翻页 + 1294 展开 + 异常点剔除）
      AC.getTrack(imei, dayStart, dayEnd, {
        onProgress: function (n, total, info) {
          R.track = (info && typeof info.pct === 'number') ? info.pct / 100 : ratio(n, total);
          tick('正在获取当日轨迹…');
        }
      }).then(function (pts) { R.track = 1; tick(); return pts; }),

      // 2) 传感 / 电量 / 信号 / 温度
      AC.fetchAllByTags(imei, [799, 782, 1293, 517, 256, 519], filter, {
        onProgress: function (n, total) { R.sensor = ratio(n, total); tick('正在统计传感与电量…'); }
      }).then(function (rs) { R.sensor = 1; tick(); return rs; }),

      // 3) 最新位置
      AC.latestLocation(imei).then(function (r) { R.latest = 1; tick(); return r; }),

      // 4) 连续打卡：只需要「哪几天有定位上报」，用轻量的 513 定位记录即可。
      //    原来这里又跑了一次完整 getTrack（含 location_history 全量翻页 + 1294 展开），
      //    而 7 天的数据量是当天的数倍 —— 那正是「生成日报很慢、网络里一堆
      //    location_history 请求」的主因。现在这一步不再碰 location_history。
      AC.fetchAllByTags(imei, [513], weekFilter, {
        onProgress: function (n, total) { R.week = ratio(n, total); tick('正在统计连续打卡…'); }
      }).then(function (rs) { R.week = 1; tick(); return rs; })
    ]).then(function (results) {
      if (!box.isConnected) { pc.stop(); return; } // 页面已切换
      pc.stop();
      var trackPts = results[0] || [];
      var recs = results[1] || [];
      var latest = (results[2].code === 0 && results[2].value) ? results[2].value : null;
      var weekPts = (results[3] || []).map(function (r) { return { ts: U.recTs(r) }; });

      var ts1 = trackStats(trackPts);
      var bat = batteryStats(recs);
      var online = onlineStats(recs, U.parseLocalTime(dayStart).getTime(), U.parseLocalTime(dayEnd).getTime());

      // 步数：当日 1293 解包（可能数据量大，限制最近 60 条记录）
      var steps = null, cadence = null;
      var gsRecs = recs.filter(function (r) { return AC.recVal(r, 1293) !== undefined; });
      if (gsRecs.length) {
        var analysis = PetStatus.analyze(gsRecs.slice(0, 60), {});
        steps = analysis.steps;
        cadence = analysis.cadence || null;
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
        dropped: trackPts.removedOutliers || 0,   // 被当作跳点剔除的异常点数
        first: ts1.first, last: ts1.last,
        durationMs: ts1.durationMs,
        avgKmh: ts1.avgKmh,
        hours: ts1.hours,
        steps: steps,
        cadence: cadence,
        temp: temp,
        bat: bat,
        online: online,
        latest: latest
      };
      // 情绪价值字段：基于真实数据计算
      var peak = peakStats(ts1.hours);
      model.peakLabel = peak.label;
      model.streak = calcStreak(weekPts, date);
      model.badges = calcBadges(model);
      model.summary = moodSummary(model);
      model.funLines = buildFunLines(model);
      currentModel = model;
      renderCard(model);
    })['catch'](function () {
      if (pc) pc.stop();
      if (box && box.isConnected) box.innerHTML = '<div class="empty">统计失败，请重试</div>';
    });
  }

  var currentModel = null;

  function fmtDist(m) {
    if (m === null || m === undefined || !isFinite(m)) return '--';
    if (m < 1000) return Math.round(m) + ' m';
    return (m / 1000).toFixed(2) + ' km';
  }

  function fmtDuration(ms) {
    if (!ms || ms <= 0) return '--';
    var m = Math.round(ms / 60000);
    if (m < 60) return m + ' 分钟';
    var h = Math.floor(m / 60), mm = m % 60;
    return h + ' 小时' + (mm ? ' ' + mm + ' 分' : '');
  }

  function fmtSpeed(kmh) {
    if (kmh === null || kmh === undefined || !isFinite(kmh)) return '--';
    return kmh + ' km/h';
  }

  // ============ 情绪价值：拟人总结 / 趣味换算 / 连续打卡 / 徽章 ============

  function dateStr(d) {
    return d.getFullYear() + '-' + U.two(d.getMonth() + 1) + '-' + U.two(d.getDate());
  }

  function periodLabel(h) {
    if (h >= 5 && h < 8) return '清晨';
    if (h >= 8 && h < 11) return '上午';
    if (h >= 11 && h < 13) return '中午';
    if (h >= 13 && h < 17) return '下午';
    if (h >= 17 && h < 20) return '傍晚';
    if (h >= 20 && h < 23) return '晚上';
    return '深夜';
  }

  function peakStats(hours) {
    var max = 0, idx = -1;
    for (var i = 0; i < 24; i++) { if (hours[i] > max) { max = hours[i]; idx = i; } }
    if (idx < 0) return { hour: null, label: null };
    return { hour: idx, label: periodLabel(idx) };
  }

  /** 口吻化总结：基于真实数据，只拟人语气，不造数 */
  function moodSummary(model) {
    var s;
    if (model.distance !== null && model.distance > 0) {
      s = model.distance >= 1000 ? '今天撒欢走了 ' + (model.distance / 1000).toFixed(2) + ' 公里' : '今天活动了 ' + Math.round(model.distance) + ' 米';
    } else {
      s = '今天比较宅，几乎没出门';
    }
    if (model.steps !== null && model.steps > 0) s += '，走了 ' + model.steps + ' 步';
    if (model.peakLabel) s += '，' + model.peakLabel + '最活跃';
    return s + ' 🐾';
  }

  function funDistance(m) {
    if (!m || m <= 0) return '';
    var laps = m / 400;
    return '≈ 绕标准操场 ' + (laps < 1 ? laps.toFixed(2) : laps.toFixed(1)) + ' 圈';
  }

  function funSteps(steps) {
    if (!steps || steps <= 0) return '';
    return '≈ 追 ' + Math.max(1, Math.round(steps / 50)) + ' 次飞盘的能量';
  }

  function funBattery(bat) {
    if (!bat || bat.perHour === null || bat.perHour === undefined || bat.perHour <= 0) return '';
    var remain = (bat.lastMv || 0) - 3400;
    if (remain <= 0) return '电量紧张，快给它充电啦 ⚡';
    var h = remain / bat.perHour;
    return '≈ 还能陪你浪 ' + (Math.round(h * 10) / 10) + ' 小时';
  }

  function buildFunLines(model) {
    var lines = [];
    var d = funDistance(model.distance), s = funSteps(model.steps), b = funBattery(model.bat);
    if (d) lines.push(d);
    if (s) lines.push(s);
    if (b) lines.push(b);
    return lines;
  }

  function calcBadges(model) {
    var badges = [];
    if (model.steps !== null && model.steps !== undefined) {
      if (model.steps >= 5000) badges.push('👑 步数大神');
      else if (model.steps >= 1000) badges.push('🏆 千步勇士');
      else if (model.steps >= 100) badges.push('🐾 起步小将');
    }
    if (model.distance !== null && model.distance >= 500) {
      badges.push(model.distance >= 2000 ? '🏃 远足达人' : '🚶 遛弯达标');
    }
    if (model.online && model.online.hoursCovered >= 8) badges.push('📡 全天候在线');
    if (model.bat && model.bat.charging) badges.push('🔋 正在充电');
    return badges;
  }

  /** 连续打卡：近 N 天每天是否有轨迹点（真实上报），从所选日期往前数连续天数 */
  function calcStreak(points, date) {
    var daySet = {};
    (points || []).forEach(function (p) {
      if (!p.ts) return;
      daySet[dateStr(new Date(p.ts))] = true;
    });
    var base = U.parseLocalTime(date + ' 00:00:00');
    if (!base) return 0;
    var cur = new Date(base.getTime());
    var streak = 0;
    for (var i = 0; i < 14; i++) {
      if (daySet[dateStr(cur)]) { streak++; cur.setDate(cur.getDate() - 1); }
      else break;
    }
    return streak;
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
      '    <div class="rc-summary">' + U.esc(model.summary) + '</div>' +
      (model.funLines && model.funLines.length ?
        '    <div class="rc-fun">' + model.funLines.map(function (l) { return '<span>' + U.esc(l) + '</span>'; }).join('') + '</div>' : '') +
      '  </div>' +
      '  <div class="rc-grid">' +
      '    <div class="rc-item"><span>🚶 步数</span><b>' + (model.steps !== null ? model.steps : '--') + '</b></div>' +
      '    <div class="rc-item"><span>⚡ 步频</span><b>' + (model.cadence != null ? (Math.round(model.cadence) + ' 步/分') : '--') + '</b></div>' +
      '    <div class="rc-item"><span>🏃 均速</span><b>' + fmtSpeed(model.avgKmh) + '</b></div>' +
      '    <div class="rc-item" title="' + (model.dropped ? '已剔除 ' + model.dropped + ' 个异常跳点（瞬时位移过大）' : '原始轨迹点') + '"><span>📍 轨迹点</span><b>' + model.trackCount + (model.dropped ? ' <small>剔' + model.dropped + '</small>' : '') + '</b></div>' +
      '    <div class="rc-item"><span>🔋 电量</span><b>' + U.esc(batLine) + '</b></div>' +
      '    <div class="rc-item"><span>⚡ 耗速</span><b>' + (model.bat && model.bat.perHour !== null ? model.bat.perHour + ' mV/h' : '--') + '</b></div>' +
      '    <div class="rc-item"><span>📶 在线覆盖</span><b>' + onlinePct + '%</b></div>' +
      '    <div class="rc-item"><span>🌡 温度</span><b>' + (model.temp !== null ? model.temp + ' ℃' : '--') + '</b></div>' +
      '  </div>' +
      '  <div class="rc-meta">' +
      '    <span>⏱ 活跃时长 ' + fmtDuration(model.durationMs) + '</span>' +
      '    <span>📡 上报 ' + model.online.reports + ' 次</span>' +
      (model.bat && model.bat.charging ? '<span class="rc-charging">⚡ 充电中</span>' : '') +
      '  </div>' +
      ((model.streak > 0 || (model.badges && model.badges.length)) ?
        '  <div class="rc-achieve">' +
        (model.streak > 0 ? '<span class="rc-streak">🔥 连续打卡 ' + model.streak + ' 天</span>' : '') +
        (model.badges || []).map(function (b) { return '<span class="rc-badge">' + U.esc(b) + '</span>'; }).join('') +
        '  </div>' : '') +
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
    var padL = 30, padR = 12, padTop = 42, padBottom = 28;
    ctx.clearRect(0, 0, W, H);
    // 底色
    ctx.fillStyle = '#F5F7FB';
    ctx.fillRect(0, 0, W, H);
    // 标题（独立顶部，不侵入绘图区）
    ctx.fillStyle = '#0B1220';
    ctx.font = 'bold 16px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('活跃时段（上报点分布）', padL, 22);
    // 绘图区（标题下方，与标题留白，避免重叠）
    var chartBottom = H - padBottom;
    var chartTop = padTop;
    var chartH = chartBottom - chartTop;
    var max = Math.max.apply(null, hours) || 1;
    var bw = (W - padL - padR) / 24;
    for (var h = 0; h < 24; h++) {
      var bh = hours[h] / max * chartH;
      if (hours[h] > 0) {
        ctx.fillStyle = TH.cssVar('--brand-600', '#4F46E5');
        ctx.globalAlpha = 0.35 + 0.65 * (hours[h] / max);
        ctx.fillRect(padL + h * bw + 2, chartBottom - bh, bw - 4, bh);
        ctx.globalAlpha = 1;
      }
      // 刻度（每 6 小时）
      if (h % 6 === 0) {
        ctx.fillStyle = '#64748B';
        ctx.font = '13px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(h + '时', padL + h * bw + bw / 2, chartBottom + 16);
      }
    }
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
        var topH = 150, devH = 60, heroH = 240, gridH = 170, hoursH = 140, footH = 60, pad = 24;
        var totalH = topH + devH + heroH + gridH + hoursH + footH + pad * 2;
        off.height = totalH * scale;
        ctx.scale(scale, scale);
        // 背景
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, W, totalH);
        // 头部渐变条
        var grad = ctx.createLinearGradient(0, 0, W, topH);
        grad.addColorStop(0, TH.cssVar('--brand-600', '#4F46E5'));
        grad.addColorStop(1, '#06B6D4');
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
        var y = topH + 16;
        // Hero 距离
        ctx.fillStyle = TH.cssVar('--brand-600', '#4F46E5');
        ctx.font = 'bold 64px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(fmtDist(model.distance), W / 2, y + 64);
        ctx.fillStyle = '#64748B';
        ctx.font = '20px sans-serif';
        ctx.fillText('今日移动距离', W / 2, y + 94);
        // 口吻总结
        ctx.fillStyle = '#0B1220';
        ctx.font = '18px sans-serif';
        ctx.fillText(model.summary, W / 2, y + 126);
        // 趣味换算
        var funText = (model.funLines || []).join(' · ');
        if (funText) {
          ctx.fillStyle = '#64748B';
          ctx.font = '15px sans-serif';
          ctx.fillText(funText, W / 2, y + 152);
        }
        // 连续打卡 + 徽章
        var achParts = [];
        if (model.streak > 0) achParts.push('🔥 连续打卡 ' + model.streak + ' 天');
        achParts = achParts.concat(model.badges || []);
        if (achParts.length) {
          ctx.fillStyle = '#F59E0B';
          ctx.font = '16px sans-serif';
          ctx.fillText(achParts.join('  '), W / 2, y + 184);
        }
        ctx.textAlign = 'left';
        // 六宫格
        y = topH + heroH;
        var items = [
          ['🚶 步数', model.steps !== null ? String(model.steps) : '--'],
          ['⚡ 步频', model.cadence != null ? Math.round(model.cadence) + ' 步/分' : '--'],
          ['🏃 均速', model.avgKmh != null ? model.avgKmh + ' km/h' : '--'],
          ['📍 轨迹点', String(model.trackCount)],
          ['🔋 电量', model.bat ? (model.bat.pctFirst !== null && model.bat.pctLast !== null ? model.bat.pctFirst + '%→' + model.bat.pctLast + '%' : '--') : '--'],
          ['⚡ 耗速', model.bat && model.bat.perHour !== null ? model.bat.perHour + ' mV/h' : '--'],
          ['📶 在线', model.online.reports > 0 ? Math.min(100, Math.round(model.online.hoursCovered / 24 * 100)) + '%' : '0%'],
          ['🌡 温度', model.temp !== null ? model.temp + '℃' : '--']
        ];
        var gw = (W - pad * 2) / 4, gh = (gridH - 20) / 2;
        items.forEach(function (it, idx) {
          var gx = pad + (idx % 4) * gw;
          var gy = y + Math.floor(idx / 4) * gh;
          ctx.fillStyle = '#F5F7FB';
          ctx.fillRect(gx + 4, gy + 4, gw - 8, gh - 8);
          ctx.fillStyle = '#64748B';
          ctx.font = '15px sans-serif';
          ctx.fillText(it[0], gx + 16, gy + 30);
          ctx.fillStyle = '#0B1220';
          ctx.font = 'bold 21px sans-serif';
          ctx.fillText(it[1], gx + 16, gy + 58);
        });
        // 活跃时段（把已画的 canvas 拷贝进来）
        y = topH + heroH + gridH;
        ctx.drawImage(hoursCv, 0, y, W, hoursH - 10);
        // 页脚（位置 + 活跃时长/上报/充电 + 来源）
        y = topH + heroH + gridH + hoursH;
        ctx.fillStyle = '#64748B';
        ctx.font = '15px sans-serif';
        var addr = model.latest && model.latest.address ? model.latest.address : '--';
        if (addr.length > 34) addr = addr.slice(0, 33) + '…';
        ctx.fillText('📍 ' + addr, pad, y + 16);
        var metaLine = '⏱ 活跃 ' + fmtDuration(model.durationMs) + ' · 📡 上报 ' + model.online.reports + ' 次';
        if (model.bat && model.bat.charging) metaLine += ' · ⚡ 充电中';
        ctx.fillText(metaLine, pad, y + 40);
        ctx.textAlign = 'right';
        ctx.fillText('AirCloud · 真实数据', W - pad, y + 40);
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
          '🐾 ' + m.summary
        ];
        if (m.streak > 0) lines.push('🔥 连续打卡 ' + m.streak + ' 天');
        if (m.badges && m.badges.length) lines.push('🎖 ' + m.badges.join(' · '));
        lines.push('🏃 移动：' + fmtDist(m.distance) + '（' + m.trackCount + ' 个轨迹点）');
        lines.push('🚶 步数：' + (m.steps !== null ? m.steps : '--') + (m.cadence != null ? ' · 步频 ' + Math.round(m.cadence) + ' 步/分' : ''));
        lines.push('🏃 均速：' + fmtSpeed(m.avgKmh) + ' · ⏱ 活跃 ' + fmtDuration(m.durationMs));
        lines.push('🔋 电量：' + (m.bat ? (m.bat.pctFirst !== null && m.bat.pctLast !== null ? m.bat.pctFirst + '% → ' + m.bat.pctLast + '%' : m.bat.firstMv + '→' + m.bat.lastMv + 'mV') : '--') + (m.bat && m.bat.charging ? '（充电中）' : ''));
        lines.push('⚡ 耗速：' + (m.bat && m.bat.perHour !== null ? m.bat.perHour + ' mV/h' : '--'));
        lines.push('📶 在线覆盖：' + (m.online.reports > 0 ? Math.min(100, Math.round(m.online.hoursCovered / 24 * 100)) + '%' : '0%'));
        lines.push('🌡 温度：' + (m.temp !== null ? m.temp + '℃' : '--'));
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