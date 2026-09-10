package com.jochen.luatos_pet_track;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.content.pm.PackageManager;
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

    private static final String LOGIN_URL =
            "https://iot.luatos.com/ai_app/luatos/pet_track_jochen/login.html";
    private static final String INDEX_URL =
            "https://iot.luatos.com/ai_app/luatos/pet_track_jochen/index.html";

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

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        webView = findViewById(R.id.webview);
        progressBar = findViewById(R.id.progress);
        drawer = findViewById(R.id.drawer);

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

        findViewById(R.id.btn_menu).setOnClickListener(v -> drawer.openDrawer(Gravity.START));

        if (savedInstanceState != null) {
            webView.restoreState(savedInstanceState);
        } else {
            webView.loadUrl(LOGIN_URL);
        }
    }

    /**
     * 原生按钮覆盖在 WebView 上层，因此首页顶栏必须为它预留左侧空间。
     * 登录页不显示按钮；进入 index.html 后显示按钮并把网页标题向右推 62dp。
     */
    private void updateAppMenuLayout(String url) {
        TextView menu = findViewById(R.id.btn_menu);
        if (menu == null || webView == null) return;
        boolean inApp = url != null && url.contains("index.html");
        menu.setVisibility(inApp ? View.VISIBLE : View.GONE);
        if (!inApp) return;

        final int inset = 62;
        webView.postDelayed(() -> webView.evaluateJavascript(
                "(function(){var e=document.querySelector('.topbar');"
                        + "if(e){e.style.paddingLeft='" + inset + "px';}"
                        + "var b=document.querySelector('.brand');"
                        + "if(b){b.style.minWidth='0';b.style.overflow='hidden';"
                        + "b.style.whiteSpace='nowrap';b.style.textOverflow='ellipsis';}"
                        + "})();", null), 80);
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

    /** 动态构建侧边栏菜单项 */
    private void setupDrawerMenu() {
        LinearLayout menuList = findViewById(R.id.menu_list);
        for (String[] m : MENUS) {
            final String hash = m[1];
            TextView item = new TextView(this);
            item.setText(m[0]);
            item.setTextSize(16);
            item.setTextColor(0xFF1F2937);
            item.setGravity(Gravity.CENTER_VERTICAL);
            item.setSingleLine(true);
            item.setPadding(dp(20), dp(15), dp(20), dp(15));
            item.setBackgroundResource(R.drawable.menu_item_bg);
            item.setOnClickListener(v -> {
                drawer.closeDrawers();
                navigate(hash);
            });
            menuList.addView(item);
        }
    }

    /** 保存日报图片到系统相册 */
    private class AndroidBridge {
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
            webView.loadUrl(INDEX_URL + hash);
        }
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
