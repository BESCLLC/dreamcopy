// dreamCopy dashboard.
//
// Deliberately dependency-free: no bundler, no framework, no build step. The
// page does three things — show a leaderboard, sign a follow, show its state —
// and anything heavier would be more machinery than product.
//
// Following is a signed action. The wallet signs the exact sentence the server
// rebuilds and verifies, so the API never takes an owner address on trust.

const $ = (id) => document.getElementById(id);

const state = {
  account: null,
  markets: [],
  market: null, // { name, pool, markPrice }
  status: null,
  pending: null, // leader being followed in the dialog
};

/* ── formatting ─────────────────────────────────────────────────────────── */

const fmt = (n, dp = 2) =>
  Number.isFinite(n) ? n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp }) : "—";

const money = (n) => {
  if (!Number.isFinite(n)) return `<span class="zero">—</span>`;
  const cls = n > 0 ? "up" : n < 0 ? "down" : "zero";
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `<span class="${cls}">${sign}$${fmt(Math.abs(n))}</span>`;
};

const qty = (n, sym, dp) => {
  if (!n) return `<span class="flat">flat</span>`;
  const cls = n > 0 ? "pos-long" : "pos-short";
  return `<span class="${cls}">${n > 0 ? "+" : "−"}${fmt(Math.abs(n), dp)} ${sym}</span>`;
};

const addr = (a) => (a && a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a ?? "");

const ago = (sec) => {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - sec);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

/** Size decimals that suit the price: BTC moves in thousandths, DOGE in thousands. */
const qtyDp = (px) => (!Number.isFinite(px) ? 3 : px >= 10000 ? 5 : px >= 1000 ? 4 : px >= 10 ? 3 : px >= 1 ? 2 : 1);

function toast(message, kind = "") {
  document.querySelector(".toast")?.remove();
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  document.body.append(el);
  setTimeout(() => el.remove(), 5200);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `request failed (${res.status})`);
  return body;
}

/* ── demo mode ──────────────────────────────────────────────────────────── *
 * With no keeper behind it the page would be an empty table, which is a poor
 * way to show anyone what this is. When the API cannot be reached — a static
 * preview, or the service simply not running — the dashboard falls back to a
 * snapshot of real Hideki data and says so. Nothing is ever sent in this mode. */

const DEMO = {
  status: { network: "hideki", dryRun: true, operator: null, demo: true },
  markets: [
    { name: "BTC-PERP", baseSymbol: "BTC", markPrice: 81410.85, pool: "0x4181dd08e73bbcdd1ba3e615a18f6abd941b94c0" },
    { name: "ETH-PERP", baseSymbol: "ETH", markPrice: 2405.28, pool: "0xd6cb1dd58580b84d76068ac21594219ce03aeddf" },
    { name: "SOL-PERP", baseSymbol: "SOL", markPrice: 104.49, pool: "0xb483ec1fb34996638677c20ab087b16f1896fa53" },
    { name: "HYPE-PERP", baseSymbol: "HYPE", markPrice: 78.18, pool: "0x63b47ed4a7de0fde659b0d82441dd74828b7297a" },
    { name: "XRP-PERP", baseSymbol: "XRP", markPrice: 1.31, pool: "0x7058579f3248559963f79adb937c6de9f953e060" },
    { name: "DOGE-PERP", baseSymbol: "DOGE", markPrice: 0.07991, pool: "0xc410012e39765cd5f772e84bacb19554aec040df" },
  ],
  // A real window off ETH-PERP, kept as it came back from the indexer.
  traders: [
    { account: "0x47537e3a3ea6e9391f3b26ea45618db6828c8bff", position: 9.2225, avgEntry: 2409.06, realized: 821.82, unrealized: -77.52, total: 744.3, volume: 7865219, takerShare: 0.16, fills: 1240, lastTimestamp: 0 },
    { account: "0x5ad3f981bc477868844f1c925a82c6c0f5a33817", position: 0.8291, avgEntry: 2411.78, realized: 183.08, unrealized: -9.22, total: 173.86, volume: 1281807, takerShare: 1, fills: 420, lastTimestamp: 0 },
    { account: "0xf428b2d3a1c4e6f0b9d5a7c2e8f1b4d6a9c3e7f2", position: -3.2181, avgEntry: 2402.99, realized: 0, unrealized: 7.51, total: 7.51, volume: 7733, takerShare: 1, fills: 18, lastTimestamp: 0 },
    { account: "0x09e2d5651c4b8a3f7e6d2c9b5a8f1e4d7c0b3a65", position: 0.1, avgEntry: 2405.72, realized: 0.41, unrealized: -0.51, total: -0.09, volume: 4086, takerShare: 1, fills: 12, lastTimestamp: 0 },
    { account: "0xf2ed99fbc3a7e5d1b8c4f6a2e9d7b5c3a1f8e6d4", position: 0, avgEntry: 0, realized: -45.51, unrealized: 0, total: -45.51, volume: 18755, takerShare: 1, fills: 64, lastTimestamp: 0 },
    { account: "0x05d49dc4b7a3e6f2c8d1b5a9e7f4c2d6b8a3e1f7", position: 13.4648, avgEntry: 2404.28, realized: -64.71, unrealized: -48.75, total: -113.46, volume: 382120, takerShare: 0.5, fills: 310, lastTimestamp: 0 },
  ],
};

