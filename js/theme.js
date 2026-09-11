/**
 * theme.js —— 主题（配色 + 明暗）配置
 * 挂载：window.Theme
 *
 * 设计要点：
 *  1) 配色只改 <html data-accent="...">，具体色值全部在 css/style.css 的
 *     [data-accent="*"] 预设块里 —— CSS 与 JS 不重复维护色板，
 *     JS 只保留「键 / 名称 / 代表色」用于渲染选择器。
 *  2) 两项偏好都写进 localStorage（裸字符串，方便 index.tpl.html 的
 *     防闪内联脚本直接读取，不必依赖 Utils 序列化格式）。
 *  3) 深色模式与所有阴影/光晕都由 RGB 通道令牌推导，所以换配色时
 *     深色模式会自动跟着变，不需要额外维护第二套色板。
 */
(function (global) {
  'use strict';
  var U = global.Utils;
  var CFG = global.CFG;

  /** 配色预设：key 必须与 css/style.css 里的 [data-accent="key"] 一一对应 */
  var PRESETS = [
    { key: 'teal',    name: '合宙青',   swatch: '#0D9488' },
    { key: 'indigo',  name: '极光靛蓝', swatch: '#4F46E5' },
    { key: 'ocean',   name: '深海蓝',   swatch: '#2563EB' },
    { key: 'violet',  name: '星云紫',   swatch: '#7C3AED' },
    { key: 'emerald', name: '森野绿',   swatch: '#059669' },
    { key: 'amber',   name: '暖阳橙',   swatch: '#D97706' },
    { key: 'rose',    name: '珊瑚玫',   swatch: '#E11D48' },
    { key: 'slate',   name: '石墨灰',   swatch: '#475569' }
  ];
  // 默认配色：合宙青。css/style.css 的 :root 基础令牌也是这套值，
  // 保证「清空存储首次打开」时 JS paint 前后看到的都是合宙青，不闪色。
  var DEFAULT_ACCENT = 'teal';
  var MODES = [
    { key: 'light', name: '浅色' },
    { key: 'dark',  name: '深色' }
  ];
  var DEFAULT_MODE = 'light';

  function hasPreset(key) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].key === key) return true;
    }
    return false;
  }

  function accent() {
    var k = U.store.getRaw(CFG.KEY_ACCENT);
    return hasPreset(k) ? k : DEFAULT_ACCENT;
  }

  function mode() {
    var m = U.store.getRaw(CFG.KEY_THEME_MODE);
    return (m === 'dark' || m === 'light') ? m : DEFAULT_MODE;
  }

  function presetOf(key) {
    for (var i = 0; i < PRESETS.length; i++) {
      if (PRESETS[i].key === key) return PRESETS[i];
    }
    return PRESETS[0];
  }

  /** 把 theme-color 同步成当前背景色（移动端状态栏/地址栏跟着变） */
  function syncMetaColor() {
    var meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    var bg = cssVar('--bg', '');
    if (bg) meta.setAttribute('content', bg);
  }

  /**
   * APP 原生外壳（侧边栏头部渐变、加载进度条、菜单按下底）画在 WebView 之外，
   * 拿不到 CSS 变量，只能把配色键显式告诉原生。
   * 桥不存在时静默跳过（普通浏览器 / 桌面端 / 登录页）。重复调用是幂等的。
   */
  function syncNativeAccent(key) {
    try {
      var ab = global.AndroidBridge;
      if (ab && typeof ab.setAccent === 'function') ab.setAccent(key);
    } catch (e) { /* 桥调用失败不影响网页端主题 */ }
  }

  function paint() {
    var root = document.documentElement;
    root.setAttribute('data-accent', accent());
    root.setAttribute('data-theme', mode());
    syncMetaColor();
    syncNativeAccent(accent());
    syncPop();
    // 通知需要「就地换色」的模块（地图图层画在 DOM 之外，拿不到 var() 自动跟随）
    try {
      if (typeof global.CustomEvent === 'function' && document.dispatchEvent) {
        document.dispatchEvent(new global.CustomEvent('themechange', {
          detail: { accent: accent(), mode: mode() }
        }));
      }
    } catch (e) { /* ignore */ }
  }

  function setAccent(key) {
    if (!hasPreset(key)) key = DEFAULT_ACCENT;
    U.store.set(CFG.KEY_ACCENT, key);
    paint();
    return key;
  }

  function setMode(m) {
    if (m !== 'dark' && m !== 'light') m = DEFAULT_MODE;
    U.store.set(CFG.KEY_THEME_MODE, m);
    paint();
    return m;
  }

  function toggleMode() {
    return setMode(mode() === 'dark' ? 'light' : 'dark');
  }

  /**
   * 读取 CSS 变量当前计算值。地图标记 / 轨迹线 / Canvas 图表画在 DOM 之外，
   * 拿不到 var()，必须显式取色 —— 否则会「UI 换了主题、地图还是旧蓝」。
   */
  function cssVar(name, fallback) {
    try {
      var v = global.getComputedStyle(document.documentElement).getPropertyValue(name);
      v = (v || '').trim();
      return v || (fallback || '');
    } catch (e) {
      return fallback || '';
    }
  }

  /* ---------------- 选择器浮层 ---------------- */

  function popoverHtml() {
    var cur = accent(), curMode = mode();
    var segs = MODES.map(function (m) {
      return '<button type="button" data-mode="' + m.key + '"' +
        (m.key === curMode ? ' class="on"' : '') + '>' + U.esc(m.name) + '</button>';
    }).join('');
    var sws = PRESETS.map(function (p) {
      return '<button type="button" class="tp-item' + (p.key === cur ? ' on' : '') + '"' +
        ' data-accent-key="' + p.key + '" title="' + U.esc(p.name) + '" aria-label="' + U.esc(p.name) + '">' +
        '<span class="tp-sw" style="background:' + p.swatch + '"><span class="tp-tick">✓</span></span>' +
        '<span class="tp-name">' + U.esc(p.name) + '</span>' +
        '</button>';
    }).join('');
    return '<div class="tp-head"><b>🎨 外观主题</b>' +
      '<button type="button" class="tp-close" aria-label="关闭">✕</button></div>' +
      '<p class="tp-label">配色</p>' +
      '<div class="tp-grid">' + sws + '</div>' +
      '<p class="tp-label" style="margin-top:14px">明暗</p>' +
      '<div class="tp-seg">' + segs + '</div>';
  }

  var popEl = null;

  function isOpen() {
    return !!(popEl && popEl.classList.contains('open'));
  }

  /**
   * 只同步选中态，**不重建 DOM**。
   * 踩过的坑：一开始每次点色块都 renderPop() 重建 innerHTML，被点的那个节点
   * 会立刻从文档里摘掉；事件继续冒泡到 document 时，祖先链已断，
   * 「点外面就关闭」的判定误以为点的是外面 → 浮层自己关掉。
   * 真机表现就是「点一次配色就关，想连试几个色都不行」。
   */
  function syncPop() {
    if (!popEl) return;
    var cur = accent(), curMode = mode();
    Array.prototype.forEach.call(popEl.querySelectorAll('[data-accent-key]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-accent-key') === cur);
    });
    Array.prototype.forEach.call(popEl.querySelectorAll('[data-mode]'), function (b) {
      b.classList.toggle('on', b.getAttribute('data-mode') === curMode);
    });
  }

  function buildPop() {
    popEl.innerHTML = popoverHtml();
    // 配色
    Array.prototype.forEach.call(popEl.querySelectorAll('[data-accent-key]'), function (b) {
      b.addEventListener('click', function () {
        setAccent(b.getAttribute('data-accent-key'));   // setAccent → paint → syncPop
      });
    });
    // 明暗
    Array.prototype.forEach.call(popEl.querySelectorAll('[data-mode]'), function (b) {
      b.addEventListener('click', function () {
        setMode(b.getAttribute('data-mode'));
      });
    });
    var x = popEl.querySelector('.tp-close');
    if (x) x.addEventListener('click', function () { closePop(); });
  }

  function openPop() {
    if (!popEl) return;
    if (!popEl.firstChild) buildPop();
    syncPop();
    popEl.classList.add('open');
  }

  function closePop() {
    if (popEl) popEl.classList.remove('open');
  }

  /** 判断某个 DOM 节点是否属于「浮层或入口按钮」 */
  function isInside(node) {
    if (!node) return false;
    if (node === popEl) return true;
    return !!(node.classList && node.classList.contains('theme-btn'));
  }

  /**
   * 挂到顶栏按钮上。浮层挂在 body 上（不放进 .topbar），
   * 避免被顶栏的层叠上下文/overflow 裁掉。
   */
  function mount(btn) {
    if (!popEl) {
      popEl = document.createElement('div');
      popEl.id = 'theme-pop';
      popEl.className = 'theme-pop';
      document.body.appendChild(popEl);
      buildPop();
    }
    if (btn && !btn.__themeBound) {
      btn.__themeBound = true;
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (isOpen()) closePop();
        else openPop();
      });
    }
    if (!document.__themeOutsideBound) {
      document.__themeOutsideBound = true;
      document.addEventListener('click', function (e) {
        if (!isOpen()) return;
        // 优先用事件派发时冻结的传播路径：即使处理过程中 DOM 被改动也不会误判
        var path = (typeof e.composedPath === 'function') ? e.composedPath() : null;
        if (path && path.length) {
          for (var i = 0; i < path.length; i++) {
            if (isInside(path[i])) return;
          }
        } else {
          var n = e.target;
          while (n && n !== document) {
            if (isInside(n)) return;
            n = n.parentNode;
          }
        }
        closePop();
      });
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape') closePop();
      });
      // 切页面时自动收起：否则浮层会悬在新页面上挡住内容
      // （比如从「实时地图」切到「报警」，会盖住推送开关）
      global.addEventListener('hashchange', function () { closePop(); });
    }
  }

  function init() {
    paint();
    return { accent: accent(), mode: mode() };
  }

  var Theme = {
    PRESETS: PRESETS,
    MODES: MODES,
    DEFAULT_ACCENT: DEFAULT_ACCENT,
    DEFAULT_MODE: DEFAULT_MODE,
    hasPreset: hasPreset,
    accent: accent,
    mode: mode,
    presetOf: presetOf,
    setAccent: setAccent,
    setMode: setMode,
    toggleMode: toggleMode,
    paint: paint,
    cssVar: cssVar,
    syncNativeAccent: syncNativeAccent,
    init: init,
    mount: mount,
    open: openPop,
    close: closePop,
    isOpen: isOpen
  };

  global.Theme = Theme;

  // 尽早落盘一次（此时 <style> 已在 head 中解析完），减少主题闪变
  try { paint(); } catch (e) { /* ignore */ }
})(window);
