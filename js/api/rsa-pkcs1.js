/**
 * api/rsa-pkcs1.js —— RSA PKCS1 签名薄封装（基于内联 JSEncrypt）
 * 挂载：window.RSAUtil
 */
(function (global) {
  'use strict';

  var RSAUtil = {
    /**
     * 用平台公钥加密明文（时间戳ms + "," + appId），输出 Base64
     */
    encryptWithKey: function (plain, publicKey) {
      if (typeof global.JSEncrypt === 'undefined') return null;
      try {
        var enc = new global.JSEncrypt();
        enc.setPublicKey(publicKey);
        return enc.encrypt(plain);
      } catch (e) {
        return null;
      }
    },
    /**
     * 生成 X-Key-Open-Api 值
     */
    buildXKey: function (appId) {
      return RSAUtil.encryptWithKey(Date.now() + ',' + appId, RSAUtil.getPublicKey());
    },
    getPublicKey: function () {
      var raw = null;
      try { raw = global.localStorage.getItem('my_sets'); } catch (e) { /* ignore */ }
      if (!raw) return null;
      try {
        var s = JSON.parse(raw);
        return (s && s.publicKey) || null;
      } catch (e) { return null; }
    }
  };

  global.RSAUtil = RSAUtil;
})(window);
