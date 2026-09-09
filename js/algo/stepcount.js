/**
 * algo/stepcount.js —— 基于合成加速度幅值的计步（峰值检测 + 最小步间隔 + 自适应阈值）
 * 挂载：window.Algo.countSteps
 * 输入：滤波后 gsensor 样本数组 [{x,y,z,t}]（t 毫秒时间戳，可缺省按 sampleRate 推断）
 */
(function (global) {
  'use strict';

  var A = global.Algo || (global.Algo = {});

  /**
   * 合成加速度幅值（g），减去 1g 重力消除常数偏置
   */
  function mags(samples) {
    var out = [];
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (!s) continue;
      var x = isFinite(+s.x) ? +s.x : 0;
      var y = isFinite(+s.y) ? +s.y : 0;
      var z = isFinite(+s.z) ? +s.z : 0;
      out.push({ t: s.t !== undefined ? +s.t : i, m: Math.sqrt(x * x + y * y + z * z), a: Math.abs(Math.sqrt(x * x + y * y + z * z) - 1) });
    }
    return out;
  }

  /**
   * countSteps(samples, opts)
   * opts: { sampleRate(默认20Hz), minIntervalMs(默认 300ms = 最快200步/分钟), threshold(手动阈值，默认自动), gravityComp(默认true) }
   * 返回 { steps, cadence, confidence }
   */
  function countSteps(samples, opts) {
    opts = opts || {};
    if (!samples || samples.length < 3) return { steps: 0, cadence: 0, confidence: 0 };
    var src = samples;
    var gComp = opts.gravityComp !== false;

    // 幅值序列
    var mag = [];
    for (var i = 0; i < src.length; i++) {
      var s = src[i];
      if (!s) continue;
      var x = isFinite(+s.x) ? +s.x : 0;
      var y = isFinite(+s.y) ? +s.y : 0;
      var z = isFinite(+s.z) ? +s.z : 0;
      var m = Math.sqrt(x * x + y * y + z * z);
      mag.push({ t: s.t !== undefined ? +s.t : (i * 1000 / (opts.sampleRate || 20)), m: gComp ? Math.abs(m - 1) : m });
    }
    if (mag.length < 3) return { steps: 0, cadence: 0, confidence: 0 };

    // 自适应阈值：峰值的 60% 作为检测阈值（取 90 分位作为典型峰值）
    var sorted = mag.map(function (p) { return p.m; }).sort(function (a, b) { return a - b; });
    var p90 = sorted[Math.floor(sorted.length * 0.9)];
    var median = sorted[Math.floor(sorted.length * 0.5)];
    var threshold = (typeof opts.threshold === 'number' && opts.threshold > 0)
      ? opts.threshold
      : Math.max(0.05, (p90 + median) / 2 * 0.6);

    var minInterval = opts.minIntervalMs || 250;
    var steps = 0;
    var lastStepT = -Infinity;
    var peakT = -1;
    var peakV = -1;
    var above = false;
    var crossings = 0;

    for (var j = 0; j < mag.length; j++) {
      var p = mag[j];
      if (p.m > threshold) {
        if (!above) { above = true; crossings++; }
        if (p.m > peakV) { peakV = p.m; peakT = p.t; }
      } else {
        if (above) {
          // 离开峰值区，判定一步
          if (peakT - lastStepT >= minInterval) {
            steps++;
            lastStepT = peakT;
          }
          above = false;
          peakV = -1;
        }
      }
    }
    if (above && peakT - lastStepT >= minInterval) {
      steps++;
    }

    // 步频：用首个/末个步间隔估算，cpm
    var cadence = 0;
    if (mag.length >= 2 && steps > 0) {
      var spanT = mag[mag.length - 1].t - mag[0].t;
      if (spanT > 3000) {
        cadence = Math.round(steps * 60000 / spanT);
      } else if (steps > 0) {
        cadence = Math.min(200, Math.round(steps * 60000 / Math.max(2000, spanT)));
      }
    }
    var confidence = Math.min(1, steps / Math.max(1, Math.round(src.length / ((opts.sampleRate || 20) * 1.0) * 0.8)));
    return { steps: steps, cadence: cadence, confidence: Math.max(0, Math.round(confidence * 100) / 100) };
  }

  A.countSteps = countSteps;
  A.__test = { mags: mags };
})(window);