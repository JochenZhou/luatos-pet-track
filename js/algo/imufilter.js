/**
 * algo/imufilter.js —— gsensor 原始数据滤波（一阶低通 + 可选滑动平均）
 * 挂载：window.Algo.filterGsensor
 * 输入样本：{x,y,z}（g 或原始 ADC，由 opts.scale 标识），输出同结构数组。
 */
(function (global) {
  'use strict';

  var A = global.Algo || (global.Algo = {});

  function clamp(v, lo, hi) {
    if (v < lo) return lo;
    if (v > hi) return hi;
    return v;
  }

  function empty() { return { x: 0, y: 0, z: 0 }; }

  /**
   * 一阶低通滤波（EMA），alpha 由截止频率与采样率估计
   * opts: { alpha: 直接给系数(0~1, 越小越平滑)，或 sampleRate+cutoffHz 自动算 }
   */
  function lowPass(samples, opts) {
    opts = opts || {};
    var out = [];
    var prev = empty();
    var alpha = 0.3;
    if (typeof opts.alpha === 'number' && isFinite(opts.alpha)) {
      alpha = clamp(opts.alpha, 0.01, 1);
    } else {
      var sr = opts.sampleRate || 20;
      var cf = opts.cutoffHz || 2.5;
      var dt = 1 / sr;
      var rc = 1 / (2 * Math.PI * cf);
      alpha = dt / (rc + dt);
    }
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (!s) continue;
      var x = isFinite(+s.x) ? +s.x : 0;
      var y = isFinite(+s.y) ? +s.y : 0;
      var z = isFinite(+s.z) ? +s.z : 0;
      var o = {
        x: prev.x + alpha * (x - prev.x),
        y: prev.y + alpha * (y - prev.y),
        z: prev.z + alpha * (z - prev.z),
        t: s.t !== undefined ? s.t : (i * (1000 / (opts.sampleRate || 20)))
      };
      out.push(o);
      prev = o;
    }
    return out;
  }

  /**
   * 滑动平均滤波
   * opts: { window: 窗口大小 }
   */
  function movingAverage(samples, opts) {
    opts = opts || {};
    var win = Math.max(1, Math.floor(opts.window || 5));
    var out = [];
    for (var i = 0; i < samples.length; i++) {
      var acc = empty();
      var start = Math.max(0, i - win + 1);
      var count = 0;
      for (var j = start; j <= i; j++) {
        var s = samples[j];
        if (!s) continue;
        acc.x += isFinite(+s.x) ? +s.x : 0;
        acc.y += isFinite(+s.y) ? +s.y : 0;
        acc.z += isFinite(+s.z) ? +s.z : 0;
        count++;
      }
      if (!count) { out.push(empty()); continue; }
      var src = samples[i];
      out.push({
        x: acc.x / count,
        y: acc.y / count,
        z: acc.z / count,
        t: src && src.t !== undefined ? src.t : i
      });
    }
    return out;
  }

  /**
   * 合成加速度幅值（去除重力可另行在 stepcount 处理）
   */
  function magnitude(s) {
    if (!s) return 0;
    var x = isFinite(+s.x) ? +s.x : 0;
    var y = isFinite(+s.y) ? +s.y : 0;
    var z = isFinite(+s.z) ? +s.z : 0;
    return Math.sqrt(x * x + y * y + z * z);
  }

  function filterGsensor(samples, opts) {
    opts = opts || {};
    if (!samples || !samples.length) return [];
    var cleaned = [];
    for (var i = 0; i < samples.length; i++) {
      if (samples[i]) cleaned.push(samples[i]);
    }
    if (!cleaned.length) return [];
    var mode = opts.mode || 'lowpass'; // lowpass | moving
    var out = mode === 'moving' ? movingAverage(cleaned, opts) : lowPass(cleaned, opts);
    return out;
  }

  A.filterGsensor = filterGsensor;
  A.__test = {
    magnitude: magnitude,
    lowPass: lowPass,
    movingAverage: movingAverage
  };
})(window);