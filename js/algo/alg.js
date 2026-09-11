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
   * 轨迹异常点清理 —— **零误杀策略**（2026-09-11 第三版）。
   *
   * 背景：第一版用 33.3m/s（120km/h）+ 5km 判据，但定位器经常放在货车上跑高速，
   * 正常行驶被整段误杀（周总反馈「不要过滤」）；第二版完全下线，结果 GPS 漂移
   * 全部显现，轨迹比原来更乱（周总再次反馈）。本版折中：**只删铁定是漂移的点**，
   * 真实车辆永远够不着阈值。
   *
   * 三层判据（按顺序，锚点 = 上一个「保留」的点）：
   *   1) 物理不可能：单步 > jumpPhys(30km) 或等效速度 > vPhys(700km/h) → 删。
   *      真实车辆绝无可能，零误杀。
   *   2) 单步自适应上限：stray = max(strayMin(2.5km), vLimit(200km/h) × dt)。
   *      货车 120km/h 在 10s 间隔每步 ≈340m、60s 间隔 ≈2km，都够不着 2.5km 下限；
   *      而普通 GPS 单点漂移几百米到几公里，会撞线。
   *   3) 孤立漂移检验（只对撞线的点做）：p 距锚点超限，且下一个点距 p 仍超限，
   *      但下一个点距锚点反而更近（轨迹「回来了」）→ p 是孤立跳点，删。
   *      连续移动（真开车）时下一个点只会更远 → 不删。整包偏移（包内点相互很近）
   *      也不删 —— 宁可多留一条偏移线，不丢任何真实数据。
   *
   * 时间间隔优先取 p.dtPrev：1294 包内 10 个样本是 1s 一个，跨记录取真实上报
   * 间隔。**不能**直接拿 p.ts 相减 —— 包内 ts 只差 1ms（为了让排序稳定），
   * 拿它算速度会把正常行走全部判成瞬移。
   *
   * @param points 按时间升序的轨迹点
   * @param opts   { vPhys:194.4, jumpPhys:30000, vLimit:55.6, strayMin:2500 }
   * @param stats  可选，回填 { dropped, kept }
   * @returns 清理后的新数组（不修改入参）
   */
  function filterTrackOutliers(points, opts, stats) {
    opts = opts || {};
    var vPhys = opts.vPhys > 0 ? opts.vPhys : 194.4;      // 700km/h，物理不可能
    var jumpPhys = opts.jumpPhys > 0 ? opts.jumpPhys : 30000;
    var vLimit = opts.vLimit > 0 ? opts.vLimit : 55.6;    // 200km/h，单步上限
    var strayMin = opts.strayMin > 0 ? opts.strayMin : 2500;
    var dropped = 0;
    var out = [];
    if (points && points.length) {
      var anchor = null;
      for (var i = 0; i < points.length; i++) {
        var p = points[i];
        if (!p || !isFinite(p.lng) || !isFinite(p.lat)) { dropped++; continue; }
        if (!anchor) { out.push(p); anchor = p; continue; }
        var d = distM(anchor.lng, anchor.lat, p.lng, p.lat);
        // 1) 物理不可能
        if (d > jumpPhys) { dropped++; continue; }
        var dt = (typeof p.dtPrev === 'number' && p.dtPrev > 0)
          ? p.dtPrev
          : ((p.ts && anchor.ts && p.ts > anchor.ts) ? (p.ts - anchor.ts) / 1000 : 0);
        if (dt > 0 && d / dt > vPhys) { dropped++; continue; }
        // 2) 单步自适应上限
        var stray = Math.max(strayMin, vLimit * (dt > 0 ? dt : 10));
        if (d > stray) {
          // 3) 孤立漂移检验：下一个合法点也远离、且距锚点反而更近 → p 是孤立跳点
          var n = null;
          for (var j = i + 1; j < points.length; j++) {
            if (points[j] && isFinite(points[j].lng) && isFinite(points[j].lat)) { n = points[j]; break; }
          }
          if (n) {
            var dNext = distM(p.lng, p.lat, n.lng, n.lat);
            var dBack = distM(anchor.lng, anchor.lat, n.lng, n.lat);
            if (dNext > stray && dBack < d * 0.9) { dropped++; continue; }
          }
          // 不满足孤立特征（连续远离 = 可能在真实移动）→ 保留
        }
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