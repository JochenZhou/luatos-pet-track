/**
 * algo/alg.js —— 算法模块聚合入口 + 跌倒检测
 * 挂载：window.Algo（合并 wgs2gcj / imufilter / stepcount / attitude 及本文件的 detectFall）
 * 合并顺序约定：wgs2gcj -> imufilter -> stepcount -> attitude -> alg
 */
(function (global) {
  'use strict';

  var A = global.Algo || (global.Algo = {});

  /**
   * 跌倒检测：窗口内加速度幅值剧烈冲击（>impulseG）+ 随后静止（natural）
   * opts: { impulseG(默认3.0), staticTol(默认0.08), windowMs(默认2000), sampleRate(默认20), gravityComp(默认true) }
   * 返回 {fall, confidence, impactTime, seq}
   */
  function detectFall(samples, opts) {
    opts = opts || {};
    if (!samples || samples.length < 4) return { fall: false, confidence: 0, impactTime: 0, seq: 0 };
    var impulseG = typeof opts.impulseG === 'number' ? opts.impulseG : 3.0;
    var staticTol = typeof opts.staticTol === 'number' ? opts.staticTol : 0.08;
    var sr = opts.sampleRate || 20;
    var windowMs = opts.windowMs || 2000;
    var winN = Math.max(4, Math.round(windowMs / 1000 * sr));

    var mag = [];
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (!s) continue;
      var x = isFinite(+s.x) ? +s.x : 0;
      var y = isFinite(+s.y) ? +s.y : 0;
      var z = isFinite(+s.z) ? +s.z : 0;
      mag.push({
        t: s.t !== undefined ? +s.t : i * 1000 / sr,
        m: Math.sqrt(x * x + y * y + z * z)
      });
    }
    if (mag.length < winN) return { fall: false, confidence: 0, impactTime: 0, seq: 0 };

    var fall = false;
    var confidence = 0;
    var impactTime = 0;
    var seq = 0;

    // 滑动窗口：找「冲击 + 随后静止」模式
    for (var j = 0; j + winN <= mag.length; j++) {
      var windowSlice = mag.slice(j, j + winN);
      var peak = -Infinity;
      var peakIdx = -1;
      for (var w = 0; w < windowSlice.length; w++) {
        if (windowSlice[w].m > peak) { peak = windowSlice[w].m; peakIdx = w; }
      }
      if (peak < impulseG) continue;
      // 冲击后段（最后 60%）是否接近静止（幅值接近 1g）
      var postStart = Math.round(windowSlice.length * 0.4);
      var steady = 0, cnt = 0;
      for (var p = postStart; p < windowSlice.length; p++) {
        steady += Math.abs(windowSlice[p].m - 1);
        cnt++;
      }
      var avgDev = cnt ? steady / cnt : Infinity;
      if (avgDev < Math.max(staticTol, 0.15)) {
        var locImp = peak * 1.0;
        confidence = Math.min(1, (locImp - impulseG) / (impulseG * 2) * 0.6 + 0.4);
        fall = true;
        impactTime = windowSlice[peakIdx].t;
        seq = j;
        break;
      }
    }
    return { fall: fall, confidence: Math.max(0, Math.round(confidence * 100) / 100), impactTime: impactTime, seq: seq };
  }

  A.detectFall = detectFall;

  /* ================= 轨迹异常点剔除 ================= */

  /** 两点球面距离（米）—— 仅用于轨迹判定，不对外承诺坐标语义 */
  function distM(lng1, lat1, lng2, lat2) {
    var R = 6371000;
    var dLat = (lat2 - lat1) * Math.PI / 180;
    var dLng = (lng2 - lng1) * Math.PI / 180;
    var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
      Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
      Math.sin(dLng / 2) * Math.sin(dLng / 2);
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  }

  /**
   * 轨迹异常点剔除：太跳跃的点直接抛弃。
   *
   * ⚠️ 已下线（2026-09-11 周总要求）：getTrack 出口不再调用本函数。
   * 原因：定位器经常放在货车上跑高速 —— 跨上报间隔跑 2km+ 属于正常行驶，
   * 33.3m/s（120km/h）速度判据 + 5km 距离判据都会把正常轨迹误杀，
   * 日报里程 / 轨迹点数随之失真。
   * 函数保留：将来若要兜底真正的 GPS 瞬移（如漂到外省），把阈值放宽到
   * maxSpeed≈280m/s（1000km/h 量级）+ maxJump≈50km 再启用才安全。
   *
   * 为什么需要：定位漂移（尤其 1294 差分展开时该记录参考点取错）会让折线上突然
   * 拉出一条远超正常范围的长直线再弹回来，肉眼看着像「瞬移」；日报里还会把里程
   * 算爆、把最远点算错。
   *
   * 判定基准是「锚点」= 上一个**保留**的点，锚点只在保留时前移：
   *   - 速度判据：距离 / 时间间隔 > maxSpeed(m/s) → 跳点
   *   - 绝对判据：距离 > maxJump(m)               → 跳点
   * 用锚点而不是「前一个点」是关键：一整包都偏出去时，包首点被丢后锚点原地不动，
   * 包内其余点同样判定超限 → **整包一起丢**，不会留下半截飞出去再飞回来的线段。
   *
   * 时间间隔优先取 p.dtPrev：1294 包内 10 个样本是 10s/10=1s 一个，跨记录取真实
   * 上报间隔。**不能**直接拿 p.ts 相减 —— 包内 ts 只差 1ms（那是为了让排序稳定
   * 才这么排的），拿它算速度会把正常行走全部判成瞬移。
   *
   * @param points 按时间升序的轨迹点
   * @param opts   { maxSpeed:33.3, maxJump:5000 }  33.3m/s 与日报 trackStats 的判据保持一致
   * @param stats  可选，回填 { dropped, kept }
   * @returns 剔除后的新数组（不修改入参）
   */
  function filterTrackOutliers(points, opts, stats) {
    opts = opts || {};
    var maxSpeed = opts.maxSpeed > 0 ? opts.maxSpeed : 33.3;
    var maxJump = opts.maxJump > 0 ? opts.maxJump : 5000;
    var dropped = 0;
    var out = [];
    if (points && points.length) {
      var anchor = null;
      for (var i = 0; i < points.length; i++) {
        var p = points[i];
        if (!p || !isFinite(p.lng) || !isFinite(p.lat)) { dropped++; continue; }
        if (!anchor) { out.push(p); anchor = p; continue; }
        var d = distM(anchor.lng, anchor.lat, p.lng, p.lat);
        if (d > maxJump) { dropped++; continue; }
        var dt = (typeof p.dtPrev === 'number' && p.dtPrev > 0)
          ? p.dtPrev
          : ((p.ts && anchor.ts && p.ts > anchor.ts) ? (p.ts - anchor.ts) / 1000 : 0);
        if (dt > 0 && d / dt > maxSpeed) { dropped++; continue; }
        out.push(p);
        anchor = p;
      }
    }
    if (stats) { stats.dropped = dropped; stats.kept = out.length; }
    return out;
  }

  A.distM = distM;
  A.filterTrackOutliers = filterTrackOutliers;

  // 暴露版本与坐标转换快捷方法（保证聚合后都存在）
  A.VERSION = '0.3';
})(window);