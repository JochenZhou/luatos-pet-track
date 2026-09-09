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

  // 暴露版本与坐标转换快捷方法（保证聚合后都存在）
  A.VERSION = '0.3';
})(window);