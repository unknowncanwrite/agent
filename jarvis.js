/* JARVIS — OS-level control layer (Windows / macOS / Linux) */
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import { runStream, IS_WIN, HOME } from "./shell.js";

export const IS_MAC = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

const q = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
const ps = (script) => `powershell -NoProfile -ExecutionPolicy Bypass -Command ${q(script)}`;
const osa = (script) => `osascript -e ${q(script)}`;

/** Common user folders, resolved per-platform. */
export function places() {
  const p = {
    home: HOME,
    desktop: path.join(HOME, "Desktop"),
    documents: path.join(HOME, "Documents"),
    downloads: path.join(HOME, "Downloads"),
    pictures: path.join(HOME, "Pictures"),
    music: path.join(HOME, "Music"),
    videos: path.join(HOME, IS_WIN ? "Videos" : "Movies"),
  };
  if (IS_WIN) {
    p.appdata = process.env.APPDATA || path.join(HOME, "AppData/Roaming");
    p.localappdata = process.env.LOCALAPPDATA || path.join(HOME, "AppData/Local");
    p.startup = path.join(p.appdata, "Microsoft/Windows/Start Menu/Programs/Startup");
    p.programfiles = process.env.ProgramFiles || "C:/Program Files";
  }
  return p;
}

/* ---------------- Apps ---------------- */
export async function openApp(name, args = "") {
  let cmd;
  if (IS_WIN) cmd = `Start-Process ${q(name)}${args ? ` -ArgumentList ${q(args)}` : ""}`;
  else if (IS_MAC) cmd = `open -a ${q(name)} ${args}`;
  else cmd = `(setsid ${name} ${args} >/dev/null 2>&1 &) ; echo launched`;
  const r = await runStream(IS_WIN ? ps(cmd) : cmd, { timeout: 25 });
  return r.code === 0 ? `Launched ${name}` : `Failed: ${(r.stderr || r.stdout).slice(0, 400)}`;
}

export async function openPath(target) {
  const cmd = IS_WIN ? ps(`Invoke-Item ${q(target)}`) : IS_MAC ? `open ${q(target)}` : `xdg-open ${q(target)}`;
  const r = await runStream(cmd, { timeout: 20 });
  return r.code === 0 ? `Opened ${target}` : `Failed: ${(r.stderr || "").slice(0, 300)}`;
}

export async function closeApp(name) {
  const cmd = IS_WIN
    ? ps(`Get-Process ${q(name.replace(/\.exe$/i, ""))} -ErrorAction SilentlyContinue | Stop-Process -Force; echo done`)
    : IS_MAC ? osa(`quit app ${q(name)}`)
    : `pkill -f ${q(name)} || true`;
  const r = await runStream(cmd, { timeout: 20 });
  return r.code === 0 ? `Closed ${name}` : `Could not close ${name}: ${(r.stderr || "").slice(0, 300)}`;
}

export async function listApps() {
  const cmd = IS_WIN
    ? ps("Get-Process | Where-Object {$_.MainWindowTitle -ne ''} | Select-Object ProcessName,Id,MainWindowTitle | ConvertTo-Json -Compress")
    : IS_MAC ? osa('tell application "System Events" to get name of (every process whose background only is false)')
    : `wmctrl -l 2>/dev/null || ps -eo comm= --sort=-%mem | head -25`;
  const r = await runStream(cmd, { timeout: 25 });
  return (r.stdout || r.stderr || "(none)").slice(0, 4000);
}

/* ---------------- Clipboard ---------------- */
export async function clipRead() {
  const cmd = IS_WIN ? ps("Get-Clipboard -Raw") : IS_MAC ? "pbpaste" : "xclip -selection clipboard -o 2>/dev/null || wl-paste 2>/dev/null";
  const r = await runStream(cmd, { timeout: 15 });
  return (r.stdout || "").slice(0, 20000) || "(clipboard empty or unavailable)";
}
export async function clipWrite(text) {
  if (IS_WIN) {
    const tmp = path.join(os.tmpdir(), `clip-${Date.now()}.txt`);
    await fs.writeFile(tmp, text, "utf8");
    const r = await runStream(ps(`Get-Content -Raw ${q(tmp)} | Set-Clipboard`), { timeout: 15 });
    await fs.rm(tmp, { force: true });
    return r.code === 0 ? "Copied to clipboard" : "Clipboard write failed";
  }
  const tmp = path.join(os.tmpdir(), `clip-${Date.now()}.txt`);
  await fs.writeFile(tmp, text, "utf8");
  const cmd = IS_MAC ? `pbcopy < ${q(tmp)}` : `(xclip -selection clipboard < ${q(tmp)} 2>/dev/null || wl-copy < ${q(tmp)})`;
  const r = await runStream(cmd, { timeout: 15 });
  await fs.rm(tmp, { force: true });
  return r.code === 0 ? "Copied to clipboard" : "Clipboard write failed";
}

