package com.jochen.luatos_pet_track;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentValues;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.StateListDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.media.MediaScannerConnection;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;
import android.widget.Toast;

import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

import androidx.drawerlayout.widget.DrawerLayout;

/**
 * 主 Activity：WebView 加载平台部署的 Web 应用 + 左侧抽屉菜单。
 * 侧边栏列出网页版全部 9 个功能 Tab，点击后通过 hash 路由跳转（不刷新页面、不丢登录态）。
 * 登录页 = https://iot.luatos.com/ai_app/luatos/pet_track_jochen/login.html
 * OAuth 三方跳转（api-iot.luatos.com / iot.openluat.com）在本 WebView 内完成，
 * 登录态 localStorage 与浏览器一致，刷新不丢。
 */
public class MainActivity extends Activity {

    /** 应用根地址：页面 URL 统一在这里拼，避免同域名散落多处 */
    private static final String BASE_APP_URL =
            "https://iot.luatos.com/ai_app/luatos/pet_track_jochen/";

    /**
     * 给页面 URL 拼上 APK 版本号。
     * 平台只发 Last-Modified、不发 Cache-Control，同一个 URL WebView 会一直复用旧副本，
     * 表现是「网页已经更新，APP 里还是旧样式」（曾出现登录按钮改成青色后 APP 仍是蓝色）。
     * 带上 ?v=&lt;versionName&gt; 后，换版本必定取到新文件。
     */
    private String withBuild(String url) {
        return url + "?v=" + appVersionName();
    }

    private String loginUrl() { return withBuild(BASE_APP_URL + "login.html"); }

    private String indexUrl() { return withBuild(BASE_APP_URL + "index.html"); }

    /** 侧边栏菜单：{名称, hash 路由}，与网页版导航一一对应 */
    private static final String[][] MENUS = {
            {"📍 实时地图", "#/home"},
            {"🐾 我的设备", "#/pets"},
            {"📅 日报", "#/report"},
            {"📊 设备状态", "#/status"},
            {"🛤 轨迹回放", "#/track"},
            {"⭕ 电子围栏", "#/fence"},
            {"🚨 报警", "#/alerts"},
            {"🖥 设备管理", "#/devices"},
            {"🔧 性能监控", "#/debug"},
    };

    private WebView webView;
    private ProgressBar progressBar;
    private DrawerLayout drawer;
    private LinearLayout drawerHeader;
    private TextView drawerHeaderSub;

    /* ---------------- 主题配色同步（侧边栏头部跟随网页端配色） ----------------
       原生外壳（DrawerLayout 头部、ProgressBar、菜单按下底）拿不到 WebView 里的
       CSS 变量，必须在 Android 侧再存一份色板。这份色板与
       js/theme.js 的 PRESETS / css/style.css 的 [data-accent="*"] 一一对应，
       冒烟测试保证后两者一致，这里是第三份副本 —— 改配色时三处都要改。

       网页端切换配色时由 theme.js 的 paint() 调 AndroidBridge.setAccent(key)；
       APP 启动/页面加载完再从 localStorage 的 pt_accent 兜底同步一次
       （覆盖「用户上次在网页里改过、但没触发桥调用」的情况）。          */
    private static final String PREFS = "pettrack_theme";
    private static final String PREF_ACCENT = "accent";
    private static final String DEFAULT_ACCENT = "teal";
    /** 上次启动时的 APK 版本号：版本变了就清一次 WebView HTTP 缓存（见 clearStaleWebCache） */
    private static final String PREF_WEB_VER = "web_ver";

