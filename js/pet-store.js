/**
 * pet-store.js —— 设备档案本地存储 + 云端名称同步
 * 挂载：window.PetStore
 * 规则：设备首次出现自动建档（"未命名设备"卡，避免换电脑丢失）；
 * 删除自动设备进黑名单防重建；设备名云同步 common/put（cls=10, uni_key=IMEI, s1=名称）；
 * 云端为权威覆盖本地档案名；删除设备同步 common/delete_by_id。
 */
(function (global) {
  'use strict';
  var U = global.Utils;
  var CFG = global.CFG;

  function allProfiles() {
    return U.store.get(CFG.KEY_PROFILES) || {};
  }
  function saveProfiles(map) {
    U.store.set(CFG.KEY_PROFILES, map);
  }
  function hiddenList() {
    var h = U.store.get(CFG.KEY_HIDDEN_DEVICES);
    return Array.isArray(h) ? h : [];
  }
  function saveHidden(arr) {
    U.store.set(CFG.KEY_HIDDEN_DEVICES, arr);
  }

  /**
   * 获取设备档案（无则自动建档"未命名设备"）
   */
  function getOrCreate(imei, opts) {
    opts = opts || {};
    var map = allProfiles();
    if (!map[imei]) {
      map[imei] = {
        imei: imei,
        name: opts.name || CFG.DEV_PLACEHOLDER_NAME,
        auto: true,          // 自动建档标记
        updated: Date.now()
      };
      saveProfiles(map);
    }
    return map[imei];
  }

  function get(imei) {
    var map = allProfiles();
    return map[imei] || null;
  }

  /**
   * 保存（编辑/新建/换绑）：本地保存 + 尝试云端上传（pending 保护）
   * 返回 {ok:boolean, pending:boolean}
   */
  function save(profile) {
    if (!profile || !profile.imei) return { ok: false, pending: false };
    var imei = profile.imei;
    var map = allProfiles();
    var prev = map[imei] || {};
    var merged = U.extend({}, prev);
    merged = U.extend(merged, profile);
    merged.imei = imei;
    merged.auto = false;   // 用户编辑后不再是自动卡
    merged.name = merged.name || CFG.DEV_PLACEHOLDER_NAME;
    merged.updated = Date.now();
    // 待传保护：仅当本地名与云端名不同（或从未成功上传）才 pending
    if (prev.cloudName && prev.cloudName === merged.name) {
      merged.pending = false;
    } else {
      merged.pending = true;
    }
    map[imei] = merged;
    saveProfiles(map);

    if (typeof global.AC !== 'undefined' && global.AC && global.AC.commonPut) {
      global.AC.commonPut(CFG.DEVNAME_CLS, { uni_key: imei, s1: merged.name })
        .then(function () {
          var m2 = allProfiles();
          if (m2[imei]) {
            m2[imei].cloudName = merged.name;
            m2[imei].pending = false;
            saveProfiles(m2);
          }
        }, function () {
          // 上传失败仅提示，云端旧名不得回盖本地新名
          U.toast('名称同步失败，稍后重试', 'err');
        });
    }
    return { ok: true, pending: merged.pending };
  }

  /**
   * 删除设备：本地删除 + 黑名单（自动卡）+ 云端删名称记录（静默成功）
   */
  function remove(imei) {
    var map = allProfiles();
    var rec = map[imei];
    if (rec && rec.auto) {
      var h = hiddenList();
      if (h.indexOf(imei) < 0) { h.push(imei); saveHidden(h); }
    }
    delete map[imei];
    saveProfiles(map);
    if (typeof global.AC !== 'undefined' && global.AC && global.AC.commonDeleteById) {
      global.AC.commonDeleteById(CFG.DEVNAME_CLS, rec && rec.id ? rec.id : null, imei)['catch'](function () { /* 静默 */ });
    }
  }

  function isHidden(imei) {
    return hiddenList().indexOf(imei) >= 0;
  }

  function nameOf(imei) {
    var p = get(imei);
    return p && p.name ? p.name : CFG.DEV_PLACEHOLDER_NAME;
  }

  /**
   * 进入首页/设备页时拉云端全量名称，以云端为权威覆盖绑定档案
   */
  function syncCloudNames() {
    if (typeof global.AC === 'undefined' || !global.AC || !global.AC.commonList) {
      return Promise.resolve(false);
    }
    return global.AC.commonList(CFG.DEVNAME_CLS)
      .then(function (value) {
        var records = (value && value.records) || [];
        if (!records.length) return false;
        var map = allProfiles();
        var changed = false;
        records.forEach(function (r) {
          var imei = r.uni_key;
          if (!imei || !r.s1) return;
          if (!map[imei]) {
            map[imei] = { imei: imei, name: r.s1, cloudName: r.s1, auto: true, updated: Date.now() };
            changed = true;
          } else if (map[imei].name !== r.s1 && !map[imei].pending) {
            map[imei].name = r.s1;
            map[imei].cloudName = r.s1;
            changed = true;
          } else if (map[imei].pending) {
            // 本地有未同步新名：不改名，但记录云端名
            map[imei].cloudName = r.s1;
            changed = true;
          }
        });
        if (changed) saveProfiles(map);
        return changed;
      })
      .catch(function () { return false; });
  }

  function all() {
    return allProfiles();
  }

  var PetStore = {
    getOrCreate: getOrCreate,
    get: get,
    save: save,
    remove: remove,
    isHidden: isHidden,
    nameOf: nameOf,
    syncCloudNames: syncCloudNames,
    all: all
  };

  global.PetStore = PetStore;
})(window);