let demoMode = false;

function enterDemoMode() {
  if (demoMode) return;
  demoMode = true;
  const mode = $("mode");
  mode.textContent = "demo data";
  mode.className = "badge dry";
  $("operator").textContent = "start the service to get a live bot key";
}

/* ── loading ────────────────────────────────────────────────────────────── */

async function loadStatus() {
  try {
    state.status = await api("/api/status");
  } catch {
    enterDemoMode();
    state.status = DEMO.status;
    $("net").textContent = DEMO.status.network;
    return;
  }
  $("net").textContent = state.status.network;
  const mode = $("mode");
  mode.textContent = state.status.dryRun ? "dry run" : "live";
  mode.className = `badge ${state.status.dryRun ? "dry" : "live"}`;
  $("operator").textContent = state.status.operator ?? "no bot key configured on this service";
}

async function loadMarkets() {
  let markets;
  try {
    ({ markets } = await api("/api/markets"));
  } catch {
    enterDemoMode();
    markets = DEMO.markets;
  }
  state.markets = markets;
  state.market ??= markets[0];
  $("markets").innerHTML = markets
    .slice(0, 14)
    .map(
      (m) =>
        `<button class="market-tab ${m.name === state.market?.name ? "on" : ""}" data-market="${m.name}">
           ${m.baseSymbol}<span class="px">${fmt(m.markPrice, m.markPrice < 1 ? 5 : 2)}</span>
         </button>`,
    )
    .join("");
  for (const tab of document.querySelectorAll(".market-tab")) {
    tab.onclick = () => {
      state.market = state.markets.find((m) => m.name === tab.dataset.market);
      loadMarkets();
      loadLeaderboard();
    };
  }
}

async function loadLeaderboard() {
  const name = state.market?.name ?? "BTC-PERP";
  $("mkt-title").textContent = `${name} leaderboard`;
  $("rows").innerHTML = `<tr><td colspan="11" class="empty">Reading the tape…</td></tr>`;

  let data;
  try {
    data = await api(`/api/leaderboard?market=${encodeURIComponent(name)}`);
  } catch (err) {
    // `loadStatus` runs first, so an unreachable API has already flipped this.
    // Browsers word a failed fetch differently ("Failed to fetch", "Load
    // failed", "NetworkError…"), so the flag decides rather than the message.
    if (!demoMode) {
      $("rows").innerHTML = `<tr><td colspan="11" class="empty">${err.message}</td></tr>`;
      return;
    }
    data = {
      market: { name, markPrice: state.market?.markPrice ?? NaN },
      window: 2000,
      traders: DEMO.traders,
    };
  }

  const px = data.market.markPrice;
  const dp = qtyDp(px);
  const sym = name.replace("-PERP", "");
  $("mkt-sub").textContent = `mark ${fmt(px, px < 1 ? 5 : 2)} · ${data.window.toLocaleString("en-US")} fills`;

  if (data.traders.length === 0) {
    $("rows").innerHTML = `<tr><td colspan="11" class="empty">Nobody in this window clears the filters yet.</td></tr>`;
    return;
  }

  const peak = Math.max(...data.traders.map((t) => Math.abs(t.total)), 1);
  $("rows").innerHTML = data.traders
    .map((t, i) => {
      const pct = Math.min(100, (Math.abs(t.total) / peak) * 100);
      const dir = t.total >= 0 ? "up" : "down";
      const mine = state.account && t.account.toLowerCase() === state.account.toLowerCase();
      return `<tr>
        <td class="rank">${i + 1}</td>
        <td class="l cell-trader"><span class="addr ${i === 0 ? "top" : ""}">${addr(t.account)}</span>${mine ? ' <span class="tiny">you</span>' : ""}</td>
        <td class="kv" data-label="Position">${qty(t.position, sym, dp)}</td>
        <td class="muted cell-entry">${t.avgEntry > 0 ? fmt(t.avgEntry, px < 1 ? 5 : 2) : "—"}</td>
        <td class="kv" data-label="Realized">${money(t.realized)}</td>
        <td class="kv" data-label="Unrealized">${money(t.unrealized)}</td>
        <td class="cell-total"><strong>${money(t.total)}</strong></td>
        <td class="cell-bar"><span class="bar"><i class="${dir}" style="width:${pct}%"></i></span></td>
        <td class="muted kv" data-label="Volume">$${fmt(t.volume, 0)}</td>
        <td class="muted kv" data-label="Taker">${(t.takerShare * 100).toFixed(0)}%</td>
        <td class="cell-act">${mine ? "" : `<button class="small" data-follow="${t.account}">Follow</button>`}</td>
      </tr>`;
    })
    .join("");

  for (const b of document.querySelectorAll("[data-follow]")) {
    b.onclick = () => openFollow(b.dataset.follow);
  }
}

