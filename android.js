/* Android APK build pipeline — auto-provisions JDK 17 + Android SDK, scaffolds and builds. */
import fs from "node:fs/promises";
import fss from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { runStream, IS_WIN } from "./shell.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const SDK_ROOT = process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), "android-sdk");
export const JDK_ROOT = process.env.NEXUS_JDK || path.join(os.homedir(), "jdk17");

const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
const CLT_URL = {
  linux: "https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip",
  darwin: "https://dl.google.com/android/repository/commandlinetools-mac-11076708_latest.zip",
  win32: "https://dl.google.com/android/repository/commandlinetools-win-11076708_latest.zip",
}[process.platform];

const JDK_URL = `https://api.adoptium.net/v3/binary/latest/17/ga/${
  process.platform === "win32" ? "windows" : process.platform === "darwin" ? "mac" : "linux"
}/x64/jdk/hotspot/normal/eclipse`;

/* ---------------- detection ---------------- */
function findJdk() {
  if (fss.existsSync(path.join(JDK_ROOT, "bin", IS_WIN ? "javac.exe" : "javac"))) return JDK_ROOT;
  const cands = [process.env.JAVA_HOME].filter(Boolean);
  if (process.platform === "linux") {
    try {
      for (const d of fss.readdirSync("/usr/lib/jvm")) {
        if (/(1[7-9]|2[0-9])/.test(d)) cands.push(path.join("/usr/lib/jvm", d));
      }
    } catch {}
  }
  return cands.find((c) => c && fss.existsSync(path.join(c, "bin", IS_WIN ? "javac.exe" : "javac"))) || null;
}

async function javaMajor(home) {
  if (!home) return 0;
  const r = await runStream(`${q(path.join(home, "bin", "java"))} -version`, { timeout: 25 });
  const m = /version "(\d+)/.exec(r.stderr + r.stdout);
  return m ? Number(m[1]) : 0;
}

export async function status() {
  const jdk = findJdk();
  const major = await javaMajor(jdk);
  const sdkmanager = path.join(SDK_ROOT, "cmdline-tools", "latest", "bin", IS_WIN ? "sdkmanager.bat" : "sdkmanager");
  return {
    jdk, jdkVersion: major, jdkOk: major >= 17,
    sdkRoot: SDK_ROOT,
    sdkInstalled: fss.existsSync(sdkmanager),
    platformsInstalled: fss.existsSync(path.join(SDK_ROOT, "platforms")),
    buildTools: fss.existsSync(path.join(SDK_ROOT, "build-tools")),
    ready: major >= 17 && fss.existsSync(path.join(SDK_ROOT, "platforms")),
  };
}

/** Env every gradle/sdk command needs. */
function envFor(jdk) {
  return {
    JAVA_HOME: jdk,
    ANDROID_HOME: SDK_ROOT,
    ANDROID_SDK_ROOT: SDK_ROOT,
    PATH: [path.join(jdk, "bin"), path.join(SDK_ROOT, "platform-tools"),
           path.join(SDK_ROOT, "cmdline-tools", "latest", "bin"), process.env.PATH].join(path.delimiter),
  };
}

/* ---------------- provisioning ---------------- */
export async function installJdk(onLog = () => {}) {
  const existing = findJdk();
  if (await javaMajor(existing) >= 17) { onLog(`JDK 17+ already present at ${existing}\n`); return { ok: true, path: existing }; }
  onLog("Downloading JDK 17 (~180 MB)…\n");
  await fs.mkdir(JDK_ROOT, { recursive: true });
  const tgz = path.join(os.tmpdir(), "jdk17.tar.gz");
  let r = await runStream(`curl -sL ${q(JDK_URL)} -o ${q(tgz)}`, { timeout: 900, onData: ({ text }) => onLog(text) });
  if (r.code !== 0) return { ok: false, error: "download failed" };
  onLog("Extracting…\n");
  r = await runStream(`tar -xzf ${q(tgz)} -C ${q(JDK_ROOT)} --strip-components=1`, { timeout: 600 });
  await fs.rm(tgz, { force: true });
  const v = await javaMajor(JDK_ROOT);
  onLog(v >= 17 ? `JDK ${v} ready.\n` : "JDK install failed.\n");
  return v >= 17 ? { ok: true, path: JDK_ROOT } : { ok: false, error: r.stderr?.slice(-400) };
}

