from pathlib import Path

root = Path(__file__).parent
java = (root / "android/app/src/main/java/com/jochen/luatos_pet_track/MainActivity.java").read_text()
manifest = (root / "android/app/src/main/AndroidManifest.xml").read_text()

checks = {
    "注册 AndroidBridge": 'addJavascriptInterface(new AndroidBridge(), "AndroidBridge")' in java,
    "桥接提供 saveImage": '@JavascriptInterface' in java and 'void saveImage(String dataUrl, String fileName)' in java,
    "注入 data URL 下载接管": "HTMLAnchorElement.prototype.click" in java and "data:image/png" in java,
    "支持长按日报图片": "touchstart" in java and "rp-export-img" in java,
    "Android 10+ 写入 MediaStore": "MediaStore.Images.Media.EXTERNAL_CONTENT_URI" in java and "RELATIVE_PATH" in java,
    "Android 9- 写入 Pictures": "Environment.DIRECTORY_PICTURES" in java and "MediaScannerConnection.scanFile" in java,
    "旧版相册权限": 'android.permission.WRITE_EXTERNAL_STORAGE' in manifest and 'maxSdkVersion="28"' in manifest,
}

failed = [name for name, ok in checks.items() if not ok]
for name, ok in checks.items():
    print(("PASS" if ok else "FAIL") + " - " + name)
if failed:
    raise SystemExit("\n未满足: " + "、".join(failed))
print(f"\n全部通过: {len(checks)}/{len(checks)}")
