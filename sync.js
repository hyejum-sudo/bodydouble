// Shared storage sync entry point. Keeps both dashboard deployments on one private record set.
(function () {
  "use strict";

  const KEYS = [
    "moyo-dashboard-v1",
    "moyo-calendar-names-v1",
    "moyo-day-time-notes-v1",
    "moyo-day-time-ratings-v1",
    "moyo-time-score-10-v1",
    "moyo-auto-diary-collapsed",
    "moyo-auto-diary-sections-v1",
    "moyo-quick-done-v1",
    "moyo-life-system-v1",
  ];
  const watched = new Set(KEYS);
  // Same-origin API keeps the development app on its own Vercel project and database.
  const endpoint = "/api/records";
  const originalSet = Storage.prototype.setItem;
  const originalRemove = Storage.prototype.removeItem;
  let suppress = false;
  let ready = false;
  let dirty = false;
  let lastSynced = "";
  let syncing = false;
  let syncTimer = null;
  let retryTimer = null;

  function snapshot() {
    const state = {};
    for (const key of KEYS) {
      const value = localStorage.getItem(key);
      if (value !== null) state[key] = value;
    }
    return state;
  }

  const encode = (value) => JSON.stringify(value);

  function mergeValue(local, remote) {
    if (Array.isArray(local) && Array.isArray(remote)) {
      const keyOf = (item) => item && typeof item === "object"
        ? (item.id ?? item.date ?? item.key ?? null)
        : null;
      const merged = [];
      const positions = new Map();
      for (const item of [...local, ...remote]) {
        const key = keyOf(item);
        if (key === null) {
          if (!merged.some((entry) => encode(entry) === encode(item))) merged.push(item);
          continue;
        }
        const id = String(key);
        if (positions.has(id)) {
          const at = positions.get(id);
          merged[at] = mergeValue(merged[at], item);
        } else {
          positions.set(id, merged.length);
          merged.push(item);
        }
      }
      return merged;
    }
    if (local && remote && typeof local === "object" && typeof remote === "object"
        && !Array.isArray(local) && !Array.isArray(remote)) {
      const result = { ...local };
      for (const [key, value] of Object.entries(remote)) {
        result[key] = key in result ? mergeValue(result[key], value) : value;
      }
      return result;
    }
    return remote;
  }

  function mergeStates(localState, remoteState) {
    const merged = {};
    for (const key of KEYS) {
      const local = localState[key];
      const remote = remoteState?.[key];
      if (local === undefined) merged[key] = remote;
      else if (remote === undefined) merged[key] = local;
      else {
        try {
          merged[key] = JSON.stringify(mergeValue(JSON.parse(local), JSON.parse(remote)));
        } catch {
          merged[key] = remote;
        }
      }
    }
    for (const key of Object.keys(merged)) {
      if (merged[key] === undefined) delete merged[key];
    }
    return merged;
  }

  function setStatus(message, isError) {
    let node = document.getElementById("storageSyncStatus");
    if (!node) {
      node = document.createElement("span");
      node.id = "storageSyncStatus";
      node.style.cssText = "display:block;margin-top:6px;font-size:12px;color:#697586";
      const footer = document.querySelector("footer");
      if (footer) footer.appendChild(node);
    }
    node.textContent = message;
    node.style.color = isError ? "#a44" : "#697586";
  }

  async function request(method, payload) {
    const response = await fetch(endpoint, {
      method,
      credentials: "include",
      cache: "no-store",
      headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
      body: method === "POST" ? JSON.stringify(payload) : undefined,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "저장소 연결 오류");
    return data;
  }

  function applyState(state) {
    suppress = true;
    try {
      for (const key of KEYS) {
        if (state[key] === undefined) localStorage.removeItem(key);
        else localStorage.setItem(key, state[key]);
      }
    } finally {
      suppress = false;
    }
  }

  async function initialize() {
    setStatus("공유 기록 저장소에 연결 중…");
    const local = snapshot();
    const remote = await request("GET");

    if (!remote.exists) {
      if (remote.primary) {
        const seeded = await request("POST", { state: local, ifEmpty: true });
        if (seeded.exists && seeded.state) {
          const merged = mergeStates(local, seeded.state);
          if (encode(merged) !== encode(seeded.state)) await request("POST", { state: merged });
          applyState(merged);
          lastSynced = encode(merged);
        } else {
          lastSynced = encode(local);
        }
        setStatus("기록 저장소를 초기화했어요.");
        return true;
      }
      setStatus("현재 버전의 저장소 연결을 기다리고 있어요.");
      return false;
    }

    const merged = mergeStates(local, remote.state || {});
    if (encode(merged) !== encode(remote.state || {})) {
      await request("POST", { state: merged });
    }
    const changedLocal = encode(local) !== encode(merged);
    if (changedLocal) applyState(merged);
    lastSynced = encode(merged);
    setStatus("현재 버전의 저장소에 연결됐어요.");
    // State is already applied locally; do not reload on initial synchronization.
    return true;
  }

  function startSync() {
    if (syncTimer) return;
    ready = true;
    syncTimer = setInterval(syncOnce, 5000);
    window.addEventListener("storage", (event) => {
      if (watched.has(event.key)) dirty = true;
    });
  }

  function startRetry() {
    if (retryTimer) return;
    retryTimer = setInterval(async () => {
      if (syncing) return;
      try {
        if (await initialize()) {
          clearInterval(retryTimer);
          retryTimer = null;
          startSync();
        }
      } catch (error) {
        setStatus("저장소 연결 대기 중 · 현재 기록은 브라우저에 보존돼요.", true);
      }
    }, 10000);
  }

  function installWatcher() {
    Storage.prototype.setItem = function (key, value) {
      originalSet.call(this, key, value);
      if (this === localStorage && watched.has(String(key)) && !suppress && ready) dirty = true;
    };
    Storage.prototype.removeItem = function (key) {
      originalRemove.call(this, key);
      if (this === localStorage && watched.has(String(key)) && !suppress && ready) dirty = true;
    };
  }

  async function syncOnce() {
    if (syncing) return;
    syncing = true;
    try {
      const current = snapshot();
      if (dirty || encode(current) !== lastSynced) {
        const saved = await request("POST", { state: current });
        lastSynced = encode(current);
        dirty = false;
        if (saved.saved) setStatus("기록 저장 완료");
        return;
      }
      const remote = await request("GET");
      if (remote.exists && encode(remote.state || {}) !== lastSynced) {
        applyState(remote.state || {});
        lastSynced = encode(remote.state || {});
        setStatus("다른 버전의 최신 기록을 불러왔어요.");
        // Avoid reload loops; updated local storage is read on the next render.
      }
    } catch (error) {
      setStatus("저장소 연결 대기 중 · 현재 기록은 브라우저에 보존돼요.", true);
      console.warn("Shared record sync pending:", error);
    } finally {
      syncing = false;
    }
  }

  installWatcher();
  initialize().then((connected) => {
    if (connected) startSync();
    else startRetry();
  }).catch((error) => {
    setStatus("저장소 연결 대기 중 · 현재 기록은 브라우저에 보존돼요.", true);
    console.warn("Shared record sync pending:", error);
    startRetry();
  });
})();