async function loadFollows() {
  if (!state.account) return;
  const { follows } = await api(`/api/follows?owner=${state.account}`);
  const live = follows.filter((f) => f.active);
  $("follow-count").textContent = live.length ? `${live.length} active` : "";

  if (live.length === 0) {
    $("follows").innerHTML = `<div class="empty">Not following anyone yet. Pick a trader from the leaderboard.</div>`;
    return;
  }

  $("follows").innerHTML = live
    .map((f) => {
      const s = f.status ?? {};
      let note = "";
      if (s.error) note = `<div class="follow-note err">${s.error}</div>`;
      else if (s.linked === false)
        note = `<div class="follow-note warn">Not linked yet — grant the bot key in the app to start mirroring.</div>`;
      else if (s.note) note = `<div class="follow-note">${s.note}</div>`;
      return `<div class="follow">
        <div class="follow-top">
          <span class="follow-mkt">${f.marketName}</span>
          <span class="follow-leader">${addr(f.leader)}</span>
        </div>
        <div class="follow-row"><span>ratio</span><span>${(f.ratio * 100).toFixed(0)}%</span></div>
        <div class="follow-row"><span>cap</span><span>$${fmt(f.maxNotional, 0)}</span></div>
        ${note}
        <div style="display:flex;gap:7px;align-items:center">
          <span class="tiny">${s.lastCycleAt ? `checked ${ago(Math.floor(Date.parse(s.lastCycleAt) / 1000))} ago` : "not checked yet"}</span>
          <div class="spacer" style="flex:1"></div>
          <button class="small danger" data-stop="${f.marketName}|${f.leader}">Stop</button>
        </div>
      </div>`;
    })
    .join("");

  for (const b of document.querySelectorAll("[data-stop]")) {
    const [market, leader] = b.dataset.stop.split("|");
    b.onclick = () => stopFollow(market, leader);
  }
}

/* ── wallet ─────────────────────────────────────────────────────────────── */

async function connect() {
  if (!window.ethereum) return toast("No wallet found. Install a browser wallet to follow traders.", "err");
  const [account] = await window.ethereum.request({ method: "eth_requestAccounts" });
  state.account = account;
  $("connect").textContent = addr(account);
  await Promise.all([loadFollows(), loadLeaderboard()]);
}

/** The exact sentence the server rebuilds and verifies. */
function followMessage({ action, owner, market, leader, issued }) {
  return [
    "dreamCopy",
    `action: ${action}`,
    `owner: ${owner.toLowerCase()}`,
    `market: ${market}`,
    `leader: ${leader.toLowerCase()}`,
    `issued: ${issued}`,
  ].join("\n");
}

async function sign(action, market, leader) {
  const issued = new Date().toISOString();
  const message = followMessage({ action, owner: state.account, market, leader, issued });
  const signature = await window.ethereum.request({
    method: "personal_sign",
    params: [message, state.account],
  });
  return { owner: state.account, market, leader, issued, signature };
}

/* ── follow / unfollow ──────────────────────────────────────────────────── */

function openFollow(leader) {
  if (!state.account) return toast("Connect a wallet first.", "err");
  state.pending = leader;
  $("dlg-leader").textContent = addr(leader);
  $("dlg-market").textContent = `on ${state.market?.name ?? "BTC-PERP"}`;
  $("dlg").showModal();
}

async function submitFollow() {
  const market = state.market?.name ?? "BTC-PERP";
  const go = $("dlg-go");
  go.disabled = true;
  go.textContent = "Check your wallet…";
  try {
    const signed = await sign("follow", market, state.pending);
    await api("/api/follows", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...signed,
        ratio: Number($("f-ratio").value),
        maxNotional: Number($("f-max").value),
        minGap: Number($("f-gap").value),
      }),
    });
    $("dlg").close();
    toast(`Following ${addr(state.pending)}. Link the bot key in the app if you have not yet.`, "ok");
    await loadFollows();
  } catch (err) {
    toast(err.message ?? "Could not follow", "err");
  } finally {
    go.disabled = false;
    go.textContent = "Sign & follow";
  }
}

async function stopFollow(market, leader) {
  try {
    const signed = await sign("unfollow", market, leader);
    await api("/api/follows/stop", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(signed),
    });
    toast("Stopped. Your position is left as it is.", "ok");
    await loadFollows();
  } catch (err) {
    toast(err.message ?? "Could not stop", "err");
  }
}

/* ── wiring ─────────────────────────────────────────────────────────────── */

$("connect").onclick = connect;
$("refresh").onclick = () => { loadLeaderboard(); loadFollows(); };
$("dlg-cancel").onclick = () => $("dlg").close();
$("dlg-go").onclick = submitFollow;

await loadStatus().catch((e) => toast(e.message, "err"));
await loadMarkets().catch((e) => toast(e.message, "err"));
await loadLeaderboard();

// The keeper moves positions on its own schedule, so the page keeps up.
setInterval(() => { loadFollows(); loadStatus(); }, 20_000);
setInterval(loadLeaderboard, 60_000);
