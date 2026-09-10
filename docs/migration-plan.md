# Leaflet → TMap 迁移 + 4 项功能优化 方案

> 项目：luatos-move（合宙 IoT 运动传感器 PetTrack）
> 基准：v0.4.3（map.js / views.js / views2.js 现状）
> 目标：地图底图从「高德瓦片直链 + Leaflet」迁移到「腾讯地图 JS API GL（TMap，合宙官方 Key）」，并同步落地 4 项优化。

---

## 0. 总览

| 模块 | 工作量 | 风险 |
|---|---|---|
| A. Leaflet → TMap 迁移 | 大（3 文件 + 模板 + 构建） | 高（地图核心重写） |
| B. 轨迹回放倍率（≤2400x） | 小 | 低 |
| C. 报警红点计数 + 已处理标记 | 小 | 低 |
| D. 性能监控信号/电压曲线图 | 中 | 低 |
| E. 我的设备新建设备按钮 | 小（依赖平台能力确认） | 中（能力待确认） |

**实施顺序建议**：先做 B/C/D/E（不依赖地图库，风险低、独立可测），最后做 A（迁移，需单独分支 + 回归）。

---

## 第一部分 A：Leaflet → TMap 迁移

### A1. 迁移动机（合规）

- 现状底图 = 高德瓦片直链 `webrd0{s}.is.autonavi.com`（**无 key 灰色爬取**，违反高德条款，无审图号）。
- 目标 = 腾讯 JS API GL + 合宙官方 Key `EZNBZ-VA6KW-ASMRR-3UE4S-M3QCO-EYBC6`（**已实测鉴权 `error:0 SUCCESS`**，`user_id 1395012`，不限域名，带审图号 `GS(2026)1190号`）。
- 坐标系：TMap 与平台数据同为 **GCJ02**，迁移后可**去掉高德瓦片 + 部分坐标转换**（见 A5）。

### A2. 影响范围

| 文件 | 改动内容 |
|---|---|
| `index.tpl.html` | 删 Leaflet CSS 占位符；新增 TMap 外链 `<script>`（见 A6） |
| `build_deploy.py` | 移除 `vendor/leaflet.js`、`vendor/leaflet.css` 合并；保留 jsencrypt |
| `js/app/map.js` | **整体重写** MapKit 内部为 TMap（对外接口改为「几何描述」风格，见 A4） |
| `js/app/views.js` | `renderHome` 的 marker/popup 调用改为新 MapKit 接口 |
| `js/app/views2.js` | 轨迹线 / 起终点 / 围栏圆/多边形 / 点击事件 / 回放 marker 全部改新接口 |
| `vendor/` | 删 leaflet.js / leaflet.css / marker 图标（不再需要） |

### A3. Leaflet → TMap API 映射表

| 能力 | Leaflet（现状） | TMap（目标） |
|---|---|---|
| 实例 | `L.map(el, opts)` | `new TMap.Map(el, {center, zoom, viewMode:'2D'})` |
| 销毁 | `map.remove()` | `map.destroy()` |
| 定位 | `map.setView([lat,lng],z)` | `map.setCenter(new TMap.LatLng(lat,lng))` + `setZoom(z)` |
| 视野 | `map.fitBounds(latlngs,{padding})` | `map.fitBounds(new TMap.LatLngBounds(sw,ne),{padding})` |
| 点击 | `map.on('click', e=>e.latlng)` | `map.on('click', e=>e.latLng)` |
| 移动 | `map.on('mousemove', …)` | `map.on('mousemove', …)` |
| 双击 | `map.on('dblclick', …)` | `map.on('dblclick', …)` |
| 折线 | `L.polyline(latlngs,{color,weight})` | `TMap.MultiPolyline({map, styles, geometries:[{paths:[{lat,lng}],styleId}]})` |
| 点标记 | `L.circleMarker([lat,lng],{…})` | `TMap.MultiMarker({styles, geometries:[{position,styleId}]})` |
| 圆 | `L.circle([lat,lng],{radius})` | `TMap.MultiCircle({geometries:[{center,radius,styleId}]})` |
| 多边形 | `L.polygon(latlngs,{…})` | `TMap.MultiPolygon({geometries:[{paths,styleId}]})` |
| 弹窗 | `marker.bindPopup(html)` | `new TMap.InfoWindow({map, position, content})` |
| 图层组 | `L.layerGroup()` | MapKit 内部数组管理几何集合 |
| 移除 | `map.removeLayer(layer)` | `xxx.setGeometries([])` 或删除单个 geometry |

