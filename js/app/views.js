/**
 * app/views.js —— 视图层：外壳 + #/home 实时地图 + #/pets 我的设备 + #/devices 设备管理
 * 挂载：window.Views
 * 渲染约定：动态数据一律 esc()；页面级清理（定时器/图层）由 main.js 在路由切换时调用。
 */
(function (global) {
  'use strict';
  var U = global.Utils;
  var CFG = global.CFG;
  var AC = global.AC;
  var MapKit = global.MapKit;
  var PetStore = global.PetStore;
  var FenceStore = global.FenceStore;

  var state = {
    projectKey: '',
    projects: [],
    devices: [],       // [{deviceid}]
    statuses: {},      // imei -> status
    statusCache: {},   // imei -> { st, t } 设备状态缓存（切 tab 复用，避免闪烁/重复请求）
    devicesCache: { list: null, t: 0 }, // 设备列表缓存
    timers: [],        // 本页定时器
    view: ''
  };

  /* 设备卡片 DOM 复用表：imei -> 节点。
     卡片带 backdrop-filter 毛玻璃，整表 innerHTML 重建 = 合成层被反复销毁重建，
     移动端就是肉眼可见的闪烁；这里跨轮次复用同一批节点，只改变化的文字/徽标。 */
  var cardNodes = {};
  /** 合并重绘句柄：一轮轮询会回调 7 次（N 台设备 + 缓存快照 + 收尾），只允许重绘 1 次 */
  var cardsScheduled = null;

  function clearTimers() {
    state.timers.forEach(function (t) { clearInterval(t); clearTimeout(t); });
    state.timers = [];
    if (cardsScheduled) { clearTimeout(cardsScheduled); cardsScheduled = null; }
    cardNodes = {};            // 页面 DOM 已销毁，节点引用一并丢弃
  }

  function later(fn, ms) {
    var t = setTimeout(fn, ms);
    state.timers.push(t);
    return t;
  }
  function every(fn, ms) {
    var t = setInterval(fn, ms);
    state.timers.push(t);
    return t;
  }

  /* ================= 外壳 ================= */

  var SHELL_HTML =
    '<header class="topbar">' +
    '  <div class="brand">' +
    '    <span class="brand-logo" role="img" aria-label="合宙IoT-运动传感器"></span>' +
    '    <span class="brand-text"><b>合宙IoT-运动传感器</b><span>PetTrack · AirCloud</span></span>' +
    '  </div>' +
    '  <div class="top-actions">' +
    '    <select id="project-select" class="proj-select" title="切换项目"></select>' +
    '    <button id="btn-theme" class="theme-btn" type="button" title="外观主题" aria-label="外观主题"><i class="tb-dot"></i></button>' +
    '    <span id="user-chip" class="user-chip"></span>' +
    '    <button id="btn-logout" class="btn-ghost">退出</button>' +
    '  </div>' +
    '</header>' +
    '<nav class="nav-pc">' +
    '  <a href="#/home" data-route="home">📍 实时地图</a>' +
    '  <a href="#/pets" data-route="pets">🐾 我的设备</a>' +
    '  <a href="#/report" data-route="report">📅 日报</a>' +
    '  <a href="#/status" data-route="status">📊 设备状态</a>' +
    '  <a href="#/track" data-route="track">🛤 轨迹回放</a>' +
    '  <a href="#/fence" data-route="fence">⭕ 电子围栏</a>' +
    '  <a href="#/alerts" data-route="alerts">🚨 报警</a>' +
    '  <a href="#/devices" data-route="devices">🖥 设备管理</a>' +
    '  <a href="#/debug" data-route="debug">🔧 性能监控</a>' +
    '</nav>' +
    '<main id="view-root"></main>' +
    '<nav class="nav-mobile">' +
    '  <a href="#/home" data-route="home"><span class="nm-ic">📍</span><span>地图</span></a>' +
    '  <a href="#/pets" data-route="pets"><span class="nm-ic">🐾</span><span>设备</span></a>' +
    '  <a href="#/report" data-route="report"><span class="nm-ic">📅</span><span>日报</span></a>' +
    '  <a href="#/track" data-route="track"><span class="nm-ic">🛤</span><span>轨迹</span></a>' +
    '  <a href="#/fence" data-route="fence"><span class="nm-ic">⭕</span><span>围栏</span></a>' +
    '</nav>';

  function buildShell(container) {
    container.innerHTML = SHELL_HTML;
    // 顶栏项目下拉
    var sel = document.getElementById('project-select');
    if (sel) {
      sel.addEventListener('change', function () {
        if (sel.value) {
          AC.setProjectKey(sel.value);
          state.projectKey = sel.value;
          // 换项目必须清空设备/状态缓存，否则会继续渲染上一个项目的设备
          state.devices = [];
          state.statuses = {};
          state.statusCache = {};
          state.devicesCache = { list: null, t: 0 };
          if (state.view === 'home') render('home', { force: true });
          else if (state.view === 'pets') render('pets', { force: true });
          else if (state.view === 'devices') render('devices', { force: true });
          else if (state.view === 'track') render('track');
          else if (state.view === 'status') render('status');
          else if (state.view === 'debug') render('debug');
          else if (state.view === 'report') render('report');
        }
      });
    }
    var lo = document.getElementById('btn-logout');
    if (lo) {
      lo.addEventListener('click', function () {
        AC.clearLoginStorage();
        AC.redirectToLogin('/' + CFG.APP_PAGE);
      });
    }
    // 外观主题入口（配色 + 明暗）。浮层挂 body，见 theme.js mount()
    if (global.Theme && global.Theme.mount) {
      global.Theme.mount(document.getElementById('btn-theme'));
    }
    var ctx = AC.getAuthContextAny();
    var chip = document.getElementById('user-chip');
    if (chip && ctx && ctx.profile) {
      var name = ctx.profile.name || U.maskPhone(ctx.profile.mobile || '');
      chip.textContent = name ? ('👤 ' + name) : '';
    }
    activeNav(state.view);
  }

  function activeNav(view) {
    U.$all('[data-route]').forEach(function (a) {
      a.classList.toggle('active', a.getAttribute('data-route') === view);
    });
    updateAlertDot();
  }

  /**
   * 报警 Tab 呼吸灯红点：存在围栏报警记录时，给「报警」入口加红色呼吸闪烁
   */
  function updateAlertDot() {
    var n = FenceStore.unhandledCount();
    U.$all('[data-route="alerts"]').forEach(function (a) {
      a.classList.toggle('has-alert', n > 0);
      var dot = a.querySelector('.alert-count');
      if (n > 0) {
        if (!dot) {
          dot = document.createElement('span');
          dot.className = 'alert-count';
          a.appendChild(dot);
        }
        dot.textContent = n > 99 ? '99+' : String(n);
      } else if (dot) {
        dot.parentNode.removeChild(dot);
      }
    });
  }

  function showLoading(msg) {
    var el = document.getElementById('app-loading');
    if (el) {
      el.classList.remove('hidden');
      if (msg) el.querySelector('.ld-text').textContent = msg;
    }
  }
  function hideLoading() {
    var el = document.getElementById('app-loading');
    if (el) el.classList.add('hidden');
  }

  /* ================= 公共：设备/状态获取 ================= */

  function ensureProject() {
    return new Promise(function (resolve) {
      if (state.projectKey) { resolve(state.projectKey); return; }
      AC.listMyProjects().then(function (res) {
        if (res.code !== 0) { resolve(null); return; }
        var list = res.value || [];
        state.projects = list;
        var saved = AC.getProjectKey();
        var chosen = null;
        for (var i = 0; i < list.length; i++) {
          if (list[i].project_key === saved) { chosen = list[i]; break; }
        }
        if (!chosen && list.length) chosen = list[0]; // 默认第一个，禁止虚构
        state.projectKey = chosen ? chosen.project_key : '';
        if (chosen) AC.setProjectKey(chosen.project_key);
        resolve(state.projectKey);
      });
    });
  }

  function fillProjectSelect() {
    var sel = document.getElementById('project-select');
    if (!sel) return;
    var list = state.projects;
    sel.innerHTML = list.map(function (p) {
      var key = p.project_key;
      return '<option value="' + U.esc(key) + '"' + (key === state.projectKey ? ' selected' : '') + '>' + U.esc(p.name || key) + '</option>';
    }).join('');
    sel.style.display = list.length > 1 ? '' : 'none';
  }

  function loadDevices(force) {
    // 设备列表缓存：切 tab 复用，TTL 内不重复请求（force 强制刷新）
    if (!force && state.devicesCache.list && (Date.now() - state.devicesCache.t < CFG.DEVICES_TTL_MS)) {
      state.devices = state.devicesCache.list;
      return Promise.resolve(state.devices);
    }
    return ensureProject().then(function (key) {
      if (!key) return [];
      return AC.searchMyDevices(key, '', 1, CFG.LIST_MAX_SIZE).then(function (res) {
        if (res.code !== 0) return [];
        var records = (res.value && res.value.records) || [];
        state.devicesCache = { list: records, t: Date.now() };
        state.devices = records;
        return records;
      });
    });
  }

  /**
   * 并发获取全部设备状态（流式渲染 + 状态缓存）
   * - 先用缓存快照 onAll(out) 立即渲染（切 tab 不闪烁、不空白）
   * - 仅过期/无缓存设备才请求；force=true 时全部刷新（页面内轮询用）
   * - onOne(imei, status) 单台完成；onAll(out) 缓存快照与全部完成各回调一次
   */
  function fetchAllStatuses(devices, onOne, onAll, force) {
    var imeis = (devices || []).map(function (d) { return d.deviceid; }).filter(Boolean);
    var now = Date.now();
    var out = {};
    var toFetch = [];
    imeis.forEach(function (imei) {
      var c = state.statusCache[imei];
      var fresh = !force && c && (now - c.t < CFG.STATUS_TTL_MS);
      if (!c) {
        // 内存缓存没有 → 用持久化定位缓存兜底：进页面先把上次的定位画出来，
        // 不用干等新一轮轮询（新数据回来后 t=Date.now() 的内存缓存会覆盖它）
        var persisted = LocCache ? LocCache.get(imei) : null;
        if (persisted) {
          persisted.name = PetStore.nameOf(imei);   // 改名后缓存里的旧名要跟着换
          persisted._cached = true;
          c = state.statusCache[imei] = { st: persisted, t: 0 };  // t=0 视为过期，仍会拉新
        }
      }
      if (c) out[imei] = c.st;      // 有缓存先占位（新鲜 or 过期都用，避免闪烁）
      if (!fresh) toFetch.push(imei);
    });
    // 先渲染缓存快照（消除「有数据→无数据」跳变）
    if (onAll) onAll(out);
    if (!toFetch.length) return;
    /**
     * 本轮没拿到定位时，沿用上一轮的有效数据；连上一轮都没有才返回 null（真·无定位）。
     * 注意不要覆盖缓存、也不动 t —— 这样下一轮还会重试这台设备。
     */
    function keepPrevious(imei, name) {
      var prev = state.statusCache[imei] && state.statusCache[imei].st;
      if (!prev || !(prev.found || prev.lng !== undefined)) return null;
      if (name) prev.name = name;
      return prev;
    }

    var remain = toFetch.length;
    toFetch.forEach(function (imei) {
      AC.getPetStatus(imei).then(function (st) {
        var p = PetStore.getOrCreate(imei);
        st.name = p.name;
        // ⚠ 本轮没定位 ≠ 设备没有位置。
        // getPetStatus 在定位请求失败（code!==0）时**不会 reject** —— AC.request 永不
        // reject，异常统一 resolve 成 code:-102，于是这里拿到的是 found:false。
        // 若直接把它当「无定位」写进缓存，设备列表就会在「有数据 ↔ 无数据」之间反复
        // 横跳（实测 30% 失败率下 24 秒跳 6 次），这正是周总看到的闪烁。
        // 只要上一轮有有效数据就沿用；设备真的失联会由 ts 老化成「离线」徽标。
        if (!st.found) {
          var prev = keepPrevious(imei, st.name);
          if (prev) { out[imei] = prev; onOne && onOne(imei, prev); return; }
        }
        out[imei] = st;
        state.statusCache[imei] = { st: st, t: Date.now() };
        // 新定位落持久化缓存：下次进页面秒显
        if (LocCache) LocCache.put(st);
        onOne && onOne(imei, st);
      })['catch'](function () {
        // 抛异常这条路同样不能打回「无定位」（AC.request 永不 reject，此处仅兜底）
        var prev = keepPrevious(imei, PetStore.nameOf(imei));
        if (prev) {
          out[imei] = prev;
        } else {
          out[imei] = { imei: imei, found: false, name: PetStore.nameOf(imei) };
          state.statusCache[imei] = { st: out[imei], t: Date.now() };
        }
        onOne && onOne(imei, out[imei]);
      })['then'](function () {
        remain--;
        if (remain <= 0) onAll && onAll(out);
      });
    });
  }

  /* ================= #/home 实时地图 ================= */

  function renderHome(opts) {
    state.view = 'home';
    activeNav('home');
    var root = document.getElementById('view-root');
    root.innerHTML =
      '<div class="home-wrap">' +
      '  <div id="home-map" class="map-full"></div>' +
      '  <aside id="home-cards" class="home-cards"></aside>' +
      '  <div id="turbo-bar" class="turbo-bar hidden"><span>🚀 实时追踪中</span><button id="btn-turbo-stop" class="btn-ghost">退出追踪</button></div>' +
      '</div>';
    clearTimers();

    ensureProject().then(function (key) {
      if (!key) { root.innerHTML = '<div class="empty">暂无项目，请确认账号内有设备项目</div>'; return; }
      fillProjectSelect();
      MapKit.create('home-map', { center: [30.65, 104.06], zoom: 5 });
      loadDevices().then(function (devices) {
        if (!devices.length) {
          document.getElementById('home-cards').innerHTML = '<div class="empty-card">暂无设备</div>';
          return;
        }
        // 单台设备的回调不单独重绘列表：一轮 N 台设备就回调 N 次，
        // 每次都重画一遍是「频繁闪烁」的另一半原因。这里合并成一次重绘。
        function scheduleCardsPaint() {
          if (cardsScheduled) return;
          cardsScheduled = setTimeout(function () {
            cardsScheduled = null;
            renderHomeCards(devices, state.statuses);
          }, 100);
        }
        function refresh(force) {
          fetchAllStatuses(devices,
            function (imei, st) {           // 单台完成：先更地图，列表合并重绘
              state.statuses[imei] = st;
              scheduleCardsPaint();
              MapKit.upsertMarker(st);
            },
            function (statuses) {           // 缓存快照 / 全部完成
              state.statuses = statuses;
              renderHomeCards(devices, statuses);
              // 缓存快照也上地图：进页面先看到上次的定位点，不等新数据
              for (var k in statuses) MapKit.upsertMarker(statuses[k]);
              MapKit.refreshOpenPopups();
            },
            force);
        }
        refresh(false);
        every(function () { refresh(true); }, CFG.POLL_STATUS_MS);
      });
    });
    bindTurboStop();
  }

  /**
   * 低电量判定：vbat 有值且 < 3400mV
   */
  function isLowBattery(st) {
    return !!(st && st.vbat !== undefined && st.vbat !== null && Number(st.vbat) > 0 && Number(st.vbat) < CFG.VBAT_LOW_MV);
  }

  /** 只在文字真变了才写 DOM，避免无谓的样式重算 */
  function setText(node, s) {
    if (!node) return;
    s = (s === undefined || s === null) ? '' : String(s);
    if (node.textContent !== s) node.textContent = s;
  }

  /** 单张设备卡片的骨架：节点只创建一次，之后只改文字/徽标（绝不整表重建） */
  function makeCard(imei) {
    var el = document.createElement('div');
    el.className = 'pet-card';
    el.setAttribute('data-imei', imei);
    el.setAttribute('data-zoom', '15');
    el.innerHTML =
      '<div class="pc-head"><b></b><span class="pc-badges"></span></div>' +
      '<div class="pc-sub"></div>' +
      '<div class="pc-row">📍 <span class="v-loc"></span></div>' +
      '<div class="pc-row pc-addr">🏷 <span class="v-addr"></span></div>' +
      '<div class="pc-foot"><span class="v-foot"></span></div>';
    el._v = {
      name: el.querySelector('.pc-head b'),
      badges: el.querySelector('.pc-badges'),
      sub: el.querySelector('.pc-sub'),
      loc: el.querySelector('.v-loc'),
      addr: el.querySelector('.v-addr'),
      foot: el.querySelector('.v-foot')
    };
    // hover 15 级 / click 18 级锁定（拉开差距，点击才「看得见」放大）
    // 事件只绑一次：原来是每轮整表重建都重绑一遍，既浪费又打断 hover 状态
    el.addEventListener('mouseenter', function () { MapKit.focusOn(imei, 15); });
    el.addEventListener('click', function () {
      if (!MapKit.canFocus(imei)) {
        U.toast('「' + PetStore.nameOf(imei) + '」暂无定位，无法在地图上定位', 'err');
        return;
      }
      MapKit.setLocked(imei);
      MapKit.focusOn(imei, 18);
      for (var k in cardNodes) cardNodes[k].classList.remove('locked');
      el.classList.add('locked');
    });
    return el;
  }

  /** 把一份状态画到已存在的卡片节点上（只改真正变化的部分） */
  function paintCard(el, st) {
    var v = el._v;
    var low = isLowBattery(st);
    var offline = st.ts ? (Date.now() - st.ts > 5 * 60 * 1000) : !st.found;
    var badge = st._pending ? '<span class="badge bad-load">加载中</span>'
      : (st.found
        ? (offline ? '<span class="badge bad-off">离线</span>' : '<span class="badge bad-on">在线</span>')
        : '<span class="badge bad-off">无定位</span>');
    // 来自持久化缓存的占位数据：明确标注「缓存」，新数据到达后该标记自然消失
    var cachedBadge = st._cached ? '<span class="badge bad-load">缓存</span>' : '';
    var lowBadge = low ? '<span class="badge bad-low">低电量</span>' : '';
    var badges = cachedBadge + lowBadge + badge;
    // 徽标只在内容真变了才重写：.bad-on::before 的呼吸动画会因 innerHTML 重写而从 0 帧重启
    if (el._badgeSig !== badges) {
      el._badgeSig = badges;
      v.badges.innerHTML = badges;
    }
    setText(v.name, st.name);
    setText(v.sub, st.imei);
    setText(v.loc, (!st._pending && st.lng !== undefined)
      ? (Number(st.lng).toFixed(5) + ', ' + Number(st.lat).toFixed(5)) : '--');
    setText(v.addr, st.address ? st.address : '无地址信息');
    var bat = (st.vbatPct !== undefined && st.vbatPct !== null) ? st.vbatPct + '%' : '--';
    var sig = (st.signal !== undefined && st.signal !== null) ? (st.signal + ' ' + U.signalText(st.signal)) : '--';
    var upTime = st.ts ? U.timeAgo(st.ts) : '--';
    setText(v.foot, '🔋 ' + bat + (low ? ('（' + Number(st.vbat) + 'mV）') : '')
      + ' · 📶 ' + sig + ' · 🕒 ' + upTime);
    el.classList.toggle('pc-low', low);
  }

  /**
   * 渲染设备卡片列表 —— **按键增量更新**，绝不给列表容器整体赋 innerHTML。
   * 原因：卡片是毛玻璃（backdrop-filter），整表重建会让浏览器反复销毁/重建合成层，
   * 移动端就是肉眼可见的闪烁；而一轮轮询要回调 7 次（N 台设备 + 缓存快照 + 收尾），
   * 重建 7 次/10 秒足够看清。
   */
  function renderHomeCards(devices, statuses) {
    var box = document.getElementById('home-cards');
    if (!box) return;
    var seen = {};
    devices.forEach(function (d, i) {
      var imei = d.deviceid;
      if (!imei || seen[imei]) return;
      seen[imei] = 1;
      var el = cardNodes[imei];
      if (!el) el = cardNodes[imei] = makeCard(imei);
      // statuses 里还没这台设备 = 首轮请求尚未回来，显示「加载中」而不是「无定位」
      var st = statuses[imei];
      if (!st) st = { imei: imei, name: PetStore.nameOf(imei), found: false, _pending: true };
      if (!st.name) st.name = PetStore.nameOf(imei);
      paintCard(el, st);
      // 锁定态跨轮次保持，否则点击后的高亮会被下一次刷新抹掉
      el.classList.toggle('locked', MapKit.locked() === imei);
      // 只有位置不对才移动节点（移动已有节点不会重建它）
      if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    });
    // 清掉已不在列表里的卡片（换项目 / 删设备）
    Object.keys(cardNodes).forEach(function (imei) {
      if (seen[imei]) return;
      var el = cardNodes[imei];
      if (el && el.parentNode) el.parentNode.removeChild(el);
      delete cardNodes[imei];
    });
  }

  /* ================= 实时追踪 ================= */

  function startTurboFromMap(imei) {
    var st = state.statuses[imei];
    if (!st || (st.ts && Date.now() - st.ts > 5 * 60 * 1000)) {
      U.toast('该设备超 5 分钟未上报，无法追踪', 'err');
      return;
    }
    // 下发 fast_report 成功后进入
    AC.sendCmd(imei, 21, '{"cmd":"fast_report"}', 0).then(function (res) {
      if (res.code !== 0) {
        U.toast('指令下发失败：' + (typeof res.value === 'string' ? res.value : '请重试'), 'err');
        return;
      }
      var ok = MapKit.startTurbo(imei, function () {
        var s = state.statuses[imei];
        if (s) {
          MapKit.upsertMarker(s);
          MapKit.focusOn(imei, 18);
        }
      });
      if (ok) {
        var bar = document.getElementById('turbo-bar');
        if (bar) bar.classList.remove('hidden');
        U.toast('🚀 已进入实时追踪（60 秒）');
        later(function () {
          MapKit.stopTurbo();
          var b2 = document.getElementById('turbo-bar');
          if (b2) b2.classList.add('hidden');
          U.toast('实时追踪结束，已恢复普通视图');
        }, 60000);
      }
    });
  }

  function bindTurboStop() {
    // document 级委托（幂等）：turbo-bar 是动态 HTML，一次性绑定不可靠
    if (bindTurboStop._bound) return;
    bindTurboStop._bound = true;
    document.addEventListener('click', function (evt) {
      var t = evt.target;
      while (t && t !== document) {
        if (t.id === 'btn-turbo-stop' || (t.getAttribute && t.getAttribute('data-turbo-stop') !== null && t.hasAttribute('data-turbo-stop'))) {
          MapKit.stopTurbo();
          var bar = document.getElementById('turbo-bar');
          if (bar) bar.classList.add('hidden');
          U.toast('已退出实时追踪');
          return;
        }
        t = t.parentNode;
      }
    });
  }

  /* ================= #/pets 我的设备 ================= */

  function renderPets(opts) {
    state.view = 'pets';
    activeNav('pets');
    var root = document.getElementById('view-root');
    root.innerHTML = '<div class="page"><h2>🐾 我的设备</h2><div id="pet-grid" class="pet-grid"></div></div>';
    clearTimers();

    // 不再整页 Loading：先拉项目+设备列表（快），状态流式逐台补全
    PetStore.syncCloudNames()['catch'](function () { return null; }).then(function () {
      return ensureProject();
    }).then(function (key) {
      if (!key) { root.querySelector('.pet-grid').innerHTML = '<div class="empty">暂无项目</div>'; return; }
      fillProjectSelect();
      return loadDevices().then(function (devices) {
        if (!devices.length) {
          root.querySelector('.pet-grid').innerHTML = '<div class="empty">暂无设备，扫码绑定后自动出现</div>';
          return;
        }
        function refresh(force) {
          fetchAllStatuses(devices,
            function (imei, st) { renderPetGrid(devices, (state.statuses[imei] = st, state.statuses)); },
            function (statuses) { state.statuses = statuses; renderPetGrid(devices, statuses); },
            force);
        }
        refresh(false);
      });
    })['catch'](function () { /* ignore */ });
  }

  /**
   * IMEI 一键复制
   */
  function copyImei(imei) {
    function done(ok) { U.toast(ok ? '✅ IMEI 已复制' : '复制失败，请长按手动复制', ok ? '' : 'err'); }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(imei).then(function () { done(true); }, function () { fallbackCopy(imei, done); });
    } else {
      fallbackCopy(imei, done);
    }
  }
  function fallbackCopy(text, done) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      done(!!ok);
    } catch (e) { done(false); }
  }

  /**
   * 电池图标（颜色随电量档位：低红 / 中黄 / 高绿；填充宽度随百分比）
   */
  function batteryHtml(st) {
    var mv = st && st.vbat;
    var pct = st && st.vbatPct;
    var hasMv = mv !== undefined && mv !== null && Number(mv) > 0;
    var hasPct = pct !== undefined && pct !== null;
    if (!hasMv && !hasPct) return '<span class="bat bat-none"><i class="bat-ic"></i><b>--</b></span>';
    var tone = U.batteryTone(mv);
    var fill = hasPct ? Math.max(0, Math.min(100, pct)) : 0;
    var label = hasPct ? (pct + '%') : (Number(mv) + 'mV');
    var title = hasMv ? (Number(mv) + 'mV') : '';
    return '<span class="bat bat-' + tone + '"' + (title ? ' title="' + title + '"' : '') + '>' +
      '<i class="bat-ic"><i class="bat-fill" style="width:' + fill + '%"></i></i>' +
      '<b>' + U.esc(label) + '</b></span>';
  }

  function renderPetGrid(devices, statuses) {
    var grid = document.getElementById('pet-grid');
    if (!grid) return;
    var html = devices.map(function (d) {
      var imei = d.deviceid;
      if (PetStore.isHidden(imei)) return '';
      var st = statuses[imei] || { imei: imei, name: PetStore.nameOf(imei) };
      var name = st.name || PetStore.nameOf(imei);
      var hasData = !!statuses[imei];
      var offline = st.ts ? (Date.now() - st.ts > 5 * 60 * 1000) : !st.found;
      var badge = hasData ? (st.found ? (offline ? '<span class="badge bad-off">离线</span>' : '<span class="badge bad-on">在线</span>') : '<span class="badge bad-off">无定位</span>') : '<span class="badge bad-load">加载中…</span>';
      var last = st.ts ? U.timeAgo(st.ts) : '--';
      var sig = (st.signal !== undefined && st.signal !== null) ? (st.signal + ' ' + U.signalText(st.signal)) : '--';
      var sat = (st.sat !== undefined && st.sat !== null) ? (st.sat + ' 颗') : '--';
      var spd = (st.speedKmh !== undefined && st.speedKmh !== null) ? (st.speedKmh + ' km/h') : '--';
      var crs = (st.course !== undefined && st.course !== null) ? Math.round(st.course) + '°' : '--';
      var alt = (st.altitude !== undefined && st.altitude !== null) ? Math.round(st.altitude) + 'm' : '--';
      return '<div class="pcard" data-imei="' + U.esc(imei) + '">' +
        '<div class="pcard-head"><b>' + U.esc(name) + '</b>' + badge + '</div>' +
        '<div class="pcard-sub">' + U.esc(imei) + '<button class="btn-copy" data-act="copy" title="复制 IMEI">📋 复制</button></div>' +
        '<div class="pcard-row"' + (st.address ? ' title="' + U.esc(st.address) + '"' : '') + '>📍 ' + (st.address ? U.esc(st.address) : (hasData ? '暂无位置' : '…')) + '</div>' +
        (st.lng !== undefined && isFinite(st.lng) ? '<div class="pcard-row pc-loc">' + Number(st.lng).toFixed(6) + ', ' + Number(st.lat).toFixed(6) + '</div>' : '') +
        '<div class="pcard-kv">' +
        '  <span>🔋 电量 ' + batteryHtml(st) + '</span>' +
        '  <span>📶 信号 <b>' + U.esc(sig) + '</b></span>' +
        '  <span>🛰 卫星 <b>' + U.esc(sat) + '</b></span>' +
        '  <span>💨 速度 <b>' + U.esc(spd) + '</b></span>' +
        '  <span>🧭 航向 <b>' + U.esc(crs) + '</b></span>' +
        '  <span>⛰ 海拔 <b>' + U.esc(alt) + '</b></span>' +
        '</div>' +
        '<div class="pcard-row">🕒 更新：' + U.esc(st.time || last) + '</div>' +
        '<div class="pcard-actions">' +
        '  <button class="btn sm" data-act="track">🛤 轨迹</button>' +
        '  <button class="btn sm" data-act="status">📊 状态</button>' +
        '  <button class="btn sm" data-act="edit">✏️ 改名</button>' +
        '  <button class="btn sm danger" data-act="del">🗑 删除</button>' +
        '</div></div>';
    }).join('');
    grid.innerHTML = html || '<div class="empty">暂无设备</div>';

    U.$all('.pcard', grid).forEach(function (card) {
      var imei = card.getAttribute('data-imei');
      U.$all('button', card).forEach(function (btn) {
        btn.addEventListener('click', function (evt) {
          evt.stopPropagation();
          var act = btn.getAttribute('data-act');
          if (act === 'track') { global.location.hash = '#/track/' + imei; }
          else if (act === 'status') { global.location.hash = '#/status/' + imei; }
          else if (act === 'edit') { petEditDialog(imei); }
          else if (act === 'del') { petDelete(imei); }
          else if (act === 'copy') { copyImei(imei); }
        });
      });
    });
  }

  function petEditDialog(imei) {
    var p = PetStore.get(imei) || { imei: imei, name: '' };
    promptDialog({
      title: '✏️ 设备名称',
      label: '给设备起一个易识别的名字',
      value: p.name || '',
      placeholder: '例如：布丁',
      hint: '保存后会同步到云端，换设备登录也能看到',
      okText: '保存'
    }, function (name) {
      PetStore.save({ imei: imei, name: name || CFG.DEV_PLACEHOLDER_NAME });
      U.toast('已保存（云端同步中）');
      render('pets', { force: true });
    });
  }

  function petDelete(imei) {
    confirmDialog({
      title: '🗑 删除设备',
      html: '确定删除设备 <b>' + U.esc(PetStore.nameOf(imei)) + '</b>（' + U.esc(imei) + '）吗？<br>' +
            '<span class="mute">本地档案会被移除，云端的设备与历史数据不受影响。</span>',
      okText: '删除',
      danger: true
    }, function () {
      PetStore.remove(imei);
      if (global.LocCache) LocCache.drop(imei);   // 本地定位缓存一并清掉，防串号复活
      U.toast('已删除');
      render('pets', { force: true });
    });
  }

  /* ================= #/devices 设备管理 ================= */

  function renderDevices(opts) {
    state.view = 'devices';
    activeNav('devices');
    var root = document.getElementById('view-root');
    root.innerHTML =
      '<div class="page">' +
      '  <h2>🖥 设备管理</h2>' +
      '  <div class="search-bar"><input id="dev-search" placeholder="搜索 IMEI 前缀，回车查询"><button id="btn-search" class="btn">搜索</button></div>' +
      '  <div id="dev-list" class="dev-list"></div>' +
      '</div>';
    clearTimers();
    showLoading('正在加载设备…');
    ensureProject().then(function (key) {
      if (!key) { hideLoading(); root.querySelector('#dev-list').innerHTML = '<div class="empty">暂无项目</div>'; return; }
      fillProjectSelect();
      loadDevices().then(function (devices) {
        hideLoading();
        renderDevList(devices);
      });
    });

    var inp = document.getElementById('dev-search');
    var btn = document.getElementById('btn-search');
    function doSearch() {
      var kw = (inp.value || '').trim();
      ensureProject().then(function (key) {
        if (!key) return;
        AC.searchMyDevices(key, kw, 1, CFG.LIST_MAX_SIZE).then(function (res) {
          var devices = (res.value && res.value.records) || [];
          renderDevList(devices);
        });
      });
    }
    if (btn) btn.addEventListener('click', doSearch);
    if (inp) inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') doSearch(); });
  }

  function renderDevList(devices) {
    var list = document.getElementById('dev-list');
    if (!list) return;
    if (!devices.length) { list.innerHTML = '<div class="empty">未找到设备</div>'; return; }
    var html = devices.map(function (d, i) {
      var imei = d.deviceid;
      var name = PetStore.nameOf(imei);
      var st = state.statuses[imei];
      var flag = st && st.found ? '在线' : '—';
      return '<div class="dev-row" data-imei="' + U.esc(imei) + '">' +
        '<div class="dr-main"><b>' + U.esc(name) + '</b><span class="dr-sub">' + U.esc(imei) + '</span></div>' +
        '<div class="dr-acts">' +
        '  <button class="btn sm" data-act="detail">详情</button>' +
        '  <button class="btn sm" data-act="cmd">⚡ 指令</button>' +
        '  <button class="btn sm" data-act="track">🛤 轨迹</button>' +
        '</div></div>';
    }).join('');
    list.innerHTML = html;
    U.$all('.dev-row', list).forEach(function (row) {
      var imei = row.getAttribute('data-imei');
      U.$all('button', row).forEach(function (btn) {
        btn.addEventListener('click', function () {
          var act = btn.getAttribute('data-act');
          if (act === 'detail') devDetail(imei);
          else if (act === 'cmd') devCmdDialog(imei);
          else if (act === 'track') global.location.hash = '#/track/' + imei;
        });
      });
    });
  }

  function devDetail(imei) {
    showLoading('正在查询详情…');
    AC.getPetStatus(imei).then(function (st) {
      hideLoading();
      var lines = [
        '📱 IMEI：' + U.esc(imei),
        '📍 经纬度：' + (st.lng !== undefined ? Number(st.lng).toFixed(6) + ', ' + Number(st.lat).toFixed(6) : '--'),
        '🏷 地址：' + (st.address ? U.esc(st.address) : '--'),
        '🔋 电量：' + (st.vbatPct !== undefined ? st.vbatPct + '%' : (st.percent !== undefined ? st.percent + '%' : '--')),
        '📶 信号：' + (st.signal !== undefined ? st.signal + '（' + U.signalText(st.signal) + '）' : '--'),
        '🕒 更新时间：' + U.esc(st.time || '--')
      ];
      modal('设备详情', lines.join('<br>'));
    });
  }

  function devCmdDialog(imei) {
    var tags = CFG.TAG_LIST.filter(function (t) { return [21, 22, 1281].indexOf(t.id) >= 0; });
    var opts = tags.map(function (t) {
      return '<option value="' + t.id + '">' + U.esc(t.name) + '（' + t.id + '）</option>';
    }).join('');
    var box = modal(
      '⚡ 指令下发',
      '<div class="form">' +
      '  <label>Tag</label><select id="cmd-tag">' + opts + '</select>' +
      '  <label>协议</label><select id="cmd-proto"><option value="0">TCP(0)</option><option value="1">UDP(1)</option><option value="2">MQTT(2)</option></select>' +
      '  <label>Value</label><input id="cmd-value" placeholder="如 {\"cmd\":\"fast_report\"} 或留空">' +
      '</div>',
      '<button id="cmd-send" class="btn">发送</button>'
    );
    var send = box.querySelector('#cmd-send');
    if (send) {
      send.addEventListener('click', function () {
        var tag = Number(box.querySelector('#cmd-tag').value);
        var proto = Number(box.querySelector('#cmd-proto').value);
        var val = box.querySelector('#cmd-value').value;
        send.disabled = true;
        AC.sendCmd(imei, tag, val, proto).then(function (res) {
          box.remove();
          if (res.code === 0) U.toast('指令下发成功');
          else U.toast('下发失败：' + (typeof res.value === 'string' ? res.value : res.code), 'err');
        });
      });
    }
  }

  /* ================= Modal ================= */

  function modal(title, bodyHtml, footerHtml) {
    var wrap = U.el('div', 'modal-mask');
    wrap.innerHTML =
      '<div class="modal">' +
      '  <div class="modal-head"><b>' + U.esc(title) + '</b><button class="modal-close">✕</button></div>' +
      '  <div class="modal-body">' + bodyHtml + '</div>' +
      (footerHtml ? '<div class="modal-foot">' + footerHtml + '</div>' : '') +
      '</div>';
    document.body.appendChild(wrap);
    var close = wrap.querySelector('.modal-close');
    if (close) close.addEventListener('click', function () { wrap.remove(); });
    wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
    return wrap;
  }

  /**
   * 按路由名重新渲染当前页
   * 原实现多处调用了未定义的 Views.render（切项目、改名、删设备后刷新），
   * 会抛 TypeError 导致「操作成功但页面没变化」，此处补齐分发器。
   */
  function render(route, opts) {
    switch (route) {
      case 'home': renderHome(opts); break;
      case 'pets': renderPets(opts); break;
      case 'devices': renderDevices(opts); break;
      case 'track': if (Views.renderTrack) Views.renderTrack(); break;
      case 'status': if (Views.renderStatus) Views.renderStatus(); break;
      case 'fence': if (Views.renderFence) Views.renderFence(); break;
      case 'alerts': if (Views.renderAlerts) Views.renderAlerts(); break;
      case 'debug': if (Views.renderDebug) Views.renderDebug(); break;
      case 'report': if (Views.renderReport) Views.renderReport(); break;
      default: renderHome(opts);
    }
  }

  /**
   * 应用内输入弹窗（替代 window.prompt）
   * 原因：Android WebView 未覆写 WebChromeClient.onJsPrompt 时，window.prompt 会被静默丢弃并返回
   * null —— 外部表现就是「电子围栏点了没反应」「设备改名保存不了」。改为自绘弹窗后全平台一致可用。
   */
  function promptDialog(opts, onOk, onCancel) {
    opts = opts || {};
    var settled = false;
    var box = modal(opts.title || '请输入',
      '<div class="form">' +
      (opts.label ? '  <label>' + U.esc(opts.label) + '</label>' : '') +
      '  <input id="dlg-input" type="text" value="' + U.esc(opts.value || '') + '" placeholder="' + U.esc(opts.placeholder || '') + '">' +
      (opts.hint ? '  <div class="mute" style="margin-top:4px">' + U.esc(opts.hint) + '</div>' : '') +
      '</div>',
      '<button class="btn ghost" id="dlg-cancel">取消</button>' +
      '<button class="btn" id="dlg-ok">' + U.esc(opts.okText || '确定') + '</button>');

    var input = box.querySelector('#dlg-input');
    var okBtn = box.querySelector('#dlg-ok');
    var cancelBtn = box.querySelector('#dlg-cancel');

    function finish(val, ok) {
      if (settled) return;
      settled = true;
      if (box.parentNode) box.parentNode.removeChild(box);
      if (ok) { if (onOk) onOk(val); }
      else if (onCancel) onCancel();
    }
    // ✕ 与点遮罩关闭 = 取消（modal 已绑定关闭，这里补一次业务回调）
    var x = box.querySelector('.modal-close');
    if (x) x.addEventListener('click', function () { finish(null, false); });
    box.addEventListener('click', function (e) { if (e.target === box) finish(null, false); });

    if (okBtn) okBtn.addEventListener('click', function () { finish(input ? input.value.trim() : '', true); });
    if (cancelBtn) cancelBtn.addEventListener('click', function () { finish(null, false); });
    if (input) {
      setTimeout(function () { try { input.focus(); input.select(); } catch (e) { /* ignore */ } }, 60);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); finish(input.value.trim(), true); }
      });
    }
    return box;
  }

  /**
   * 应用内确认弹窗（替代 window.confirm），html 仅可传应用内构造的可信字符串
   */
  function confirmDialog(opts, onOk) {
    opts = opts || {};
    var settled = false;
    var box = modal(opts.title || '请确认',
      '<div style="font-size:13.5px;line-height:1.75">' + (opts.html || U.esc(opts.text || '')) + '</div>',
      '<button class="btn ghost" id="cf-cancel">' + U.esc(opts.cancelText || '取消') + '</button>' +
      '<button class="btn' + (opts.danger ? ' danger' : '') + '" id="cf-ok">' + U.esc(opts.okText || '确定') + '</button>');

    var okBtn = box.querySelector('#cf-ok');
    var cancelBtn = box.querySelector('#cf-cancel');
    function finish(ok) {
      if (settled) return;
      settled = true;
      if (box.parentNode) box.parentNode.removeChild(box);
      if (ok && onOk) onOk();
    }
    if (okBtn) okBtn.addEventListener('click', function () { finish(true); });
    if (cancelBtn) cancelBtn.addEventListener('click', function () { finish(false); });
    return box;
  }

  var Views = {
    state: state,
    clearTimers: clearTimers,
    showLoading: showLoading,
    hideLoading: hideLoading,
    buildShell: buildShell,
    modal: modal,
    promptDialog: promptDialog,
    confirmDialog: confirmDialog,
    render: render,
    activeNav: activeNav,
    updateAlertDot: updateAlertDot,
    renderHome: renderHome,
    renderPets: renderPets,
    renderDevices: renderDevices,
    startTurboFromMap: startTurboFromMap,
    bindTurboStop: bindTurboStop,
    fillProjectSelect: fillProjectSelect,
    // 以下供 views2.js（轨迹/状态/性能页）复用，避免重复拉项目/设备导致的慢
    ensureProject: ensureProject,
    loadDevices: loadDevices,
    fetchAllStatuses: fetchAllStatuses,
    copyImei: copyImei
  };

  global.Views = Views;
})(window);