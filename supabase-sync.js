(() => {
  "use strict";

  const SUPABASE_URL = "https://gppdwvzecmajbmqhyewo.supabase.co";
  const SUPABASE_PUBLISHABLE_KEY = "sb_publishable_wIpHsIp5pe2FlDTwOKVraQ_HK90_x6f";
  const SUPABASE_SDK_URL = "https://esm.sh/@supabase/supabase-js@2.118.0";
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
  const OWNER_KEY = "moyo-supabase-owner-v1";
  const IMPORT_LOCAL_ON_FIRST_LOGIN = false;
  const encode = (value) => stableStringify(value);
  let supabase;
  let currentUser = null;
  let lastSynced = "";
  let dirty = false;
  let syncing = false;
  let syncTimer = null;
  let ready = false;
  let originalSet;
  let originalRemove;
  let originalClear;
  let statusNode;
  let gate;
  let gateMessage;

  function stableStringify(value) {
    if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
    if (value && typeof value === "object") {
      return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + stableStringify(value[key])).join(",") + "}";
    }
    return JSON.stringify(value);
  }

  function snapshot() {
    const state = {};
    for (const key of KEYS) {
      const value = localStorage.getItem(key);
      if (value !== null) state[key] = value;
    }
    return state;
  }

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

  function applyState(state) {
    dirty = false;
    try {
      for (const key of KEYS) {
        if (state[key] === undefined) originalRemove.call(localStorage, key);
        else originalSet.call(localStorage, key, state[key]);
      }
    } finally {
      dirty = false;
    }
  }

  function setAuthenticated(isAuthenticated) {
    document.documentElement.classList.toggle("supabase-authenticated", isAuthenticated);
    if (gate) gate.hidden = isAuthenticated;
  }

  function setStatus(message, isError = false) {
    if (!statusNode) {
      statusNode = document.getElementById("storageSyncStatus");
      if (!statusNode) {
        statusNode = document.createElement("span");
        statusNode.id = "storageSyncStatus";
        statusNode.style.cssText = "display:block;margin-top:6px;font-size:12px;color:#697586";
        document.querySelector("footer")?.appendChild(statusNode);
      }
    }
    statusNode.textContent = message;
    statusNode.style.color = isError ? "#a44" : "#697586";
  }

  function setGateMessage(message, isError = false) {
    if (!gateMessage) return;
    gateMessage.textContent = message;
    gateMessage.style.color = isError ? "#a44" : "#697586";
  }

  function createAuthGate() {
    const style = document.createElement("style");
    style.textContent = `
      html:not(.supabase-authenticated) body > header,
      html:not(.supabase-authenticated) body > main,
      html:not(.supabase-authenticated) body > footer { visibility: hidden !important; }
      #supabaseAuthGate { position:fixed; inset:0; z-index:2147483000; display:flex; align-items:center; justify-content:center; padding:24px; background:#f4f6fa; font-family:system-ui,-apple-system,sans-serif; color:#233047; }
      #supabaseAuthGate[hidden] { display:none !important; }
      #supabaseAuthGate .auth-card { width:min(100%,420px); padding:26px; background:#fff; border:1px solid #dfe4ec; border-radius:18px; box-shadow:0 12px 40px #23304718; }
      #supabaseAuthGate h1 { margin:0 0 8px; font-size:22px; }
      #supabaseAuthGate p { color:#66758a; line-height:1.5; }
      #supabaseAuthGate form { display:grid; gap:12px; margin-top:20px; }
      #supabaseAuthGate label { display:grid; gap:6px; font-size:14px; }
      #supabaseAuthGate input { width:100%; padding:11px; border:1px solid #cbd5e1; border-radius:9px; font:inherit; }
      #supabaseAuthGate button { padding:11px 14px; border:0; border-radius:10px; background:#376f72; color:white; font:inherit; cursor:pointer; }
      #supabaseAuthGate button:disabled { opacity:.6; cursor:wait; }
      #supabaseAuthGate [aria-live] { min-height:20px; font-size:13px; }
    `;
    document.head.appendChild(style);

    gate = document.createElement("section");
    gate.id = "supabaseAuthGate";
    gate.setAttribute("role", "dialog");
    gate.setAttribute("aria-modal", "true");
    gate.setAttribute("aria-labelledby", "supabaseAuthTitle");
    gate.innerHTML = `
      <div class="auth-card">
        <h1 id="supabaseAuthTitle">개발판 로그인</h1>
        <p>개발판 기록은 메인 기록과 분리된 저장소에 보관됩니다. 이메일로 로그인 링크를 받을게요.</p>
        <form id="supabaseAuthForm">
          <label for="supabaseAuthEmail">이메일</label>
          <input id="supabaseAuthEmail" type="email" autocomplete="email" required placeholder="name@example.com">
          <button id="supabaseAuthSubmit" type="submit">로그인 링크 보내기</button>
        </form>
        <p id="supabaseAuthMessage" aria-live="polite"></p>
      </div>`;
    document.body.appendChild(gate);
    gateMessage = gate.querySelector("#supabaseAuthMessage");
    gate.querySelector("#supabaseAuthForm").addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = gate.querySelector("#supabaseAuthEmail").value.trim();
      const button = gate.querySelector("#supabaseAuthSubmit");
      button.disabled = true;
      setGateMessage("로그인 링크를 보내는 중…");
      try {
        const { error } = await supabase.auth.signInWithOtp({
          email,
          options: { emailRedirectTo: location.origin },
        });
        if (error) throw error;
        setGateMessage("이메일을 확인하고 링크를 누르면 개발판으로 돌아옵니다.");
      } catch (error) {
        setGateMessage(error?.message || "로그인 링크를 보내지 못했어요.", true);
      } finally {
        button.disabled = false;
      }
    });
  }

  function ensureSignOutButton() {
    const footer = document.querySelector("footer");
    if (!footer || footer.querySelector("#supabaseSignOut")) return;
    const button = document.createElement("button");
    button.id = "supabaseSignOut";
    button.type = "button";
    button.textContent = "로그아웃";
    button.style.cssText = "margin-left:10px;padding:4px 8px;border-radius:7px;border:1px solid #dfe4ec;background:#fff;color:#475569;font-size:12px";
    button.addEventListener("click", async () => {
      const saved = await syncOnce();
      if (!saved) {
        setStatus("연결이 복구되면 로그아웃할 수 있어요. 기록은 브라우저에 남아 있습니다.", true);
        return;
      }
      const { error } = await supabase.auth.signOut();
      if (error) setStatus("로그아웃하지 못했어요.", true);
    });
    footer.appendChild(button);
  }

  async function upsertState(state) {
    const { error } = await supabase
      .from("app_state")
      .upsert({
        user_id: currentUser.id,
        state,
        updated_at: new Date().toISOString(),
      }, { onConflict: "user_id" });
    if (error) throw error;
  }

  async function syncFromCloud(user) {
    currentUser = user;
    const { data, error } = await supabase
      .from("app_state")
      .select("state")
      .eq("user_id", user.id)
      .maybeSingle();
    if (error) throw error;

    const savedOwner = localStorage.getItem(OWNER_KEY);
    const canImportLocal = savedOwner === user.id || (!savedOwner && IMPORT_LOCAL_ON_FIRST_LOGIN);
    const local = canImportLocal ? snapshot() : {};
    const remote = data?.state || {};
    const merged = mergeStates(local, remote);
    if (!data || encode(merged) !== encode(remote)) await upsertState(merged);

    const changedLocal = encode(snapshot()) !== encode(merged);
    if (changedLocal) applyState(merged);
    localStorage.setItem(OWNER_KEY, user.id);
    lastSynced = encode(merged);
    setAuthenticated(true);
    ensureSignOutButton();
    setStatus("개발용 Supabase에 연결됐어요.");
    startSync();
    if (changedLocal) location.reload();
  }

  function installWatcher() {
    originalSet = Storage.prototype.setItem;
    originalRemove = Storage.prototype.removeItem;
    originalClear = Storage.prototype.clear;
    Storage.prototype.setItem = function (key, value) {
      originalSet.call(this, key, value);
      if (this === localStorage && watched.has(String(key)) && ready) dirty = true;
    };
    Storage.prototype.removeItem = function (key) {
      originalRemove.call(this, key);
      if (this === localStorage && watched.has(String(key)) && ready) dirty = true;
    };
    Storage.prototype.clear = function () {
      originalClear.call(this);
      if (this === localStorage && ready) dirty = true;
    };
    window.addEventListener("storage", (event) => {
      if (event.key === null || watched.has(event.key)) dirty = true;
    });
  }

  async function syncOnce() {
    if (!currentUser || syncing) return false;
    syncing = true;
    try {
      const current = snapshot();
      if (dirty || encode(current) !== lastSynced) {
        await upsertState(current);
        lastSynced = encode(current);
        dirty = false;
        setStatus("저장 완료 · 개발용 데이터베이스");
        return true;
      }
      const { data, error } = await supabase
        .from("app_state")
        .select("state")
        .eq("user_id", currentUser.id)
        .maybeSingle();
      if (error) throw error;
      const remote = data?.state || {};
      if (encode(remote) !== lastSynced) {
        applyState(remote);
        lastSynced = encode(remote);
        setStatus("최신 개발 기록을 불러왔어요.");
        location.reload();
      }
      return true;
    } catch (error) {
      setStatus("연결 대기 중 · 이 브라우저의 기록은 보존돼요.", true);
      console.warn("Supabase sync pending:", error);
      return false;
    } finally {
      syncing = false;
    }
  }

  function startSync() {
    if (syncTimer) return;
    ready = true;
    syncTimer = window.setInterval(syncOnce, 5000);
  }

  function handleSignOut() {
    currentUser = null;
    ready = false;
    dirty = false;
    lastSynced = "";
    if (syncTimer) window.clearInterval(syncTimer);
    syncTimer = null;
    applyState({});
    localStorage.removeItem(OWNER_KEY);
    setAuthenticated(false);
    setGateMessage("로그아웃했어요. 다시 로그인하면 개발 기록을 불러옵니다.");
  }

  async function main() {
    createAuthGate();
    installWatcher();
    const { createClient } = await import(SUPABASE_SDK_URL);
    supabase = createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    supabase.auth.onAuthStateChange((event) => {
      if (event === "SIGNED_OUT") handleSignOut();
    });

    const { data, error } = await supabase.auth.getSession();
    if (error) throw error;
    if (!data.session?.user) {
      setAuthenticated(false);
      setGateMessage("이메일 주소를 입력해 로그인 링크를 받으세요.");
      return;
    }
    await syncFromCloud(data.session.user);
  }

  main().catch((error) => {
    setAuthenticated(false);
    setGateMessage(error?.message || "개발 저장소에 연결하지 못했어요.", true);
    setStatus("Supabase 연결 오류", true);
    console.error("Supabase startup failed:", error);
  });
})();