**核心架构差异**：Leaflet 是「图层对象」模型（每个 layer 独立 add/remove）；TMap 是「几何集合」模型（`MultiMarker/MultiPolyline/MultiPolygon/MultiCircle` 一个实例管理多个几何，通过 `setGeometries` 增删）。

### A4. 关键设计：MapKit 对外接口改为「几何描述」风格（脱离 Leaflet 对象）

现状问题：`MapKit.addTemp(L.polyline(…))`、`MapKit.addFence(L.circle(…))` 让调用方（views2.js）直接构造 Leaflet 对象，迁移时调用方也要跟着改。**一次到位**：把接口改成传「几何描述对象」，MapKit 内部转 TMap，调用方不再碰任何地图库对象。

新接口草案：

```js
// 轨迹线
MapKit.addTemp({ type:'polyline', points:[[lng,lat],…], color:'#2f7bff', weight:4, opacity:0.85 });
// 起终点 / 回放移动点
MapKit.addTemp({ type:'dot', point:[lng,lat], radius:8, color:'#1abc5a', popup:'起点' });
// 围栏圆 / 多边形
MapKit.addFence({ type:'circle', center:[lng,lat], radius:m, name:'…' });
MapKit.addFence({ type:'polygon', points:[[lng,lat],…], name:'…' });
// 设备 marker（内部走 MultiMarker，保留 upsertMarker 语义）
MapKit.upsertMarker(statusObj);
```

MapKit 内部维护：`petMarkerLayer`（MultiMarker）+ `tempShapes[]`（临时几何池，`clearTemp` 清空）+ `fenceShapes[]`。

**不变接口**（签名照旧，内部换实现）：`create / getMap / epoch / mapAlive / destroyMap / popupHtml / openPopupFor / refreshOpenPopups / startTurbo / stopTurbo / isTurbo / setTurboFocus / focusOn / setLocked / locked / clearTemp / clearFences / bindDelegates / state`。

**变化的只有**：`addTemp / addFence` 从接收 Leaflet layer → 接收几何描述对象；`getMap()` 返回 TMap 实例（调用方仅用它做 `setCenter / fitBounds / on` 等，需同步改）。

### A5. 坐标系简化（收益点）

- 平台 `latest_location` / `val_<tag>` 已是 **GCJ02**；TMap 也用 GCJ02 → **直接用 lng/lat，不再走 `Algo.wgs84ToGcj02`**。
- 唯一保留：轨迹点带 `coord === COORD_WGS84` 标记时仍需转换（`Algo.wgs84ToGcj02` 是纯算法，保留）。
- 高德瓦片层 + Canvas 网格层**整体删除**（TMap 自带矢量底图）。

### A6. TMap 加载（架构变化，需你确认合规）

TMap SDK 是**外域 script，无法内联**（SDK 体积大且会动态加载子资源）。因此：

```html
<!-- index.tpl.html <head> 新增（唯一外链） -->
<script src="https://map.qq.com/api/gljs?v=1.exp&key=EZNBZ-VA6KW-ASMRR-3UE4S-M3QCO-EYBC6"></script>
```

- 这打破了当前「零外链」架构。**前提**：合宙审核放行 `map.qq.com` 域名（官方给了这个 Skill，判断放行，但需你有底）。
- TMap 异步加载：`MapKit.create` 内需判 `window.TMap` 就绪，未就绪则等 `onload` 后重试一次（或轮询）。

