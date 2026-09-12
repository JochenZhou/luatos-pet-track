/**
 * config.js —— 全局配置与平台常量
 * 挂载：window.CFG
 * 说明：域名只允许出现在本文件的常量定义处；业务代码一律引用常量。
 */
(function (global) {
  'use strict';

  // ============ 域名常量（最高优先级，仅此处允许出现完整域名） ============
  var API_HOST = 'https://api-iot.luatos.com'; // 所有 API 后端接口请求的域名前缀
  var BASE_HOST = 'https://iot.luatos.com';    // 所有网页之间跳转地址的域名前缀

  // 页面文件相对名
  var LOGIN_PAGE = 'login.html';
  var APP_PAGE = 'index.html';

  // 构建号：必须与 android/app/build.gradle 的 versionName 保持一致（冒烟 T126 校验）。
  // 用途：登录页 ↔ 业务页跳转时带上 ?v=BUILD，逼浏览器/WebView 丢掉旧副本。
  // 合宙平台只给 HTML 加 Last-Modified、没有 Cache-Control，改完页面不换 URL
  // 用户就会一直看到缓存里的旧版（曾出现「登录按钮已改青色，用户仍看到蓝色」）。
  var BUILD = '0.4.13';

  // appId 兜底常量：部署时优先从 URL /ai_app/luatos/{appId}/ 提取，取不到回退本值
  var FALLBACK_APP_ID = 'move';

  // 业务 open_api 网关
  var API_BASE = API_HOST + '/iot/open_api';

  // ============ 官方 AirCloud TAG 清单（禁止编造，仅此清单内可查询/选择） ============
  var TAG_LIST = [
    { id: 512, name: 'GNSS 经度' },
    { id: 513, name: 'GNSS 纬度' },
    { id: 799, name: '电压 (mV)' },
    { id: 782, name: '4G 信号' },
    { id: 519, name: '定位标识' },
    { id: 517, name: '可见卫星数' },
    { id: 516, name: '搜星总数' },
    { id: 515, name: '最强4星CN值' },
    { id: 256, name: '温度' },
    { id: 777, name: '开机原因' },
    { id: 1294, name: 'GNSS BINARY(差分)' },
    { id: 1293, name: 'gsensor IMU (私有)' },
    { id: 1281, name: '自定义下行' },
    { id: 21, name: 'iRTU 下行指令' },
    { id: 22, name: '通知设备上传日志' },
    { id: 25, name: 'iRTU 上行回复' },
    { id: 28, name: '短信' }
  ];
  // 默认设备状态轮询 tag 集
  var DEFAULT_STATUS_TAGS = [513, 512, 799, 782, 519, 256];

  // ============ 电量分档（vbat 电压 mV）：低电量阈值 ============
  var VBAT_LOW_MV = 3400;   // < 3400mV 判定低电量（红）
  var VBAT_MID_MV = 3700;   // < 3700mV 判定中等电量（黄），≥3700 充足（绿）
  // 轨迹查询 tag 集（附 1294 精细点）
  var TRACK_TAGS = [513, 512, 1294];

  // 私有 tag（需要 allowCustom 放行）
  var PRIVATE_TAGS = { 1293: 'gsensor' };

  // ============ 认证缓存键（my_* / m_* 内部技术标识，禁止客户可见） ============
  var KEY_MY_AUTH = 'my_auth';
  var KEY_MY_SERVICE = 'my_service';
  var KEY_MY_PROFILE = 'my_profile';
  var KEY_MY_TENANT = 'my_tenant';
  var KEY_MY_SETS = 'my_sets';
  var KEY_M_AUTH = 'm_auth';
  var KEY_M_SERVICE = 'm_service';
  var KEY_M_PROFILE = 'm_profile';
  var KEY_M_SETS = 'm_sets';
  var KEY_HOST_SESSION = 'm_host_session'; // sessionStorage 宿主会话标记，仅存在 sessionStorage

  // ============ 业务本地键 ============
  var KEY_PROJECT_KEY = 'pt_project_key';
  var KEY_PROFILES = 'pt_profiles';
  var KEY_HIDDEN_DEVICES = 'pt_hidden_devices';
  var KEY_FENCES = 'pt_fences';
  var KEY_LOC_CACHE = 'pt_loc_cache';   // 设备最近定位持久化缓存（js/loc-cache.js）
  var KEY_NICK = 'pt_nick';
  var KEY_ACCOUNT = 'pt_account';

  // 主题与推送偏好
  // 注意：这三个键必须存「裸字符串」（不经过 U.store 的 JSON.stringify），
  // 因为 index.tpl.html 的防闪内联脚本要直接读 localStorage，不能依赖序列化格式。
  var KEY_ACCENT = 'pt_accent';          // 配色预设（data-accent）
  var KEY_THEME_MODE = 'pt_theme_mode';  // light | dark
  var KEY_PUSH = 'pt_push';              // '1' 开启 / '0' 关闭

  // ============ 平台参数 ============
  var DEFAULT_PAGE_SIZE = 50;    // list_by_tags 建议 [0,100]
  var LIST_MAX_SIZE = 100;
  var REQ_TIMEOUT = 15000;       // fetch 15s 超时
  var POLL_STATUS_MS = 10000;    // 首页状态轮询间隔
  var FENCE_WATCH_MS = 30000;    // 越界巡检间隔（每轮只抽查一台设备，压低请求频率）
  var FENCE_ALERT_DEBOUNCE = 300000; // 围栏报警 5 分钟去抖
  var STATUS_TTL_MS = 30000;     // 设备状态缓存有效期（切 tab 内复用，过期后台刷新）
  var DEVICES_TTL_MS = 60000;    // 设备列表缓存有效期

  // 设备名称云同步 cls（common/put）与 uni_key 说明
  var DEVNAME_CLS = 10;

  // 设备未命名时的占位名（多处在用，集中一处便于统一改文案）
  var DEV_PLACEHOLDER_NAME = '未命名设备';

  // 坐标源标记
  var COORD_GCJ02 = 'gcj02';
  var COORD_WGS84 = 'wgs84';

  var CFG = {
    API_HOST: API_HOST,
    BASE_HOST: BASE_HOST,
    API_BASE: API_BASE,
    LOGIN_PAGE: LOGIN_PAGE,
    APP_PAGE: APP_PAGE,
    BUILD: BUILD,
    OAUTH_URL: API_HOST + '/iam/luat_oauth/authorize',
    LOGIN_API: API_HOST + '/iam/luat_oauth/v2/login',
    FALLBACK_APP_ID: FALLBACK_APP_ID,
    TAG_LIST: TAG_LIST,
    DEFAULT_STATUS_TAGS: DEFAULT_STATUS_TAGS,
    VBAT_LOW_MV: VBAT_LOW_MV,
    VBAT_MID_MV: VBAT_MID_MV,
    TRACK_TAGS: TRACK_TAGS,
    PRIVATE_TAGS: PRIVATE_TAGS,
    KEY_MY_AUTH: KEY_MY_AUTH,
    KEY_MY_SERVICE: KEY_MY_SERVICE,
    KEY_MY_PROFILE: KEY_MY_PROFILE,
    KEY_MY_TENANT: KEY_MY_TENANT,
    KEY_MY_SETS: KEY_MY_SETS,
    KEY_M_AUTH: KEY_M_AUTH,
    KEY_M_SERVICE: KEY_M_SERVICE,
    KEY_M_PROFILE: KEY_M_PROFILE,
    KEY_M_SETS: KEY_M_SETS,
    KEY_HOST_SESSION: KEY_HOST_SESSION,
    KEY_PROJECT_KEY: KEY_PROJECT_KEY,
    KEY_PROFILES: KEY_PROFILES,
    KEY_HIDDEN_DEVICES: KEY_HIDDEN_DEVICES,
    KEY_FENCES: KEY_FENCES,
    KEY_LOC_CACHE: KEY_LOC_CACHE,
    KEY_NICK: KEY_NICK,
    KEY_ACCOUNT: KEY_ACCOUNT,
    KEY_ACCENT: KEY_ACCENT,
    KEY_THEME_MODE: KEY_THEME_MODE,
    KEY_PUSH: KEY_PUSH,
    DEFAULT_PAGE_SIZE: DEFAULT_PAGE_SIZE,
    LIST_MAX_SIZE: LIST_MAX_SIZE,
    REQ_TIMEOUT: REQ_TIMEOUT,
    POLL_STATUS_MS: POLL_STATUS_MS,
    FENCE_WATCH_MS: FENCE_WATCH_MS,
    FENCE_ALERT_DEBOUNCE: FENCE_ALERT_DEBOUNCE,
    STATUS_TTL_MS: STATUS_TTL_MS,
    DEVICES_TTL_MS: DEVICES_TTL_MS,
    DEVNAME_CLS: DEVNAME_CLS,
    DEV_PLACEHOLDER_NAME: DEV_PLACEHOLDER_NAME,
    COORD_GCJ02: COORD_GCJ02,
    COORD_WGS84: COORD_WGS84,
    USE_PLATFORM_VAL: true
  };

  global.CFG = CFG;
})(window);