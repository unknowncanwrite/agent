#!/usr/bin/env python3
"""
NEXUS OS-control sidecar — human-like desktop control.
Speaks newline-delimited JSON on stdin/stdout so Node can drive it.

Requires: pip install pyautogui pillow
Optional: pip install opencv-python  (for image-based find/click)
"""
import sys, json, base64, io, time, os

def out(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()

try:
    import pyautogui
    pyautogui.FAILSAFE = True          # slam mouse to a corner to abort
    pyautogui.PAUSE = 0.05
    HAVE = True
    ERR = None
except Exception as e:                  # noqa
    HAVE = False
    ERR = str(e)

try:
    import cv2  # noqa
    HAVE_CV = True
except Exception:
    HAVE_CV = False


def need():
    if not HAVE:
        raise RuntimeError(
            f"pyautogui unavailable: {ERR}. Install with: pip install pyautogui pillow"
        )


def shot(region=None, scale=0.5):
    """Screenshot -> base64 png (downscaled to keep vision tokens sane)."""
    need()
    img = pyautogui.screenshot(region=tuple(region) if region else None)
    if scale and scale != 1:
        img = img.resize((max(1, int(img.width * scale)), max(1, int(img.height * scale))))
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=True)
    return base64.b64encode(buf.getvalue()).decode()


HANDLERS = {}
def cmd(name):
    def deco(fn):
        HANDLERS[name] = fn
        return fn
    return deco


@cmd("ping")
def _ping(a):
    return {
        "ok": HAVE, "error": ERR, "cv": HAVE_CV,
        "size": list(pyautogui.size()) if HAVE else None,
        "python": sys.version.split()[0],
    }

# ---------------- pointer ----------------
@cmd("mouse_pos")
def _pos(a):
    need(); x, y = pyautogui.position(); return {"x": x, "y": y}

@cmd("move")
def _move(a):
    need()
    pyautogui.moveTo(a["x"], a["y"], duration=a.get("duration", 0.25))
    return {"moved": [a["x"], a["y"]]}

@cmd("click")
def _click(a):
    need()
    if a.get("x") is not None:
        pyautogui.moveTo(a["x"], a["y"], duration=a.get("duration", 0.25))
    pyautogui.click(clicks=a.get("clicks", 1), interval=a.get("interval", 0.08),
                    button=a.get("button", "left"))
    return {"clicked": [a.get("x"), a.get("y")], "button": a.get("button", "left")}

@cmd("double_click")
def _dbl(a):
    need()
    if a.get("x") is not None:
        pyautogui.moveTo(a["x"], a["y"], duration=0.2)
    pyautogui.doubleClick()
    return {"double_clicked": True}

@cmd("right_click")
def _rc(a):
    need()
    if a.get("x") is not None:
        pyautogui.moveTo(a["x"], a["y"], duration=0.2)
    pyautogui.rightClick()
    return {"right_clicked": True}

@cmd("drag")
def _drag(a):
    need()
    pyautogui.moveTo(a["x1"], a["y1"], duration=0.2)
    pyautogui.dragTo(a["x2"], a["y2"], duration=a.get("duration", 0.5), button="left")
    return {"dragged": [a["x1"], a["y1"], a["x2"], a["y2"]]}

@cmd("scroll")
def _scroll(a):
    need()
    if a.get("x") is not None:
        pyautogui.moveTo(a["x"], a["y"], duration=0.15)
    pyautogui.scroll(int(a.get("amount", -400)))
    return {"scrolled": a.get("amount", -400)}

# ---------------- keyboard ----------------
@cmd("type")
def _type(a):
    need()
    pyautogui.write(a["text"], interval=a.get("interval", 0.02))
    return {"typed": len(a["text"])}

@cmd("key")
def _key(a):
    need()
    keys = a["keys"]
    if isinstance(keys, str):
        keys = [k.strip() for k in keys.replace("+", " ").split() if k.strip()]
    if len(keys) == 1:
        pyautogui.press(keys[0])
    else:
        pyautogui.hotkey(*keys)
    return {"pressed": keys}

# ---------------- vision ----------------
@cmd("screenshot")
def _shot(a):
    need()
    b = shot(a.get("region"), a.get("scale", 0.5))
    w, h = pyautogui.size()
    return {"image": b, "screen": [w, h], "scale": a.get("scale", 0.5)}

@cmd("locate")
def _locate(a):
    """Find a template image on screen -> centre coords."""
    need()
    if not HAVE_CV:
        raise RuntimeError("opencv-python not installed: pip install opencv-python")
    box = pyautogui.locateOnScreen(a["image_path"], confidence=a.get("confidence", 0.8))
    if not box:
        return {"found": False}
    c = pyautogui.center(box)
    return {"found": True, "x": c.x, "y": c.y, "box": list(box)}

# ---------------- windows ----------------
@cmd("windows")
def _wins(a):
    need()
    try:
        ws = pyautogui.getAllWindows()
    except Exception:
        return {"windows": [], "note": "window enumeration unsupported on this platform"}
    return {"windows": [
        {"title": w.title, "x": w.left, "y": w.top, "w": w.width, "h": w.height,
         "active": bool(getattr(w, "isActive", False))}
        for w in ws if w.title
    ][:40]}

@cmd("focus_window")
def _focus(a):
    need()
    for w in pyautogui.getAllWindows():
        if a["title"].lower() in (w.title or "").lower():
            try:
                w.activate()
            except Exception:
                w.minimize(); w.restore()
            return {"focused": w.title}
    return {"focused": None, "error": f"no window matching '{a['title']}'"}


def main():
    out({"ready": True, "available": HAVE, "error": ERR})
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:
            out({"id": None, "error": f"bad json: {e}"}); continue
        rid, action, args = req.get("id"), req.get("action"), req.get("args") or {}
        try:
            fn = HANDLERS.get(action)
            if not fn:
                raise RuntimeError(f"unknown action '{action}'")
            out({"id": rid, "result": fn(args)})
        except Exception as e:
            out({"id": rid, "error": str(e)})


if __name__ == "__main__":
    main()