/* ---------------- Notifications & speech ---------------- */
export async function notify(title, message) {
  const cmd = IS_WIN
    ? ps(`[reflection.assembly]::loadwithpartialname('System.Windows.Forms')|Out-Null;` +
         `$n=New-Object System.Windows.Forms.NotifyIcon;` +
         `$n.Icon=[System.Drawing.SystemIcons]::Information;$n.Visible=$true;` +
         `$n.ShowBalloonTip(6000,${q(title)},${q(message)},'Info');Start-Sleep 6`)
    : IS_MAC ? osa(`display notification ${q(message)} with title ${q(title)}`)
    : `notify-send ${q(title)} ${q(message)}`;
  const r = await runStream(cmd, { timeout: 20 });
  return r.code === 0 ? "Notification sent" : "Notification failed (may need a desktop session)";
}

export async function speak(text) {
  const cmd = IS_WIN
    ? ps(`Add-Type -AssemblyName System.Speech;(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak(${q(text)})`)
    : IS_MAC ? `say ${q(text)}`
    : `(espeak ${q(text)} 2>/dev/null || spd-say ${q(text)} 2>/dev/null)`;
  const r = await runStream(cmd, { timeout: 60 });
  return r.code === 0 ? `Spoke: "${text.slice(0, 80)}"` : "Text-to-speech unavailable";
}

/* ---------------- Screen ---------------- */
export async function screenGrab(outFile) {
  const f = outFile || path.join(os.tmpdir(), `screen-${Date.now()}.png`);
  const cmd = IS_WIN
    ? ps(`Add-Type -AssemblyName System.Windows.Forms,System.Drawing;` +
         `$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;` +
         `$bmp=New-Object System.Drawing.Bitmap $b.Width,$b.Height;` +
         `$g=[System.Drawing.Graphics]::FromImage($bmp);` +
         `$g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size);` +
         `$bmp.Save(${q(f)},[System.Drawing.Imaging.ImageFormat]::Png)`)
    : IS_MAC ? `screencapture -x ${q(f)}`
    : `(import -window root ${q(f)} 2>/dev/null || gnome-screenshot -f ${q(f)} 2>/dev/null || scrot ${q(f)} 2>/dev/null || grim ${q(f)} 2>/dev/null)`;
  const r = await runStream(cmd, { timeout: 40 });
  try { await fs.access(f); return { ok: true, file: f }; }
  catch { return { ok: false, error: (r.stderr || "screenshot tool unavailable").slice(0, 300) }; }
}

/* ---------------- System state ---------------- */
export async function volume(action, level) {
  let cmd;
  if (IS_WIN) {
    const keys = { up: 175, down: 174, mute: 173 };
    if (action === "set" && level != null) {
      cmd = ps(`$w=New-Object -ComObject WScript.Shell;1..50|%{$w.SendKeys([char]174)};1..${Math.round(level / 2)}|%{$w.SendKeys([char]175)}`);
    } else cmd = ps(`$w=New-Object -ComObject WScript.Shell;$w.SendKeys([char]${keys[action] ?? 173})`);
  } else if (IS_MAC) {
    cmd = action === "set" ? osa(`set volume output volume ${level}`)
      : action === "mute" ? osa("set volume output muted true")
      : osa(`set volume output volume (output volume of (get volume settings) ${action === "up" ? "+" : "-"} 10)`);
  } else {
    cmd = action === "set" ? `amixer -q sset Master ${level}%`
      : action === "mute" ? "amixer -q sset Master toggle"
      : `amixer -q sset Master 10%${action === "up" ? "+" : "-"}`;
  }
  const r = await runStream(cmd, { timeout: 20 });
  return r.code === 0 ? `Volume ${action}${level != null ? " " + level : ""}` : "Volume control unavailable";
}

export async function power(action) {
  const map = {
    lock: IS_WIN ? "rundll32.exe user32.dll,LockWorkStation"
      : IS_MAC ? osa('tell application "System Events" to keystroke "q" using {control down, command down}')
      : "(loginctl lock-session || xdg-screensaver lock)",
    sleep: IS_WIN ? ps("[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');[System.Windows.Forms.Application]::SetSuspendState('Suspend',$false,$true)")
      : IS_MAC ? osa('tell application "System Events" to sleep')
      : "systemctl suspend",
    shutdown: IS_WIN ? "shutdown /s /t 30" : IS_MAC ? osa('tell application "System Events" to shut down') : "shutdown -h +1",
    restart: IS_WIN ? "shutdown /r /t 30" : IS_MAC ? osa('tell application "System Events" to restart') : "shutdown -r +1",
    cancel: IS_WIN ? "shutdown /a" : "shutdown -c",
  };
  if (!map[action]) return `Unknown power action: ${action}`;
  const r = await runStream(map[action], { timeout: 25 });
  const note = /shutdown|restart/.test(action) ? " (scheduled with a delay — use power cancel to abort)" : "";
  return r.code === 0 ? `Power: ${action}${note}` : `Failed: ${(r.stderr || "").slice(0, 300)}`;
}

