"""
Pocket Option OTC bot — automation runner.

Each automation run gets a FRESH sandbox: no repo, no dataset, no model, and
/workspace/project does not persist between runs. So this script rebuilds the
whole stack from scratch every time:

  1. clone the repo
  2. npm install + `playwright install chromium`
  3. restore signals.json + model.pkl from the payload shipped in the tarball
  4. start the inference service and the capture engine
  5. supervise for RUN_SECONDS, then shut both down cleanly

The model and dataset ride along inside the tarball because the sandbox offers
no writable persistence: the KV store caps at 10KB, `git push` is refused for
automation runs, and the GitHub token present there returns 401.

What this run does NOT do: it cannot append to a durable dataset. Each run's
new observations die with the sandbox. That is a platform limit, documented in
automation/README.md, not an oversight.
"""
import json, os, shutil, signal, subprocess, sys, time, urllib.parse, urllib.request

REPO_URL = "https://github.com/daveok16-arch/Chamberfx-pocket-option.git"
WORK = "/workspace/project/bot"
REPO = os.path.join(WORK, "repo")
DATA = os.path.join(WORK, "data")
LOG_DIR = os.path.join(WORK, "logs")
RUN_SECONDS = int(sys.argv[1]) if len(sys.argv) > 1 else int(os.environ.get("RUN_SECONDS", "1260"))
BOOT_BUDGET = 420                                          # clone+install+train allowance

_state = {"procs": [], "phase": "init"}


def log(msg):
    print(f"[{time.strftime('%H:%M:%S')}] {msg}", flush=True)


def fire_callback(status="COMPLETED", error=None):
    url = os.environ.get("AUTOMATION_CALLBACK_URL", "")
    if not url:
        return
    body = {"status": status, "run_id": os.environ.get("AUTOMATION_RUN_ID", "")}
    if error:
        body["error"] = str(error)[:4000]
    try:
        urllib.request.urlopen(urllib.request.Request(
            url, data=json.dumps(body).encode(),
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {os.environ.get('AUTOMATION_CALLBACK_API_KEY','')}"}),
            timeout=25)
    except Exception as e:
        log(f"callback failed: {e}")


def get_secret(name, attempts=4, timeout=30):
    url = os.environ.get("AGENT_SERVER_URL", "").rstrip("/")
    key = os.environ.get("SESSION_API_KEY") or os.environ.get("OH_SESSION_API_KEYS_0", "")
    if url:
        url = f"{url}/api/settings/secrets/{name}"
    else:
        api = os.environ.get("OPENHANDS_CLOUD_API_URL", "").rstrip("/")
        url = f"{api}/api/v1/sandboxes/{os.environ.get('SANDBOX_ID','')}/settings/secrets/{name}"
    last = None
    for i in range(attempts):
        try:
            with urllib.request.urlopen(urllib.request.Request(
                    url, headers={"X-Session-API-Key": key}), timeout=timeout) as r:
                return r.read().decode().strip()
        except Exception as e:
            last = e
            log(f"secret {name} attempt {i+1}/{attempts} failed: {type(e).__name__}")
            time.sleep(2 * (i + 1))
    raise RuntimeError(f"could not fetch secret {name} after {attempts} attempts: {last}")


def run(cmd, cwd=None, timeout=900, env=None, label=None):
    log(f"$ {' '.join(cmd) if isinstance(cmd, list) else cmd}")
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True,
                       timeout=timeout, env=env)
    if r.returncode != 0:
        tail = ((r.stdout or "") + (r.stderr or "")).strip()[-400:]
        raise RuntimeError(f"{label or cmd[0]} failed rc={r.returncode}: {tail}")
    return r


def health(port, timeout=3):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=timeout) as r:
            return json.load(r)
    except Exception:
        return None