    /** {key, brand-700(头部渐变起), brand-600(主色/进度条), brand-100(头部副标题), brand-50(菜单按下底), aurora-500(渐变末)} */
    private static final String[][] ACCENTS = {
            {"teal",    "#0F766E", "#0D9488", "#CCFBF1", "#F0FDFA", "#0EA5E9"},
            {"indigo",  "#4338CA", "#4F46E5", "#E2E6FF", "#EEF0FF", "#06B6D4"},
            {"ocean",   "#1D4ED8", "#2563EB", "#DBEAFE", "#EFF6FF", "#06B6D4"},
            {"violet",  "#6D28D9", "#7C3AED", "#EDE9FE", "#F5F3FF", "#D946EF"},
            {"emerald", "#047857", "#059669", "#D1FAE5", "#ECFDF5", "#14B8A6"},
            {"amber",   "#B45309", "#D97706", "#FEF3C7", "#FFFBEB", "#F43F5E"},
            {"rose",    "#BE123C", "#E11D48", "#FFE4E6", "#FFF1F2", "#F97316"},
            {"slate",   "#334155", "#475569", "#F1F5F9", "#F8FAFC", "#3B82F6"},
    };

    /** 当前生效的菜单「按下/选中」底色，切配色时用它重建菜单项背景 */
    private int accentSoft = 0xFFF0FDFA;

    /* ---------------- 报警消息推送 ---------------- */
    private static final String CHANNEL_ID = "pettrack_alarm";
    private static final String CHANNEL_NAME = "越界报警";
    private static final int NOTIFY_ID = 1001;
    private static final int REQ_NOTIFY_PERM = 13;
    /** 点通知要跳转的 hash 路由（通知点击 → 应用内跳到报警页） */
    private static final String EXTRA_HASH = "pettrack_hash";
    /** 网页端已加载完 index.html 之前收到的跳转请求，先存着，onPageFinished 再执行 */
    private String pendingHash = null;
    /** Android 13+ 未授权通知时，把这条报警暂存下来，授权通过后补发 */
    private String[] deferredNotify = null;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progressBar = findViewById(R.id.progress);
        drawer = findViewById(R.id.drawer);
        drawerHeader = findViewById(R.id.drawer_header);
        drawerHeaderSub = findViewById(R.id.drawer_header_sub);

        // 侧边栏头部/进度条先按「上次用的配色」上色，避免先闪一下默认靛蓝。
        // 网页端加载完后还会用 localStorage 里的 pt_accent 再兜底同步一次。
        applyAccent(savedAccent());
        TextView versionView = findViewById(R.id.drawer_version);
        if (versionView != null) versionView.setText("v" + appVersionName());