export async function installSdk(onLog = () => {}) {
  const jdkRes = await installJdk(onLog);
  if (!jdkRes.ok) return { ok: false, error: "JDK 17 required: " + jdkRes.error };
  const jdk = jdkRes.path;
  const clt = path.join(SDK_ROOT, "cmdline-tools", "latest");

  if (!fss.existsSync(path.join(clt, "bin"))) {
    onLog("Downloading Android command-line tools (~150 MB)…\n");
    await fs.mkdir(path.join(SDK_ROOT, "cmdline-tools"), { recursive: true });
    const zip = path.join(os.tmpdir(), "clt.zip");
    let r = await runStream(`curl -sL ${q(CLT_URL)} -o ${q(zip)}`, { timeout: 1200, onData: ({ text }) => onLog(text) });
    if (r.code !== 0) return { ok: false, error: "cmdline-tools download failed" };
    onLog("Extracting…\n");
    await runStream(`cd ${q(path.join(SDK_ROOT, "cmdline-tools"))} && unzip -oq ${q(zip)}`, { timeout: 600 });
    // the zip extracts to ./cmdline-tools — SDK expects ./latest
    const extracted = path.join(SDK_ROOT, "cmdline-tools", "cmdline-tools");
    if (fss.existsSync(extracted)) await fs.rename(extracted, clt);
    await fs.rm(zip, { force: true });
  }

  const env = envFor(jdk);
  const sm = path.join(clt, "bin", IS_WIN ? "sdkmanager.bat" : "sdkmanager");
  onLog("Accepting licenses…\n");
  await runStream(IS_WIN ? `echo y| ${q(sm)} --licenses` : `yes | ${q(sm)} --licenses`,
    { timeout: 600, env, onData: ({ text }) => onLog(text.slice(0, 200)) });

  onLog("Installing platform-tools, android-34, build-tools 34…\n");
  const r = await runStream(
    `${q(sm)} "platform-tools" "platforms;android-34" "build-tools;34.0.0"`,
    { timeout: 2400, env, onData: ({ text }) => onLog(text) });

  const st = await status();
  onLog(st.ready ? "\nAndroid SDK ready.\n" : "\nSDK install incomplete.\n");
  return st.ready ? { ok: true, ...st } : { ok: false, error: (r.stderr || r.stdout || "").slice(-800) };
}

/* ---------------- scaffolding ---------------- */
const GRADLE_WRAPPER_PROPS = `distributionBase=GRADLE_USER_HOME
distributionPath=wrapper/dists
distributionUrl=https\\://services.gradle.org/distributions/gradle-8.7-bin.zip
zipStoreBase=GRADLE_USER_HOME
zipStorePath=wrapper/dists
`;