def notify_telegram(summary, token, chat_id, attempts=3):
    """Post a per-run summary so each run leaves durable evidence of its outcome.

    The sandbox is discarded when the run ends, so without this the run leaves
    nothing readable behind.
    """
    pred = summary.get("predictions") or {}
    ai = summary.get("ai") or {}
    tg = summary.get("telegram") or {}
    skill = summary.get("skill") or {}
    if summary.get("failed"):
        head = f"\u26A0\uFE0F OTC bot run FAILED\n{summary.get('error', 'unknown error')}"
    else:
        head = "\U0001F4CA OTC bot run summary"
    text = (
        head + "\n"
        f"ran: {summary.get('ran_seconds')}s | connected: {summary.get('connected')}\n"
        f"predictions: {pred.get('total')} (ml={pred.get('ml')}) "
        f"accepted={pred.get('accepted')} rejected={pred.get('rejected')}\n"
        f"AI: analyzed={ai.get('analyzed')} approved={ai.get('approved')} "
        f"rejected={ai.get('rejected')} errors={ai.get('errors')}\n"
        f"telegram: sent={tg.get('sent')} signals={tg.get('signals')} "
        f"failed={tg.get('failed')} dupes={tg.get('duplicates')}\n"
        f"model skill: resolved={skill.get('resolved')} acc={skill.get('accuracy')}"
    )
    data = urllib.parse.urlencode({"chat_id": chat_id, "text": text}).encode()
    url = f"https://api.telegram.org/bot{token}/sendMessage"
    for i in range(attempts):
        try:
            with urllib.request.urlopen(url, data=data, timeout=25) as r:
                if r.status == 200:
                    log("run summary sent to Telegram")
                    return True
        except Exception as e:
            log(f"telegram summary attempt {i+1} failed: {e}")
            time.sleep(2 * (i + 1))
    return False


def cleanup(*_):
    _state["phase"] = "stopping"
    for p in _state["procs"]:
        if p.poll() is None:
            try:
                p.send_signal(signal.SIGTERM)
            except Exception:
                pass
    deadline = time.time() + 20
    for p in _state["procs"]:
        try:
            p.wait(timeout=max(1, deadline - time.time()))
        except Exception:
            try:
                p.kill()
            except Exception:
                pass


