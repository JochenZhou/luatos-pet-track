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

  /* ================= 轨迹异常点清理（综合版 v7，2026-09-11） ================= */

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
   * 轨迹异常点清理 —— **综合版 v7**（2026-09-11 第七版，按 9.10 真机数据回放设计）。
   *
   * v6 及之前所有版本都在猜数据形态。9.10 全天 2500+ 真实点位回放揭示三个事实：
   *   A) 设备是「冻结-跳变」式更新：坐标冻结数分钟后沿路线一次性跳 2~8km
   *      （瞬时 500~2900km/h）。这是真实行程 —— 任何「单步/锚点速度上限」
   *      都会把整条路线删光。v6 回放：831 点删剩 42 点，留下 13 段共
   *      1382km 的直线，正是周总截图里嘉峪关直插兰州的那条线（级联误删：
   *      锚点落后 → 后续点显得更快 → 删更多）。
   *   B) 设备会把缓存位置整段补传：batch_time 在下午、坐标与上午完全相同
   *      （连毫秒级浮点都一致），轨迹被原样画两遍。
   *   C) 真正的「跳变」是垂直尖刺：偏离路线 7~8km、停 1~2 个点、原路弹回，
   *      A~C 净位移仅 1~2km（出去/回来瞬时 400~2900km/h）。
   *
   * 因此 v7 放弃逐点速度判罚，改为三步（判定全部在原始序列上预计算，
   * **删除不级联** —— 这是与 v6 的本质区别）：
   *
   *   1) 全局坐标去重：完全相同的 (lng,lat) 只留首次出现，补传副本全删。
   *      GPS 重新定位不可能产出完全相同的浮点坐标，只有复制品才会。
   *   2) 相邻同位折叠：连续 150m 内的点折成一个「节点」（停留时段）。
   *   3) 折返尖刺检验：折叠序列三元组 (A,B,C) 同时满足 ——
   *        max(dAB,dBC) > spikeMin(1km)              折离得足够远才值得管
   *        dAB + dBC > ratioK(2.5) × max(dAC, 500m)  B 是「出去又回来」形状
   *        进出至少一侧是瞬移（dt 无效，或该侧速度 > vSpike 200km/h）
   *      → B 节点（含折叠点）是尖刺，整节删。
   *      真实调头/绕行：相邻点几百米，够不着 spikeMin；真实低频往返
   *      （10km 外用 600s 返程，60km/h）达不成 vSpike → 一律保留。
   *      沿线跳变（A 事实）：三点近似共线，dAB+dBC ≈ dAC，比值≈1 → 保留。
   *
   * @param points 按时间升序的轨迹点
   * @param opts   { spikeMin:1000, ratioK:2.5, mergeM:150, vSpike:55.6 }
   * @param stats  可选，回填 { dropped, kept, dupes }（dropped=尖刺+非法点，
   *               dupes=补传去重数，二者分开便于 UI 区分口径）
   * @returns 清理后的新数组（不修改入参）
   */
  function filterTrackOutliers(points, opts, stats) {
    opts = opts || {};
    var spikeMin = opts.spikeMin > 0 ? opts.spikeMin : 1000;
    var ratioK = opts.ratioK > 0 ? opts.ratioK : 2.0;
    var mergeM = opts.mergeM > 0 ? opts.mergeM : 150;
    var vSpike = opts.vSpike > 0 ? opts.vSpike : 55.6;
    var dropped = 0, dupes = 0;
    var out = [];
    var p, key;
    if (points && points.length) {
      /* 1) 全局坐标去重（补传副本与原点坐标相同，只留首次）。
         键量化到 6 位小数（≈0.1m）：history 流是全精度浮点、tags 流是
         6 位小数字符串，同一位置跨源精度不同，精确相等会漏判。 */
      var seen = {};
      var uniq = [];
      for (var i = 0; i < points.length; i++) {
        p = points[i];
        if (!p || !isFinite(p.lng) || !isFinite(p.lat)) { dropped++; continue; }
        key = p.lng.toFixed(6) + '|' + p.lat.toFixed(6);
        if (seen[key]) { dupes++; continue; }
        seen[key] = 1;
        uniq.push(p);
      }
      /* 1.5) 同秒多点取舍：同一时刻上报多个相距甚远的位置（时标异常/补传
         交错）时，折返检验只能删「中间」点、留「末端」点 —— 若同秒两点
         排序颠倒，会把在线点删掉、留下离线点（9.10 真实数据踩过）。
         这里按「与前后点衔接总距离最小」挑一个保留，其余删除。 */
      var tidy = [];
      for (i = 0; i < uniq.length;) {
        var j2 = i + 1;
        while (j2 < uniq.length && Math.abs((uniq[j2].ts || 0) - (uniq[i].ts || 0)) <= 1000) j2++;
        if (j2 - i >= 2) {
          var far = false;
          for (var x1 = i; x1 < j2 && !far; x1++) {
            for (var x2 = x1 + 1; x2 < j2; x2++) {
              if (distM(uniq[x1].lng, uniq[x1].lat, uniq[x2].lng, uniq[x2].lat) > 500) { far = true; break; }
            }
          }
          if (!far) {
            for (x1 = i; x1 < j2; x1++) tidy.push(uniq[x1]);
          } else {
            var prevRef = tidy.length ? tidy[tidy.length - 1] : null;
            var nextRef = j2 < uniq.length ? uniq[j2] : null;
            var best = -1, bestScore = Infinity;
            for (x1 = i; x1 < j2; x1++) {
              var sc = 0;
              if (prevRef) sc += distM(prevRef.lng, prevRef.lat, uniq[x1].lng, uniq[x1].lat);
              if (nextRef) sc += distM(uniq[x1].lng, uniq[x1].lat, nextRef.lng, nextRef.lat);
              if (sc < bestScore) { bestScore = sc; best = x1; }
            }
            for (x1 = i; x1 < j2; x1++) {
              if (x1 !== best) { dropped++; continue; }
              tidy.push(uniq[x1]);
            }
          }
        } else {
          tidy.push(uniq[i]);
        }
        i = j2;
      }
      uniq = tidy;
      /* 2) 相邻同位折叠：距上一节点代表点 <= mergeM 的连续点并入该节点
         （节点记录 uniq 的下标区间 [i0,i1]，便于回标） */
      var nodes = [];
      for (i = 0; i < uniq.length; i++) {
        p = uniq[i];
        var last = nodes.length ? nodes[nodes.length - 1] : null;
        if (last && distM(last.repr.lng, last.repr.lat, p.lng, p.lat) <= mergeM) {
          last.tEnd = p.ts;
          last.i1 = i;
          continue;
        }
        nodes.push({ repr: p, t0: p.ts, tEnd: p.ts, i0: i, i1: i });
      }
      /* 3) 折返尖刺检验（预计算节点标记，不级联） */
      var dropNode = {};
      for (i = 1; i < nodes.length - 1; i++) {
        var a = nodes[i - 1], b = nodes[i], c = nodes[i + 1];
        var d1 = distM(a.repr.lng, a.repr.lat, b.repr.lng, b.repr.lat);
        var d2 = distM(b.repr.lng, b.repr.lat, c.repr.lng, c.repr.lat);
        var dac = distM(a.repr.lng, a.repr.lat, c.repr.lng, c.repr.lat);
        if (Math.max(d1, d2) <= spikeMin) continue;
        if (d1 + d2 <= ratioK * Math.max(dac, 500)) continue;
        var dt1 = (b.t0 - a.tEnd) / 1000;
        var dt2 = (c.t0 - b.tEnd) / 1000;
        var fast1 = (!(dt1 > 0)) || d1 / dt1 > vSpike;
        var fast2 = (!(dt2 > 0)) || d2 / dt2 > vSpike;
        if (fast1 || fast2) dropNode[i] = 1;
      }
      /* 汇总输出：被标节点连同其折叠点全部剔除 */
      var nodeIdx = -1;
      for (i = 0; i < uniq.length; i++) {
        if (nodeIdx < nodes.length - 1 && i === nodes[nodeIdx + 1].i0) nodeIdx++;
        if (nodeIdx >= 0 && dropNode[nodeIdx]) { dropped++; continue; }
        out.push(uniq[i]);
      }
    }
    if (stats) { stats.dropped = dropped; stats.kept = out.length; stats.dupes = dupes; }
    return out;
  }

  A.distM = distM;
  A.filterTrackOutliers = filterTrackOutliers;

  A.VERSION = '0.3';
})(window);