### A7. 分步迁移计划（每步可独立提交 + 回归）

1. **骨架**：`index.tpl.html` 加 TMap 外链；`build_deploy.py` 移除 Leaflet 合并项；`map.js` 重写 `create/getMap/destroyMap/mapAlive/epoch`（TMap 实例 + 就绪等待）。`node smoke-test.js` 保底。
2. **点/线**：实现 `addTemp`（polyline + dot）+ `clearTemp`；改 `views2.js` 轨迹 `drawTrack/startReplay`。
3. **围栏**：实现 `addFence/clearFences`；改 `views2.js` 围栏绘制 + 地图 `on('click/mousemove/dblclick')` 事件（围栏状态机）。
4. **设备 marker**：实现 `upsertMarker/popupHtml/openPopupFor/refreshOpenPopups/focusOn`（MultiMarker + InfoWindow）；改 `views.js` renderHome。
5. **Turbo 实时追踪**：`startTurbo/stopTurbo/setTurboFocus` 移植（复用 dot + fitBounds + 定时器）。
6. **清理 + 回归**：删 vendor/leaflet*、删高德瓦片/Canvas 网格代码、删 `Algo.wgs84ToGcj02` 多余调用；`smoke-test.js` 全绿 + 线上实测。

### A8. 风险与兜底

| 风险 | 应对 |
|---|---|
| TMap 就绪时机（异步） | `create` 内 `ensureTMap(cb)`：已就绪直接建，否则轮询 100ms（上限 ~5s） |
| 防跨页污染（epoch/mapAlive） | 保留现有 epoch/mapAlive 机制，TMap 用 `destroy()` 销毁 |
| 回放 marker 高频 `setLatLng` | TMap 无单 marker 移动 API，用 `MultiMarker.updateGeometries` 更新 position；或改用「小圆点 MultiCircle」逐帧更新中心 |
| 围栏圆半径实时预览（mousemove） | `MultiCircle.updateGeometries` 更新 radius |
| InfoWindow 与 marker 绑定 | 设备 marker 点击 → 用**单个** `TMap.InfoWindow` 复用（`setPosition` + `open`），避免多实例泄漏 |
| 审核外域脚本 | 迁移前先确认合宙放行 `map.qq.com`（见 A6） |

---

## 第二部分：4 项功能优化

### B. 轨迹回放倍率（最大 2400x）

**现状**（`views2.js` startReplay）：固定把轨迹总时长压到 2~60s，无倍率概念。
**目标**：可调倍率，最大 2400x。

实现：
1. UI：`#/track` 的 `tr-play` 旁新增倍率控件——预设档位按钮组 `[1x, 4x, 16x, 60x, 120x, 240x, 600x, 1200x, 2400x]` + 当前倍率高亮。
2. 计算：`totalMs = (末ts − 首ts) / speed`；`stepMs = totalMs / 点数`；帧率保护 `stepMs = max(16, stepMs)`。
3. 效果：2400x 时 1 天轨迹（86400s）≈ 36s 回放。
4. 回放中切换倍率 → 立即重算 `stepMs`（重设 `setInterval`），进度不丢。

### C. 报警红点计数 + 手动标记已处理

**现状**：导航「报警」Tab 是红色呼吸灯（`.has-alert::after` + `alert-breathe`），无数量、无已处理概念。
**目标**：红点显示未处理数量；可手动标记已处理。

实现：
1. `js/fence.js` `FenceStore`：alert 记录加 `handled` 字段（默认 false）；新增 `markHandled(id)`、`unhandledCount()`。
2. `views.js` `updateAlertDot()`：红点从「呼吸灯」改为「数字气泡」——`unhandledCount()>0` 时显示数字（>99 显示 `99+`），0 时隐藏；保留淡红呼吸仅当有未处理。
3. `views2.js` `renderAlerts`：每条报警加「✅ 标记已处理」按钮 + 已处理态（置灰/划线）；列表顶部加「全部标记已处理」；未处理条目红点角标。
4. 持久化：`handled` 存入 `pt_fence_alerts`（localStorage，现有 key），刷新不丢。

