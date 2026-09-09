# 合宙IoT-运动传感器（PetTrack）

基于合宙 AirCloud 开放平台的设备定位与状态管理 Web 应用。参加 Air8202G 整机前端开发活动。

## ✨ 功能

| 模块 | 说明 |
|---|---|
| 📍 实时地图 | 高德瓦片底图（GCJ02 直用）、设备卡片毛玻璃列表、10s 轮询流式刷新、marker 弹窗、实时追踪 |
| 🐾 我的设备 | 电量/信号/卫星/速度/航向/海拔六宫格、IMEI 一键复制、云端名称同步（RSA 签名） |
| 📊 设备状态 | 1293 gsensor 真实解包 → 步数/姿态/跌倒检测 |
| 🛤 轨迹回放 | 日期范围查询、1294 GNSS 差分精细点、回放动画 |
| ⭕ 电子围栏 | 圆形/多边形绘制、越界判定、报警去抖 |
| 🖥 设备管理 | 搜索、指令下发 |
| 🔧 性能监控 | 信号/电压耗电/CN 值/重启/数据包时间窗口分析 |

## 🧱 技术形态

- 原生 ES5 + IIFE 模块（`window.AC/MapKit/Views/PetStore/FenceStore/Utils/Algo/CFG`），零框架零构建依赖
- 交付物仅 2 个文件：`login.html` + `index.html`（CSS/JS/Leaflet/JSEncrypt 全内联 ~370KB）
- 合规：零外链 script、无 eval、坐标 GCJ02、时间本地钟面（平台字面直出）
- 移动端：底部抽屉设备列表、Tab 导航、dvh 视口适配

## 📁 结构

```
├─ login.html          # OAuth 登录页（独立手写）
├─ index.tpl.html      # 业务页模板
├─ build_deploy.py     # 构建：合并 js → 注入模板 → index.html
├─ smoke-test.js       # 65 项结构级冒烟测试（stub fetch）
├─ css/style.css       # 全量样式
├─ js/                 # 源码（config/utils/pet-store/fence/algo×5/api×2/app×6）
└─ vendor/             # Leaflet 1.9.4 + JSEncrypt 3.3.2（已打审核补丁）
```

## 🔨 构建与测试

```bash
python3 build_deploy.py   # 生成 index.html
node smoke-test.js        # 65 项冒烟测试
```

## 📦 部署

### 合宙平台（Web + 小程序）
1. `iot.luatos.com` → 基础能力 → 自建应用 → ③自建Web应用 / ④自建微信小程序
2. 上传 `index.html`、`login.html`、`logo.png`
3. 访问：`https://iot.luatos.com/ai_app/luatos/{appId}/index.html`

### Android App（GitHub Actions 自动打包）
推送 tag `v*` 自动触发，产物在 [Releases](../../releases) 下载 APK。
本地构建：`cd android && ./gradlew assembleRelease`

### PWA
`manifest.webmanifest` 已内置，手机浏览器「添加到主屏幕」即可。

## 📖 参考

- 合宙 AirCloud 开放接口文档
- 网页工具规则（双文件工程规范）

## 📄 License

MIT