/** Minimal, dependency-light Android app that reliably builds offline-ish. */
export async function scaffold({ dir, appName = "MyApp", pkg = "com.nexus.myapp", kind = "webview", url = "", html = "" }) {
  const pkgPath = pkg.replace(/\./g, "/");
  const w = async (rel, content) => {
    const f = path.join(dir, rel);
    await fs.mkdir(path.dirname(f), { recursive: true });
    await fs.writeFile(f, content, "utf8");
  };

  await w("settings.gradle", `pluginManagement {
  repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
  repositoriesMode.set(RepositoriesMode.PREFER_SETTINGS)
  repositories { google(); mavenCentral() }
}
rootProject.name = "${appName}"
include ":app"
`);

  await w("build.gradle", `plugins {
  id 'com.android.application' version '8.5.0' apply false
}
`);

  await w("gradle.properties", `org.gradle.jvmargs=-Xmx2048m
android.useAndroidX=true
android.nonTransitiveRClass=true
org.gradle.parallel=true
`);

  await w("gradle/wrapper/gradle-wrapper.properties", GRADLE_WRAPPER_PROPS);

  await w("app/build.gradle", `plugins { id 'com.android.application' }

android {
  namespace '${pkg}'
  compileSdk 34

  defaultConfig {
    applicationId "${pkg}"
    minSdk 24
    targetSdk 34
    versionCode 1
    versionName "1.0"
  }

  buildTypes {
    release {
      minifyEnabled false
      signingConfig signingConfigs.debug   // debug-signed so it installs directly
    }
  }
  compileOptions {
    sourceCompatibility JavaVersion.VERSION_17
    targetCompatibility JavaVersion.VERSION_17
  }
}

configurations.all {
  // appcompat pulls kotlin-stdlib-jdk8 1.6.21 which duplicates classes in kotlin-stdlib 1.8+
  resolutionStrategy {
    force 'org.jetbrains.kotlin:kotlin-stdlib:1.8.22'
    eachDependency { d ->
      if (d.requested.group == 'org.jetbrains.kotlin' &&
          (d.requested.name == 'kotlin-stdlib-jdk8' || d.requested.name == 'kotlin-stdlib-jdk7')) {
        d.useTarget "org.jetbrains.kotlin:kotlin-stdlib:1.8.22"
      }
    }
  }
}

dependencies {
  implementation 'androidx.appcompat:appcompat:1.7.0'
}
`);

  const usesInternet = kind === "webview" && url;
  await w("app/src/main/AndroidManifest.xml", `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
${usesInternet ? '    <uses-permission android:name="android.permission.INTERNET" />\n' : ""}
    <application
        android:allowBackup="true"
        android:icon="@mipmap/ic_launcher"
        android:label="${appName}"
        android:theme="@style/Theme.AppCompat.DayNight.NoActionBar"
        android:usesCleartextTraffic="true">
        <activity android:name=".MainActivity" android:exported="true">
            <intent-filter>
                <action android:name="android.intent.action.MAIN" />
                <category android:name="android.intent.category.LAUNCHER" />
            </intent-filter>
        </activity>
    </application>
</manifest>
`);

  if (kind === "webview") {
    const load = url
      ? `w.loadUrl("${url}");`
      : `w.loadUrl("file:///android_asset/index.html");`;
    await w(`app/src/main/java/${pkgPath}/MainActivity.java`, `package ${pkg};

import android.annotation.SuppressLint;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {
    private WebView w;

    @SuppressLint("SetJavaScriptEnabled")
    @Override protected void onCreate(Bundle s) {
        super.onCreate(s);
        w = new WebView(this);
        WebSettings set = w.getSettings();
        set.setJavaScriptEnabled(true);
        set.setDomStorageEnabled(true);
        w.setWebViewClient(new WebViewClient());
        setContentView(w);
        ${load}
    }

    @Override public void onBackPressed() {
        if (w != null && w.canGoBack()) w.goBack(); else super.onBackPressed();
    }
}
`);
    if (!url) {
      await w("app/src/main/assets/index.html", html || `<!DOCTYPE html>
<html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{margin:0;font:16px system-ui;background:#0b0d14;color:#eef1f8;
display:grid;place-items:center;height:100vh}h1{font-size:26px}</style></head>
<body><div><h1>${appName}</h1><p>Built by NEXUS.</p></div></body></html>`);
    }
  } else {
    await w(`app/src/main/java/${pkgPath}/MainActivity.java`, `package ${pkg};

import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.widget.LinearLayout;
import android.widget.TextView;
import androidx.appcompat.app.AppCompatActivity;

public class MainActivity extends AppCompatActivity {
    @Override protected void onCreate(Bundle s) {
        super.onCreate(s);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(Color.parseColor("#0b0d14"));
        TextView t = new TextView(this);
        t.setText("${appName}");
        t.setTextSize(28);
        t.setTextColor(Color.parseColor("#eef1f8"));
        t.setGravity(Gravity.CENTER);
        root.addView(t);
        setContentView(root);
    }
}
`);
  }

  // launcher icon (simple valid adaptive-free PNG-less fallback via vector)
  await w("app/src/main/res/mipmap-anydpi-v26/ic_launcher.xml", `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon xmlns:android="http://schemas.android.com/apk/res/android">
    <background android:drawable="@color/ic_bg"/>
    <foreground android:drawable="@drawable/ic_fg"/>
</adaptive-icon>
`);
  await w("app/src/main/res/values/colors.xml", `<?xml version="1.0" encoding="utf-8"?>
<resources><color name="ic_bg">#6D7CFF</color></resources>
`);
  await w("app/src/main/res/drawable/ic_fg.xml", `<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp" android:height="108dp"
    android:viewportWidth="108" android:viewportHeight="108">
  <path android:fillColor="#FFFFFF"
        android:pathData="M54,30 L74,54 L54,78 L34,54 Z"/>
</vector>
`);
  return `Scaffolded Android project at ${dir}`;
}

