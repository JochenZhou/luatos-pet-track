/**
 * app/petstatus.js —— 设备状态解算（1293 gsensor / 1294 GNSS 辅助）
 * 挂载：window.PetStatus
 * 1293：12bit 三轴加速度（样本打包于 val_hex；解析约定每样本 6B = 3× int16，
 * 12bit 值左对齐存放在 16bit 高 12 位，量程 ±8g）。
 * 仅真实数据，无任何模拟。
 */
(function (global) {
  'use strict';
  var U = global.Utils;
  var CFG = global.CFG;
  var Algo = global.Algo;

  /**
   * hex TLV 解包：取连续字节（支持 "/" 分隔多段，只取第一段，或拼接？）
   * 这里按记录语义：val_hex 整体是 TLV 十六进制串；1293 段提取后按样本解。
   */
  function hexToBytes(hex, skipSegments) {
    var clean = String(hex).replace(/[^0-9a-fA-F]/g, '');
    var bytes = [];
    for (var i = 0; i + 1 < clean.length; i += 2) {
      bytes.push(parseInt(clean.substr(i, 2), 16));
    }
    return bytes;
  }

  /**
   * 解包 gsensor 样本：每样本 6B = x/y/z 各 int16（大端，12bit 左对齐）
   * 返回 [{x,y,z,gx,gy,gz,t}]；x/y/z 为原始 ADC(-2048~2047)，gx/gy/gz 为 g 值(±8g)
   */
  function decodeGsensor(rec, sampleRate) {
    sampleRate = sampleRate || 20;
    var val = AC_recValAny(rec, 1293);
    if (val === undefined || val === null) return [];
    var bytes = null;
    if (typeof val === 'string' && /^[0-9a-fA-F]+$/i.test(val.replace(/[^0-9a-fA-F]/g, ''))) {
      bytes = hexToBytes(val);
    } else if (Array.isArray(val)) {
      bytes = [];
      for (var i = 0; i < val.length; i++) bytes.push(Number(val[i]) & 0xFF);
    } else {
      return [];
    }
    var samples = [];
    var t0 = U.recTs(rec) || Date.now();
    var n = Math.floor(bytes.length / 6);
    for (var s = 0; s < n; s++) {
      var off = s * 6;
      var raw = [
        (bytes[off] << 8) | bytes[off + 1],
        (bytes[off + 2] << 8) | bytes[off + 3],
        (bytes[off + 4] << 8) | bytes[off + 5]
      ];
      var v = raw.map(function (v16) {
        if (v16 & 0x8000) v16 -= 0x10000;
        return v16 >> 4; // 12bit 左对齐 -> 右移还原
      });
      samples.push({
        x: v[0], y: v[1], z: v[2],
        gx: v[0] / 2048 * 8,
        gy: v[1] / 2048 * 8,
        gz: v[2] / 2048 * 8,
        t: t0 + s * (1000 / sampleRate)
      });
    }
    return samples;
  }

  function AC_recValAny(rec, tag) {
    if (rec === null || rec === undefined) return undefined;
    if (rec['val_' + tag] !== undefined) return rec['val_' + tag];
    return rec[String(tag)];
  }

  function decodeGsensorAt(rec, tag) { return decodeGsensor(rec); }

  /**
   * 状态解算：输入 1293 记录数组（按时间升序），输出：
   * { samples, steps, cadence, attitude:{roll,pitch,yaw}, static, fall }
   */
  function analyze(records, opts) {
    opts = opts || {};
    var all = [];
    var baseTs = 0;
    (records || []).forEach(function (r) {
      var samps = decodeGsensor(r, opts.sampleRate || 20);
      if (samps && samps.length) all = all.concat(samps);
    });
    if (!all.length) {
      return { samples: [], steps: 0, cadence: 0, attitude: null, isStatic: false, fall: null };
    }
    // 转成算法输入 {x,y,z,t}（用 g 值）
    var gs = all.map(function (s) { return { x: s.gx, y: s.gy, z: s.gz, t: s.t }; });
    var filtered = Algo.filterGsensor(gs, { mode: 'lowpass', sampleRate: opts.sampleRate || 20, cutoffHz: 2.5 });
    var stepsR = Algo.countSteps(filtered, { sampleRate: opts.sampleRate || 20 });
    var pos = filtered[filtered.length - 1] || gs[gs.length - 1] || null;
    var attitude = pos ? Algo.estimateAttitude(pos) : null;
    var stat = Algo.isStatic(filtered, { tol: opts.staticTol !== undefined ? opts.staticTol : 0.08 });
    var fall = Algo.detectFall(filtered, { sampleRate: opts.sampleRate || 20 });
    return {
      samples: gs,
      steps: stepsR.steps,
      cadence: stepsR.cadence,
      attitude: attitude,
      isStatic: stat.static,
      fall: fall
    };
  }

  var PetStatus = {
    decodeGsensor: decodeGsensor,
    analyze: analyze
  };

  global.PetStatus = PetStatus;
})(window);