### D. 性能监控信号/电压曲线图

**现状**（`views2.js` debugOne）：`vbat[]`/`sig[]` 已收集，但只显示「最新值 + 每小时耗电」文本。
**目标**：信号（782）和电压（799）各一张折线曲线图。

实现：
1. 复用 `views3.js` 日报的 Canvas 绘制思路，新增 `drawLineChart(canvas, series, opts)` 工具（纯原生，无依赖）：
   - 横轴 = 真实时间范围（本地钟面刻度，复用 `U.fmtFull`/时间格式化，**禁止 ±8 换算**）；纵轴 = 信号值 / 电压 mV。
   - 支持「最小值/最大值/均值」标注 + 悬停点值（可选）。
2. `debugOne` 在 `db-grid` 上方插入两个 `<canvas>` 卡：📶 信号曲线、🔋 电压曲线；数据点过多时抽稀（等距采样 ≤ 200 点，对齐现有「上报数据 200 条」口径）。
3. 时间窗口切换（半小时/1小时/…）时曲线随 `debugOne` 重新拉数据重绘。

### E. 我的设备「新建设备」按钮

**现状**（`views.js` renderPets）：六宫格只有设备卡片，无新增入口；设备靠平台「扫码绑定自动建档」。
**目标**：增加「＋ 新建设备」按钮 + 功能。

**⚠️ 前置待确认**：AirCloud 平台是否提供「手动添加/SN 绑定设备」接口。已知只有 `list_my_devices / search_my_devices`（查询），无 `add_device`。因此给出两条路径：

- **路径 1（优先，若有接口）**：弹窗输入设备 SN/IMEI → 调平台绑定接口 → 成功后刷新设备列表。
- **路径 2（兜底，无接口）**：按钮 → 弹窗展示「扫码绑定指引」（合宙 App 二维码 / 绑定页跳转 `iot.luatos.com` 设备绑定入口），设备上电绑定后自动出现在列表。

实现：`renderPets` 的 `page` 头部加 `＋ 新建设备` 按钮（`renderPetGrid` 之上）；点击弹 `Views.modal`；按平台能力走路径 1 或 2。

---

## 第三部分：验收标准

| 项 | 标准 |
|---|---|
| 地图 | TMap 底图正常出图（GCJ02，无「鉴权失败」）；高德瓦片/Canvas 网格代码清零；`grep -rn "autonavi\|L\."` 无残留 |
| 迁移回归 | `node smoke-test.js` 全绿；首页 10s 刷新 marker 弹窗正常；轨迹/围栏/回放/Turbo 各页无残留图层、无跨页污染 |
| 倍率 | 2400x 可选且回放时长 ≈ 总时长/2400；切换倍率即时生效 |
| 报警 | 红点显示未处理数量；标记已处理后数字递减、条目置灰；刷新持久化 |
| 曲线图 | 信号/电压各一张曲线，窗口切换随数据重绘，时间刻度本地钟面 |
| 新建设备 | 按钮可见；按确认路径完成「新增 → 列表出现」闭环 |

---

## 第四部分：待你拍板的事项

1. **合宙是否放行 `map.qq.com` 外域脚本**？（迁移 A 的前提）
2. **新建设备**：平台有无 SN 绑定接口？走路径 1 还是 2？（我倾向先按路径 2 兜底实现，接口有了再升级）
3. **倍率档位**：按上面 `[1x…2400x]` 9 档，还是改成自由输入 1~2400？
4. **迁移是否单独开分支**（`feat/tmap`），Web 版验收通过后再合入，不碰当前线上版？