def main():
    os.makedirs(WORK, exist_ok=True)
    os.makedirs(DATA, exist_ok=True)
    os.makedirs(LOG_DIR, exist_ok=True)
    t_start = time.time()

    # Fetch credentials first: a missing or unreachable secret aborts the run
    # before it spends minutes on clone/install.
    _state["phase"] = "secrets"
    tg = get_secret("TELEGRAM_BOT_TOKEN")
    chat = get_secret("TELEGRAM_CHAT_ID")
    gem = get_secret("Gemini_API_Token")
    log("secrets loaded")

    # ---- 1. clone -------------------------------------------------------
    _state["phase"] = "clone"
    if os.path.isdir(REPO):
        shutil.rmtree(REPO, ignore_errors=True)
    run(["git", "clone", "--depth", "1", REPO_URL, REPO], timeout=600, label="clone")
    log(f"cloned in {time.time()-t_start:.0f}s")

    # ---- 2. restore state shipped in the tarball ------------------------
    _state["phase"] = "restore"
    here = os.path.dirname(os.path.abspath(__file__))
    for name, dest in (("signals.json", os.path.join(REPO, "price-bot", "signals.json")),
                       ("model.pkl", os.path.join(REPO, "inference", "model.pkl"))):
        src = os.path.join(here, "state", name)
        if os.path.exists(src):
            shutil.copy2(src, dest)
            log(f"restored {name} ({os.path.getsize(dest)/1048576:.2f} MB)")
        else:
            log(f"WARNING: no bundled {name}; the run may not be able to predict")

    # ---- 3. dependencies ------------------------------------------------
    _state["phase"] = "npm"
    env = dict(os.environ, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD="1")
    run(["npm", "install", "--no-audit", "--no-fund", "--ignore-scripts"],
        cwd=os.path.join(REPO, "price-bot"), timeout=900, env=env, label="npm")
    _state["phase"] = "browser"
    run(["npx", "playwright", "install", "chromium"],
        cwd=os.path.join(REPO, "price-bot"), timeout=900, label="playwright-install")
    _state["phase"] = "pip"
    run([sys.executable, "-m", "pip", "install", "--quiet", "--no-input",
         "-r", os.path.join(REPO, "inference", "requirements.txt")],
        timeout=900, label="pip")
    log(f"deps ready in {time.time()-t_start:.0f}s")

    # ---- 4. inference service -------------------------------------------
    _state["phase"] = "inference"
    venv_py = sys.executable
    inf_env = dict(os.environ, MODEL_FILE=os.path.join(REPO, "inference", "model.pkl"),
                   MODEL_AUTO_RELOAD="1", PREDICTION_THRESHOLD="0.5")
    inf_log = open(os.path.join(LOG_DIR, "inference.log"), "w")
    inf = subprocess.Popen([venv_py, "-m", "uvicorn", "app:app", "--host", "127.0.0.1",
                            "--port", "8000"], cwd=os.path.join(REPO, "inference"),
                           stdout=inf_log, stderr=subprocess.STDOUT, env=inf_env)
    _state["procs"].append(inf)

    deadline = time.time() + 120
    while time.time() < deadline:
        if health(8000):
            log("inference up")
            break
        if inf.poll() is not None:
            raise RuntimeError("inference exited during startup")
        time.sleep(2)
    else:
        raise RuntimeError("inference did not become healthy in 120s")

    # ---- 5. capture engine ----------------------------------------------
    _state["phase"] = "capture"
    cap_env = dict(os.environ,
                   PORT="10000", PERIOD="60", HORIZON="60",
                   INFERENCE_URL="http://127.0.0.1:8000",
                   INFERENCE_TIMEOUT_MS="5000",
                   SIGNAL_COOLDOWN_MS="0",
                   SIGNAL_BATCH_WINDOW_MS="2000",
                   TELEGRAM_BOT_TOKEN=tg, TELEGRAM_CHAT_ID=chat,
                   GEMINI_API_KEY=gem,
                   SIGNALS_FILE=os.path.join(REPO, "price-bot", "signals.json"),
                   FEATURES_FILE=os.path.join(REPO, "price-bot", "live-prices.json"),
                   AI_JOURNAL_FILE=os.path.join(DATA, "ai-journal.jsonl"))
    cap_log = open(os.path.join(LOG_DIR, "capture.log"), "w")
    cap = subprocess.Popen(["npx", "tsx", "capture.ts"], cwd=os.path.join(REPO, "price-bot"),
                           stdout=cap_log, stderr=subprocess.STDOUT, env=cap_env)
    _state["procs"].append(cap)

    deadline = time.time() + 180
    h = None
    while time.time() < deadline:
        h = health(10000)
        if h:
            log(f"capture up: connected={h.get('connected')} assets={h.get('assets')}")
            break
        if cap.poll() is not None:
            raise RuntimeError("capture exited during startup")
        time.sleep(3)
    else:
        raise RuntimeError("capture did not become healthy in 180s")

    # ---- 6. supervise ----------------------------------------------------
    _state["phase"] = "running"
    stop_at = t_start + RUN_SECONDS
    last_report = 0
    while time.time() < stop_at:
        time.sleep(10)
        if cap.poll() is not None:
            raise RuntimeError("capture exited while running")
        if inf.poll() is not None:
            raise RuntimeError("inference exited while running")
        if time.time() - last_report >= 120:
            last_report = time.time()
            h = health(10000) or {}
            log("status " + json.dumps({
                "connected": h.get("connected"),
                "pred": h.get("predictionStats"),
                "ai": {k: v for k, v in (h.get("ai") or {}).items() if k != "gate"},
                "tg": {k: (h.get("telegram") or {}).get(k) for k in ("sent", "failed", "signals")},
                "skill": {k: (h.get("skill") or {}).get(k) for k in ("resolved", "accuracy")},
            }))

    # ---- 7. final report -------------------------------------------------
    _state["phase"] = "reporting"
    h = health(10000) or {}
    summary = {
        "ran_seconds": round(time.time() - t_start),
        "connected": h.get("connected"),
        "predictions": h.get("predictionStats"),
        "ai": {k: v for k, v in (h.get("ai") or {}).items() if k != "gate"},
        "telegram": h.get("telegram"),
        "skill": h.get("skill"),
    }
    log("FINAL " + json.dumps(summary))
    notify_telegram(summary, tg, chat)
    cleanup()
    log(f"done in {time.time()-t_start:.0f}s")
    if os.environ.get("REPORT_SUMMARY_IN_CALLBACK") == "1":
        fire_callback("FAILED", "SUMMARY " + json.dumps(summary))
    return 0


if __name__ == "__main__":
    try:
        rc = main()
        fire_callback("COMPLETED")
        sys.exit(rc)
    except Exception as e:
        log(f"FATAL during phase={_state['phase']}: {e}")
        cleanup()
        fire_callback("FAILED", f"phase={_state['phase']}: {e}")
        try:
            notify_telegram(
                {"ran_seconds": 0, "connected": None,
                 "failed": True, "error": f"phase={_state['phase']}: {e}"},
                get_secret("TELEGRAM_BOT_TOKEN"), get_secret("TELEGRAM_CHAT_ID"))
        except Exception:
            pass
        sys.exit(1)