        createNotifyChannel();

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);            // localStorage 登录态
        s.setDatabaseEnabled(true);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSupportZoom(false);
        s.setLoadWithOverviewMode(true);
        s.setUseWideViewPort(true);

        webView.addJavascriptInterface(new AndroidBridge(), "AndroidBridge");
        installImageSaveHook();

        CookieManager.getInstance().setAcceptCookie(true);
        CookieManager.getInstance().setAcceptThirdPartyCookies(webView, true);

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                if (progressBar != null) {
                    progressBar.setVisibility(newProgress >= 100 ? View.GONE : View.VISIBLE);
                    progressBar.setProgress(newProgress);
                }
            }
        });

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                updateAppMenuLayout(url);
                injectSaveHook();
                applyPendingHash();      // 通知点击带来的跳转，等页面就绪后再执行
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                String host = uri.getHost() == null ? "" : uri.getHost();
                String scheme = uri.getScheme() == null ? "" : uri.getScheme();
                // 白名单：合宙全系（luatos.com / openluat.com，含 iot.openluat.com OAuth）
                // 全部留在 WebView 内完成登录闭环，绝不甩到系统浏览器
                boolean inHouse = host.endsWith("luatos.com")
                        || host.endsWith("openluat.com")
                        || host.endsWith("d3inf.com");     // 平台 API 网关
                if (inHouse && ("https".equals(scheme) || "http".equals(scheme))) {
                    return false; // WebView 自行加载
                }
                // 非网页协议（weixin://、intent://、mailto: 等）交给系统处理
                if (!"http".equals(scheme) && !"https".equals(scheme)) {
                    try {
                        startActivity(new Intent(Intent.ACTION_VIEW, uri));
                    } catch (Exception ignored) { }
                    return true;
                }
                // 其它 https 外域也走外链浏览器
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) { }
                return true;
            }
        });

        setupDrawerMenu();

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            // 只在「冷启动且 APK 换过版本」时清一次 HTTP 缓存，平时照常走缓存
            clearStaleWebCache();
            webView.loadUrl(loginUrl());
        }
        handleIntentHash(getIntent());
    }

    /* ================= 报警消息推送 ================= */

    /** 通知渠道（Android 8.0+ 必须先建渠道，否则通知会被静默丢弃） */
    private void createNotifyChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return;
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm == null || nm.getNotificationChannel(CHANNEL_ID) != null) return;
        NotificationChannel ch = new NotificationChannel(
                CHANNEL_ID, CHANNEL_NAME, NotificationManager.IMPORTANCE_HIGH);
        ch.setDescription("电子围栏越界等报警消息");
        ch.enableVibration(true);
        ch.setShowBadge(true);
        nm.createNotificationChannel(ch);
    }

    private boolean hasNotifyPermission() {
        if (Build.VERSION.SDK_INT < 33) return true;   // 13 以前无需运行时授权
        return checkSelfPermission("android.permission.POST_NOTIFICATIONS")
                == PackageManager.PERMISSION_GRANTED;
    }

    /** 发一条系统通知；点通知会带着 hash 回到本 Activity（singleTask） */
    private void showNotification(String title, String body, String hash) {
        if (!hasNotifyPermission()) {
            // 先申请授权，授权通过后在 onRequestPermissionsResult 里补发，避免用户「开了开关却没反应」
            deferredNotify = new String[]{title, body, hash};
            requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY_PERM);
            return;
        }
        Intent it = new Intent(this, MainActivity.class)
                .setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP)
                .putExtra(EXTRA_HASH, hash == null ? "" : hash);
        int piFlags = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) piFlags |= PendingIntent.FLAG_IMMUTABLE;
        PendingIntent pi = PendingIntent.getActivity(this, 0, it, piFlags);

        NotificationCompat.Builder b = new NotificationCompat.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.ic_notify)
                .setContentTitle(title)
                .setContentText(body)
                .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
                .setPriority(NotificationCompat.PRIORITY_HIGH)
                .setCategory(NotificationCompat.CATEGORY_ALARM)
                .setAutoCancel(true)
                .setContentIntent(pi);
        try {
            NotificationManagerCompat.from(this).notify(NOTIFY_ID, b.build());
        } catch (SecurityException e) {
            // 用户在系统设置里关掉了通知，静默即可（网页端仍有应用内提示）
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_NOTIFY_PERM) return;
        String[] d = deferredNotify;
        deferredNotify = null;
        boolean ok = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (ok && d != null) {
            showNotification(d[0], d[1], d[2]);
        } else if (!ok) {
            Toast.makeText(this, "未授予通知权限，报警只能在应用内查看", Toast.LENGTH_LONG).show();
        }
    }

    /** 取出通知带过来的 hash，等页面就绪后跳转 */
    private void handleIntentHash(Intent intent) {
        if (intent == null) return;
        String h = intent.getStringExtra(EXTRA_HASH);
        if (h == null || h.length() == 0) return;
        intent.removeExtra(EXTRA_HASH);
        pendingHash = h;
        applyPendingHash();
    }

    private void applyPendingHash() {
        if (pendingHash == null || webView == null) return;
        String url = webView.getUrl();
        if (url == null || !url.contains("index.html")) return;  // 还在登录页，等页面切换后再执行
        String h = pendingHash;
        pendingHash = null;
        navigate(h);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        handleIntentHash(intent);
    }

    /**
     * APP 专用顶栏菜单：注入到网页自身的 .topbar，不再悬浮覆盖标题。
     * 页面脚本异步构建外壳，所以找不到顶栏时短暂重试。
     */
    private static final String APP_MENU_JS = "(function(){"
            + "function install(){"
            + "var top=document.querySelector('.topbar');"
            + "if(!top){if(!window.__androidMenuTimer){window.__androidMenuTimer=setInterval(function(){"
            + "if(document.querySelector('.topbar')){clearInterval(window.__androidMenuTimer);"
            + "window.__androidMenuTimer=null;install();}},100);}return;}"
            + "if(document.getElementById('android-app-menu'))return;"
            // 按钮配色从网页端 CSS 变量取，跟着主题/深色模式一起变
            + "var cs=getComputedStyle(document.documentElement);"
            + "function tok(n,fb){var v=(cs.getPropertyValue(n)||'').trim();return v||fb;}"
            + "var brand=tok('--brand-600','#0D9488'),line=tok('--line','#E8ECF4'),card=tok('--card','#ffffff');"
            + "var b=document.createElement('button');b.type='button';"
            + "b.id='android-app-menu';b.className='android-app-menu';"
            + "b.setAttribute('aria-label','打开菜单');b.title='打开菜单';b.textContent='☰';"
            + "b.style.cssText='flex:0 0 32px;width:32px;height:32px;margin:0 10px 0 0;"
            + "padding:0;border:1px solid '+line+';border-radius:12px;background:'+card+';"
            + "color:'+brand+';font-size:18px;line-height:30px;text-align:center;"
            + "box-shadow:none;cursor:pointer;display:flex;align-items:center;"
            + "justify-content:center;';"
            + "b.addEventListener('click',function(e){e.preventDefault();e.stopPropagation();"
            + "if(window.AndroidBridge&&window.AndroidBridge.openDrawer)window.AndroidBridge.openDrawer();});"
            + "top.insertBefore(b,top.firstChild);"
            + "var brand=top.querySelector('.brand');if(brand){brand.style.minWidth='0';"
            + "brand.style.overflow='hidden';brand.style.whiteSpace='nowrap';"
            + "brand.style.textOverflow='ellipsis';brand.style.flex='1 1 auto';}"
            + "}install();})();";

    /**
     * 顶栏按钮嵌入 WebView 页面；登录页不显示，首页及各 hash 路由共用同一顶栏。
     */
    private void updateAppMenuLayout(String url) {
        boolean inApp = url != null && url.contains("index.html");
        if (!inApp) return;
        webView.postDelayed(() -> webView.evaluateJavascript(APP_MENU_JS, null), 80);
        syncAccentFromWeb();
    }

    /**
     * 拦截网页端"保存图片"（a.download=data:image/png）与长按日报图，交给原生相册保存。
     * 网页端原有下载逻辑不动：普通浏览器里仍是原生下载行为。
     */
    private static final String SAVE_HOOK_JS = "(function(){"
            + "if(window.__appSaveHookInstalled)return;window.__appSaveHookInstalled=1;"
            + "function bridge(u,n){try{window.AndroidBridge&&window.AndroidBridge.saveImage(u,n||'日报.png');}catch(e){}}"
            // 1) 保存图片按钮 = 程序化 a.click()，在这里拦截 data:image/png
            + "var oc=HTMLAnchorElement.prototype.click;"
            + "HTMLAnchorElement.prototype.click=function(){"
            + "try{if(this.getAttribute&&this.getAttribute('download')&&this.href&&this.href.indexOf('data:image/png')===0){"
            + "bridge(this.href,this.getAttribute('download'));return;}}catch(e){}"
            + "return oc.apply(this,arguments);};"
            // 2) 长按日报图片（.rp-export-img）600ms 保存
            + "var t=null,el=null;"
            + "document.addEventListener('touchstart',function(ev){t=null;el=null;"
            + "var n=ev.target;while(n&&n!==document.body){"
            + "if(n.classList&&n.classList.contains('rp-export-img')){el=n;break;}n=n.parentElement;}"
            + "if(el){var s=el;t=setTimeout(function(){bridge(s.src,'日报.png');t=null;},600);}},{passive:true});"
            + "document.addEventListener('touchmove',function(){if(t){clearTimeout(t);t=null;}},{passive:true});"
            + "document.addEventListener('touchend',function(){if(t){clearTimeout(t);t=null;}},{passive:true});"
            + "})();";

    private void installImageSaveHook() {
        // 兜底：个别 WebView 版本会把 a.download 的 data: URL 交给 DownloadListener
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            if (url != null && url.startsWith("data:image/png")) {
                callSaveImage(url, "日报.png");
            }
        });
    }

    /** 每个页面加载完注入保存钩子（幂等，重复注入无害） */
    private void injectSaveHook() {
        webView.evaluateJavascript(SAVE_HOOK_JS, null);
    }

    private void callSaveImage(String dataUrl, String fileName) {
        webView.evaluateJavascript(
                "window.AndroidBridge && window.AndroidBridge.saveImage('"
                        + escapeJs(dataUrl) + "','" + escapeJs(fileName) + "')",
                null);
    }

    private String escapeJs(String value) {
        return value.replace("\\", "\\\\").replace("'", "\\'");
    }

    /* ================= 主题配色 → 原生外壳 ================= */

    private String savedAccent() {
        String k = getSharedPreferences(PREFS, MODE_PRIVATE).getString(PREF_ACCENT, DEFAULT_ACCENT);
        return (k == null || k.length() == 0) ? DEFAULT_ACCENT : k;
    }

    /**
     * 把配色应用到原生外壳。认不出的 key 一律回落合宙青（不抛异常：
     * 配色是网页端决定的，Android 侧没跟上新预设时也只该退化成默认色）。
     */
    private void applyAccent(String key) {
        String[] hit = null;
        for (String[] a : ACCENTS) {
            if (a[0].equals(key)) { hit = a; break; }
        }
        if (hit == null) hit = ACCENTS[0];

        int deep = Color.parseColor(hit[1]);
        int main = Color.parseColor(hit[2]);
        int sub  = Color.parseColor(hit[3]);
        accentSoft = Color.parseColor(hit[4]);
        int aux  = Color.parseColor(hit[5]);

        // 1) 侧边栏头部：三档品牌渐变（原为写死的靛蓝 → 极光青）
        if (drawerHeader != null) {
            drawerHeader.setBackground(new GradientDrawable(
                    GradientDrawable.Orientation.TL_BR, new int[]{deep, main, aux}));
        }
        // 2) 头部副标题（原为写死的浅青 #CFFAF5）
        if (drawerHeaderSub != null) drawerHeaderSub.setTextColor(sub);
        // 3) 顶部加载进度条（原为写死的 #4F46E5）
        if (progressBar != null) {
            progressBar.setProgressTintList(ColorStateList.valueOf(main));
        }
        // 4) 菜单项按下/选中底（原为写死的 #F0FDFA）
        applyMenuItemTint(accentSoft);
    }

    private void applyMenuItemTint(int soft) {
        LinearLayout menuList = findViewById(R.id.menu_list);
        if (menuList == null) return;
        for (int i = 0; i < menuList.getChildCount(); i++) {
            menuList.getChildAt(i).setBackground(menuItemBg(soft));
        }
    }

    /** 菜单项背景：按下/选中 = 品牌浅底 + 12dp 圆角（对齐 Web 端 brand-50 / r-sm） */
    private Drawable menuItemBg(int soft) {
        StateListDrawable sl = new StateListDrawable();
        sl.addState(new int[]{android.R.attr.state_pressed}, roundRect(soft));
        sl.addState(new int[]{android.R.attr.state_selected}, roundRect(soft));
        sl.addState(new int[]{}, roundRect(0x00000000));
        return sl;
    }

    private Drawable roundRect(int color) {
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.RECTANGLE);
        g.setColor(color);
        g.setCornerRadius(dp(12));
        return g;
    }

    /** 版本号直接取 build.gradle 的 versionName，免得侧边栏写死的版本号和实际包脱节 */
    private String appVersionName() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).versionName;
        } catch (Exception e) {
            return "";
        }
    }

    /**
     * 从网页端 localStorage 兜底同步配色：用户可能在浏览器/网页里改过配色，
     * 那次改动不一定触发桥调用（比如更早版本、或桥被清）。
     */
    private void syncAccentFromWeb() {
        webView.evaluateJavascript(
                "(function(){try{return localStorage.getItem('pt_accent')||'" + DEFAULT_ACCENT
                        + "';}catch(e){return '" + DEFAULT_ACCENT + "';}})()",
                value -> {
                    String k = value == null ? "" : value.replace("\"", "").trim();
                    if (k.length() == 0) k = DEFAULT_ACCENT;
                    final String key = k;
                    runOnUiThread(() -> applyAccent(key));
                });
    }

    /** 动态构建侧边栏菜单项 */
    private void setupDrawerMenu() {
        LinearLayout menuList = findViewById(R.id.menu_list);
        for (String[] m : MENUS) {
            final String hash = m[1];
            TextView item = new TextView(this);
            item.setText(m[0]);
            item.setTextSize(15.5f);
            item.setTextColor(0xFF0B1220);
            item.setGravity(Gravity.CENTER_VERTICAL);
            item.setSingleLine(true);
            item.setPadding(dp(20), dp(14), dp(20), dp(14));
            item.setBackground(menuItemBg(accentSoft));   // 跟随当前配色，切色时整体重建
            // 左右留边，让 12dp 圆角背景可见（与 Web 端菜单项圆角一致）
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    LinearLayout.LayoutParams.MATCH_PARENT,
                    LinearLayout.LayoutParams.WRAP_CONTENT);
            lp.setMargins(dp(8), dp(2), dp(8), dp(2));
            item.setLayoutParams(lp);
            item.setOnClickListener(v -> {
                drawer.closeDrawers();
                navigate(hash);
            });
            menuList.addView(item);
        }
    }

    /** 保存日报图片到系统相册 */
    private class AndroidBridge {
        /**
         * 网页端切换配色时调用（js/theme.js 的 paint() 里）。
         * 原生外壳拿不到 WebView 的 CSS 变量，只能靠这条通知把侧边栏头部、
         * 进度条、菜单按下底一起换过来 —— 否则就是「Web 变了青，APP 侧栏还是靛蓝」。
         *
         * @param key 配色键，与 js/theme.js PRESETS 的 key 一致，如 "teal"
         */
        @JavascriptInterface
        public void setAccent(String key) {
            final String k = (key == null || key.length() == 0) ? DEFAULT_ACCENT : key;
            getSharedPreferences(PREFS, MODE_PRIVATE).edit()
                    .putString(PREF_ACCENT, k).apply();
            runOnUiThread(() -> applyAccent(k));
        }

        @JavascriptInterface
        public void openDrawer() {
            runOnUiThread(() -> {
                if (drawer != null) drawer.openDrawer(Gravity.START);
            });
        }

        /**
         * 报警消息推送（网页端 window.Push 调用）。
         * 注意：这是对 Object.notify() 的重载（参数不同），不是覆写。
         * WebView 不实现 Web Notification API，所以 APP 内推送只能走这里。
         *
         * @param hash 点击通知后要跳转的 hash 路由，如 "#/alerts"
         */
        @JavascriptInterface
        public void notify(String title, String body, String hash) {
            final String t = (title == null || title.length() == 0) ? "越界报警" : title;
            final String b = body == null ? "" : body;
            final String h = hash == null ? "" : hash;
            runOnUiThread(() -> showNotification(t, b, h));
        }

        /** 用户在网页端打开推送开关时调用，提前弹出系统授权（Android 13+） */
        @JavascriptInterface
        public void requestNotifyPermission() {
            runOnUiThread(() -> {
                if (Build.VERSION.SDK_INT >= 33 && !hasNotifyPermission()) {
                    requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY_PERM);
                }
            });
        }

        @JavascriptInterface
        public void saveImage(String dataUrl, String fileName) {
            new Thread(() -> {
                try {
                    String encoded = dataUrl.substring(dataUrl.indexOf(',') + 1);
                    byte[] bytes = Base64.decode(encoded, Base64.DEFAULT);
                    String safeName = (fileName == null || fileName.length() == 0)
                            ? "日报.png" : fileName.replaceAll("[^\\u4e00-\\u9fa5a-zA-Z0-9._-]", "_");
                    if (!safeName.toLowerCase().endsWith(".png")) safeName += ".png";

                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        ContentValues values = new ContentValues();
                        values.put(MediaStore.Images.Media.DISPLAY_NAME, safeName);
                        values.put(MediaStore.Images.Media.MIME_TYPE, "image/png");
                        values.put(MediaStore.Images.Media.RELATIVE_PATH,
                                Environment.DIRECTORY_PICTURES + "/合宙运动传感器");
                        values.put(MediaStore.Images.Media.IS_PENDING, 1);
                        Uri uri = getContentResolver().insert(
                                MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values);
                        if (uri == null) throw new IllegalStateException("无法创建相册文件");
                        try (OutputStream out = getContentResolver().openOutputStream(uri)) {
                            out.write(bytes);
                        }
                        values.clear();
                        values.put(MediaStore.Images.Media.IS_PENDING, 0);
                        getContentResolver().update(uri, values, null, null);
                    } else {
                        if (checkSelfPermission("android.permission.WRITE_EXTERNAL_STORAGE")
                                != PackageManager.PERMISSION_GRANTED) {
                            runOnUiThread(() -> requestPermissions(
                                    new String[]{"android.permission.WRITE_EXTERNAL_STORAGE"}, 12));
                            return;
                        }
                        File dir = new File(Environment.getExternalStoragePublicDirectory(
                                Environment.DIRECTORY_PICTURES), "合宙运动传感器");
                        if (!dir.exists() && !dir.mkdirs()) throw new IllegalStateException("无法创建相册目录");
                        File file = new File(dir, safeName);
                        try (FileOutputStream out = new FileOutputStream(file)) {
                            out.write(bytes);
                        }
                        MediaScannerConnection.scanFile(MainActivity.this,
                                new String[]{file.getAbsolutePath()}, new String[]{"image/png"}, null);
                    }
                    runOnUiThread(() -> Toast.makeText(MainActivity.this,
                            "日报图片已保存到相册", Toast.LENGTH_SHORT).show());
                } catch (Exception e) {
                    runOnUiThread(() -> Toast.makeText(MainActivity.this,
                            "保存图片失败", Toast.LENGTH_SHORT).show());
                }
            }).start();
        }
    }

    /** 跳转到指定 hash 路由：已登录则原地切 hash（不刷新），否则直接带 hash 打开首页 */
    private void navigate(String hash) {
        String url = webView.getUrl();
        if (url != null && url.contains("index.html")) {
            webView.evaluateJavascript("location.hash='" + hash + "';", null);
        } else {
            webView.loadUrl(indexUrl() + hash);
        }
    }

    /**
     * APK 版本变化后清一次 WebView 的 HTTP 缓存。
     * 网页部署在合宙平台上、不随 APK 一起更新，用户装了新版 APK 仍可能命中旧页面缓存
     * （表现为「网页明明改了，APP 里还是旧样式」）。只清 HTTP 缓存，绝不动 localStorage ——
     * 登录态和用户设置都存在里面。
     */
    private void clearStaleWebCache() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, MODE_PRIVATE);
            String now = appVersionName();
            if (now.length() == 0) return;
            if (!now.equals(sp.getString(PREF_WEB_VER, ""))) {
                webView.clearCache(true);
                sp.edit().putString(PREF_WEB_VER, now).apply();
            }
        } catch (Exception ignored) { /* 清缓存失败不应拦住启动 */ }
    }

    private int dp(int v) {
        return (int) (v * getResources().getDisplayMetrics().density + 0.5f);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    public void onBackPressed() {
        if (drawer != null && drawer.isDrawerOpen(Gravity.START)) {
            drawer.closeDrawers();
        } else if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
