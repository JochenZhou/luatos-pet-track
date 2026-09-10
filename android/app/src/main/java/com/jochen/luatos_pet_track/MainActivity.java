package com.jochen.luatos_pet_track;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.webkit.CookieManager;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.TextView;

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