export async function stats() {
  let cmd;
  if (IS_WIN) {
    cmd = ps("$os=Get-CimInstance Win32_OperatingSystem;" +
      "$cpu=(Get-CimInstance Win32_Processor|Measure-Object -Property LoadPercentage -Average).Average;" +
      "$d=Get-PSDrive -PSProvider FileSystem|Select-Object Name,@{n='FreeGB';e={[math]::Round($_.Free/1GB,1)}},@{n='UsedGB';e={[math]::Round($_.Used/1GB,1)}};" +
      "@{cpuPercent=$cpu;memFreeGB=[math]::Round($os.FreePhysicalMemory/1MB,1);memTotalGB=[math]::Round($os.TotalVisibleMemorySize/1MB,1);drives=$d}|ConvertTo-Json -Depth 4 -Compress");
  } else if (IS_MAC) {
    cmd = `echo "{\\"load\\":\\"$(uptime | sed 's/.*averages*: //')\\",\\"disk\\":\\"$(df -h / | tail -1 | awk '{print $4" free of "$2}')\\",\\"battery\\":\\"$(pmset -g batt | grep -o '[0-9]*%' | head -1)\\"}"`;
  } else {
    cmd = `echo "{\\"load\\":\\"$(cat /proc/loadavg | cut -d' ' -f1-3)\\",\\"mem\\":\\"$(free -h | awk '/Mem:/{print $3" used of "$2}')\\",\\"disk\\":\\"$(df -h / | tail -1 | awk '{print $4" free of "$2}')\\"}"`;
  }
  const r = await runStream(cmd, { timeout: 25 });
  const base = {
    platform: process.platform, host: os.hostname(), uptimeHours: +(os.uptime() / 3600).toFixed(1),
    cores: os.cpus()?.length, totalMemGB: +(os.totalmem() / 1e9).toFixed(1),
    freeMemGB: +(os.freemem() / 1e9).toFixed(1), user: os.userInfo().username,
  };
  return JSON.stringify({ ...base, detail: (r.stdout || "").trim().slice(0, 2000) }, null, 2);
}

/* ---------------- Everything-search ---------------- */
export async function findFiles(pattern, root, limit = 60) {
  const base = root || HOME;
  const cmd = IS_WIN
    ? ps(`Get-ChildItem -Path ${q(base)} -Filter ${q(pattern)} -Recurse -File -ErrorAction SilentlyContinue | Select-Object -First ${limit} -ExpandProperty FullName`)
    : `find ${q(base)} -iname ${q(pattern)} -not -path '*/node_modules/*' -not -path '*/.git/*' 2>/dev/null | head -${limit}`;
  const r = await runStream(cmd, { timeout: 90 });
  return (r.stdout || "").trim() || "No matches.";
}

/* ---------------- Scheduling ---------------- */
export async function schedule(name, command, when) {
  if (IS_WIN) {
    const r = await runStream(
      `schtasks /Create /TN ${q("NEXUS_" + name)} /TR ${q(command)} /SC ONCE /ST ${when} /F`, { timeout: 25 });
    return r.code === 0 ? `Scheduled "${name}" at ${when}` : (r.stderr || r.stdout).slice(0, 400);
  }
  const r = await runStream(`(crontab -l 2>/dev/null; echo "${when} ${command} # NEXUS_${name}") | crontab -`, { timeout: 25 });
  return r.code === 0 ? `Scheduled "${name}" (${when})` : (r.stderr || "").slice(0, 400);
}
export async function listScheduled() {
  const r = await runStream(IS_WIN ? `schtasks /Query /FO LIST | findstr /C:"NEXUS_"` : `crontab -l 2>/dev/null | grep NEXUS_ || echo "(none)"`, { timeout: 25 });
  return (r.stdout || "(none)").slice(0, 3000);
}
export async function unschedule(name) {
  const r = await runStream(
    IS_WIN ? `schtasks /Delete /TN ${q("NEXUS_" + name)} /F`
           : `crontab -l 2>/dev/null | grep -v "NEXUS_${name}" | crontab -`, { timeout: 25 });
  return r.code === 0 ? `Removed "${name}"` : (r.stderr || "").slice(0, 300);
}

/* ---------------- Input automation ---------------- */
export async function typeText(text) {
  const cmd = IS_WIN
    ? ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait(${q(text.replace(/([+^%~(){}])/g, "{$1}"))})`)
    : IS_MAC ? osa(`tell application "System Events" to keystroke ${q(text)}`)
    : `xdotool type --delay 25 ${q(text)}`;
  const r = await runStream(cmd, { timeout: 40 });
  return r.code === 0 ? `Typed ${text.length} chars` : "Input automation unavailable";
}
export async function pressKeys(keys) {
  const cmd = IS_WIN
    ? ps(`Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait(${q(keys)})`)
    : IS_MAC ? osa(`tell application "System Events" to key code ${keys}`)
    : `xdotool key ${keys}`;
  const r = await runStream(cmd, { timeout: 25 });
  return r.code === 0 ? `Pressed ${keys}` : "Key automation unavailable";
}