/* ---------------- build ---------------- */
export async function build({ dir, variant = "debug" }, onLog = () => {}) {
  const st = await status();
  if (!st.jdkOk) return { ok: false, error: "JDK 17+ not installed. Run android_setup first." };
  if (!st.platformsInstalled) return { ok: false, error: "Android SDK not installed. Run android_setup first." };

  const env = envFor(st.jdk);
  await fs.writeFile(path.join(dir, "local.properties"), `sdk.dir=${SDK_ROOT.replace(/\\/g, "\\\\")}\n`, "utf8");

  // bootstrap the wrapper if the project has none
  const wrapper = path.join(dir, IS_WIN ? "gradlew.bat" : "gradlew");
  if (!fss.existsSync(wrapper)) {
    onLog("Bootstrapping Gradle wrapper (first run downloads Gradle ~130 MB)…\n");
    const g = await runStream("gradle wrapper --gradle-version 8.7", { cwd: dir, timeout: 1800, env, onData: ({ text }) => onLog(text) });
    if (g.code !== 0) {
      onLog("No system gradle; downloading distribution directly…\n");
      const gz = path.join(os.tmpdir(), "gradle.zip");
      await runStream(`curl -sL https://services.gradle.org/distributions/gradle-8.7-bin.zip -o ${q(gz)}`,
        { timeout: 1800, onData: ({ text }) => onLog(text) });
      const gdir = path.join(os.homedir(), "gradle-dist");
      await fs.mkdir(gdir, { recursive: true });
      await runStream(`unzip -oq ${q(gz)} -d ${q(gdir)}`, { timeout: 900 });
      await fs.rm(gz, { force: true });
      const gbin = path.join(gdir, "gradle-8.7", "bin", "gradle");
      const g2 = await runStream(`${q(gbin)} wrapper --gradle-version 8.7`, { cwd: dir, timeout: 1800, env, onData: ({ text }) => onLog(text) });
      if (g2.code !== 0) return { ok: false, error: "could not create gradle wrapper: " + (g2.stderr || "").slice(-500) };
    }
  }

  const task = variant === "release" ? "assembleRelease" : "assembleDebug";
  onLog(`Running ./gradlew ${task} …\n`);
  const r = await runStream(`${IS_WIN ? "gradlew.bat" : "./gradlew"} ${task} --no-daemon --console=plain`,
    { cwd: dir, timeout: 2700, env, onData: ({ text }) => onLog(text) });

  const outDir = path.join(dir, "app", "build", "outputs", "apk", variant);
  let apk = null;
  try {
    const files = await fs.readdir(outDir);
    const f = files.find((x) => x.endsWith(".apk"));
    if (f) apk = path.join(outDir, f);
  } catch {}

  if (!apk) {
    const tail = (r.stdout + "\n" + r.stderr).slice(-2500);
    return { ok: false, error: `Build failed (exit ${r.code}).\n${tail}` };
  }
  const size = (await fs.stat(apk)).size;
  return { ok: true, apk, sizeMB: +(size / 1e6).toFixed(2) };
}

/** Install onto a connected device / emulator. */
export async function install(apk, onLog = () => {}) {
  const st = await status();
  const adb = path.join(SDK_ROOT, "platform-tools", IS_WIN ? "adb.exe" : "adb");
  if (!fss.existsSync(adb)) return "adb not installed — run android_setup first.";
  const env = envFor(st.jdk || "");
  const dev = await runStream(`${q(adb)} devices`, { timeout: 40, env });
  if (!/\n\w+\s+device/.test(dev.stdout || "")) {
    return `No device connected. Plug in a phone with USB debugging on, or start an emulator.\n${dev.stdout || ""}`;
  }
  const r = await runStream(`${q(adb)} install -r ${q(apk)}`, { timeout: 300, env, onData: ({ text }) => onLog(text) });
  return r.code === 0 ? `Installed ${path.basename(apk)} on device.` : `Install failed:\n${(r.stderr || r.stdout).slice(-600)}`;
}
