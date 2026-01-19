let tg = null;

async function getTelegramWebApp(maxWaitMs = 2500) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    if (window.Telegram && window.Telegram.WebApp) return window.Telegram.WebApp;
    await new Promise(r => setTimeout(r, 60));
  }
  return null;
}

function setStatus(msg, warn) {
  document.getElementById("statusLine").textContent = msg;

  const warnEl = document.getElementById("warnLine");
  if (warn) {
    warnEl.style.display = "block";
    warnEl.textContent = warn;
  } else {
    warnEl.style.display = "none";
    warnEl.textContent = "";
  }
}

function setDebug(obj) {
  document.getElementById("debug").textContent = JSON.stringify(obj, null, 2);
}

async function init() {
  tg = await getTelegramWebApp();

  const info = {
    hasTelegram: !!window.Telegram,
    hasWebApp: !!(window.Telegram && window.Telegram.WebApp),
    initDataLen: tg && tg.initData ? tg.initData.length : 0,
    platform: tg ? tg.platform : null,
    version: tg ? tg.version : null
  };

  setDebug(info);

  if (!tg) {
    setStatus("Not inside Telegram WebApp.", "This page was not opened as a Telegram WebApp session.");
    return;
  }

  tg.ready();
  tg.expand();
  setStatus("Inside Telegram WebApp.", null);
}

document.getElementById("authBtn").addEventListener("click", async () => {
  if (!tg) {
    alert("Not inside Telegram WebApp (no Telegram.WebApp).");
    return;
  }

  const res = await fetch("/miniapp/auth", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ initData: tg.initData })
  }).then(r => r.json()).catch(e => ({ ok:false, error: String(e) }));

  const current = JSON.parse(document.getElementById("debug").textContent || "{}");
  setDebug({ ...current, authResult: res });
});

document.getElementById("reloadBtn").addEventListener("click", () => location.reload());

init();