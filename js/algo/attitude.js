/**
 * algo/attitude.js —— 基于重力向量的姿态估计（roll/pitch，无磁力计给 yaw=0）
 * 挂载：window.Algo.estimateAttitude
 * 输入：{x,y,z} 加速度（g），静止/低速时重力向量即加速度向量。
 */
(function (global) {
  'use strict';

  var A = global.Algo || (global.Algo = {});

  var R2D = 180 / Math.PI;

  function estimateAttitude(accel) {
    if (!accel) return { roll: 0, pitch: 0, yaw: 0 };
    var x = isFinite(+accel.x) ? +accel.x : 0;
    var y = isFinite(+accel.y) ? +accel.y : 0;
    var z = isFinite(+accel.z) ? +accel.z : 0;
    var norm = Math.sqrt(x * x + y * y + z * z);
    if (norm < 1e-6) return { roll: 0, pitch: 0, yaw: 0 };

    // roll：绕 X 轴转角 = atan2(y, z)
    // pitch：绕 Y 轴转角 = atan2(-x, sqrt(y^2+z^2))
    var roll = Math.atan2(y, z) * R2D;
    var pitch = Math.atan2(-x, Math.sqrt(y * y + z * z)) * R2D;
    return { roll: roll, pitch: pitch, yaw: 0 };
  }

  /**
   * 静止检测：窗口内幅值方差低于阈值视为静止
   * 返回 {static:boolean, variance:number}
   */
  function isStatic(samples, opts) {
    opts = opts || {};
    if (!samples || samples.length < 2) return { static: false, variance: Infinity };
    var m = [];
    for (var i = 0; i < samples.length; i++) {
      var s = samples[i];
      if (!s) continue;
      var x = isFinite(+s.x) ? +s.x : 0;
      var y = isFinite(+s.y) ? +s.y : 0;
      var z = isFinite(+s.z) ? +s.z : 0;
      m.push(Math.sqrt(x * x + y * y + z * z));
    }
    var mean = 0;
    for (var j = 0; j < m.length; j++) mean += m[j];
    mean /= m.length;
    var variance = 0;
    for (var k = 0; k < m.length; k++) variance += (m[k] - mean) * (m[k] - mean);
    variance /= m.length;
    var tol = (typeof opts.tol === 'number') ? opts.tol : 0.08; // g^2
    return { static: variance < tol, variance: variance };
  }

  A.estimateAttitude = estimateAttitude;
  A.isStatic = isStatic;
})(window);