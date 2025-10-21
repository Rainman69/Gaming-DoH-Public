const PROVIDERS = [
  { name: "Cloudflare", url: "https://cloudflare-dns.com/dns-query", w: 35 },
  { name: "Google", url: "https://dns.google/dns-query", w: 25 },
  { name: "Quad9", url: "https://dns.quad9.net/dns-query", w: 15 },
  { name: "OpenDNS", url: "https://doh.opendns.com/dns-query", w: 10 },
  { name: "AdGuard", url: "https://dns.adguard.com/dns-query", w: 8 },
  { name: "ControlD", url: "https://freedns.controld.com/p2", w: 7 }
];

const RACING_PROVIDERS = 3;
const DEFAULT_CACHE_TTL = 300;
const GAMING_TTL = 600;
const NEGATIVE_TTL = 60;
const TIMEOUT_MS = 1200;
const METRICS_KEY = "metrics_v1";
const GAMING_HINTS = [
  "steam","steampowered","steamstatic","epicgames","fortnite","riot","valorant","leagueoflegends","lol","playstation","psn","xbox","battle.net","blizzard","ea.com","origin.com","ubisoft","uplay","activision","callofduty","cod","rockstargames","pubgmobile","pubg","gpubgm","igamecj","clashroyale","supercell","minecraft","mojang","roblox","discord","twitch","akamaihd","akamaized","cloudfront","edgesuite"
];
const WARM = [
  "store.steampowered.com","steamcommunity.com","cdn.cloudflare.steamstatic.com",
  "epicgames.com","cdn1.epicgames.com",
  "valorant.com","leagueoflegends.com","riotgames.com",
  "playstation.com","direct.playstation.com",
  "xbox.com","xboxlive.com",
  "battle.net","blizzard.com",
  "cdn.club.gpubgm.com","grpc.club.gpubgm.com","pubgmobile.com",
  "game.clashroyaleapp.com","api.clashroyale.com","clashroyale.com",
  "minecraft.net","mojang.com",
  "roblox.com",
  "discord.com","discordapp.com"
];

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    const p = u.pathname;
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });
    if (p === "/" || p === "/index.html") return htmlLanding(request);
    if (p === "/dns-query") return doh(request, env);
    if (p === "/resolve") return resolveName(request, env);
    if (p === "/providers") return json({ providers: await ranked(env) });
    if (p === "/stats") return json(await stats(env));
    if (p === "/bench") return json(await bench(env));
    if (p === "/health") return json({ ok: true, t: Date.now() });
    return new Response("Not Found", { status: 404, headers: cors() });
  },
  async scheduled(evt, env, ctx) {
    ctx.waitUntil(health(env));
    ctx.waitUntil(warm(env));
  }
};

function cors(extra = {}) {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Accept",
    ...extra
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", ...cors(headers) } });
}

function htmlLanding(req) {
  const u = new URL(req.url); u.pathname = "/dns-query";
  return new Response(`Gaming DoH: ${u.toString()}`, { status: 200, headers: { "content-type": "text/plain; charset=utf-8", ...cors() } });
}

async function doh(request, env) {
  const u = new URL(request.url);
  const m = request.method.toUpperCase();
  let dnsB64 = null;
  if (m === "GET") {
    dnsB64 = u.searchParams.get("dns");
    if (!dnsB64) return new Response("Missing ?dns=", { status: 400, headers: cors() });
  } else if (m === "POST") {
    const ct = (request.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("application/dns-message")) return new Response("POST requires application/dns-message", { status: 415, headers: cors() });
    const body = new Uint8Array(await request.arrayBuffer());
    dnsB64 = b64urlEncode(body);
  } else {
    return new Response("Method not allowed", { status: 405, headers: cors({ Allow: "GET, POST, OPTIONS" }) });
  }

  const qname = safeExtractQname(dnsB64);
  const isGaming = qname && GAMING_HINTS.some(h => qname.includes(h));
  const cacheKey = new Request(buildCacheKeyUrl(u.origin, dnsB64), { method: "GET" });
  const hit = await caches.default.match(cacheKey);
  if (hit) {
    const h = new Headers(hit.headers);
    h.set("X-Cache-Status", "HIT");
    h.set("X-Gaming-Query", isGaming ? "true" : "false");
    return new Response(hit.body, { status: hit.status, headers: h });
  }

  const res = isGaming ? await race(dnsB64, env) : await sequential(dnsB64, env);
  if (!res) return new Response("Upstream failure", { status: 502, headers: cors() });

  const ok = res.ok;
  const ttl = ok ? (isGaming ? GAMING_TTL : await dnsTtlOrDefault(res.clone(), DEFAULT_CACHE_TTL)) : NEGATIVE_TTL;
  const out = withDoHHeaders(res, isGaming);
  if (ok) await caches.default.put(cacheKey, out.clone());
  return out;
}

async function resolveName(request, env) {
  const u = new URL(request.url);
  const name = u.searchParams.get("name");
  const type = (u.searchParams.get("type") || "A").toUpperCase();
  if (!name) return new Response("Missing ?name=", { status: 400, headers: cors() });
  const q = buildQuery(name, qtype(type));
  const dnsB64 = b64urlEncode(q);
  const cacheKey = new Request(buildCacheKeyUrl(u.origin, dnsB64), { method: "GET" });
  const hit = await caches.default.match(cacheKey);
  if (hit) return withDoHHeaders(hit);
  const res = await sequential(dnsB64, env);
  if (!res) return new Response("Upstream failure", { status: 502, headers: cors() });
  const ttl = await dnsTtlOrDefault(res.clone(), DEFAULT_CACHE_TTL);
  const out = withDoHHeaders(res, false);
  await caches.default.put(cacheKey, out.clone());
  return out;
}

function withDoHHeaders(res, isGaming) {
  const h = new Headers();
  h.set("Content-Type", "application/dns-message");
  h.set("Cache-Control", `public, max-age=${isGaming ? GAMING_TTL : DEFAULT_CACHE_TTL}`);
  h.set("Access-Control-Allow-Origin", "*");
  h.set("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  h.set("Access-Control-Allow-Headers", "Content-Type, Accept");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function buildCacheKeyUrl(origin, dnsB64) {
  const u = new URL("/dns-query", origin);
  u.searchParams.set("dns", dnsB64);
  return u.toString();
}

async function race(dnsB64, env) {
  const top = (await ranked(env)).slice(0, RACING_PROVIDERS);
  const racers = top.map(p => fetchUp(p, dnsB64, env, true));
  try {
    const winner = await Promise.any(racers);
    return winner;
  } catch (e) {
    for (const p of top) {
      const r = await fetchUp(p, dnsB64, env, false).catch(() => null);
      if (r && r.ok) return r;
    }
    return null;
  }
}

async function sequential(dnsB64, env) {
  const list = await ranked(env);
  for (let i = 0; i < list.length; i++) {
    const r = await fetchUp(list[i], dnsB64, env, false).catch(() => null);
    if (r && r.ok) return r;
  }
  return null;
}

async function fetchUp(p, dnsB64, env, shortTimeout) {
  const u = new URL(p.url);
  u.searchParams.set("dns", dnsB64);
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), shortTimeout ? Math.min(800, TIMEOUT_MS) : TIMEOUT_MS);
  const t0 = Date.now();
  const req = new Request(u.toString(), { method: "GET", headers: { accept: "application/dns-message" }, signal: ctl.signal, cf: { cacheTtl: 0, cacheEverything: false } });
  try {
    const res = await fetch(req);
    const rtt = Date.now() - t0;
    clearTimeout(t);
    await observe(env, p.name, rtt, res.ok);
    return res;
  } catch (e) {
    clearTimeout(t);
    await observe(env, p.name, TIMEOUT_MS * 2, false);
    return new Response("fail", { status: 599 });
  }
}

async function ranked(env) {
  const m = await readMetrics(env);
  const scored = PROVIDERS.map(p => {
    const r = m[p.name];
    const rtt = r && r.rtt ? r.rtt : 20;
    const up = r && r.ok ? Math.max(0.1, r.ok / Math.max(1, r.n)) : 1;
    const s = p.w + 1000 / (rtt + 5) + 50 * up;
    return { name: p.name, url: p.url, w: p.w, rtt, score: s };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored;
}

async function observe(env, name, rtt, ok) {
  try {
    if (!env.PROVIDER_METRICS) return;
    const m = await readMetrics(env);
    const cur = m[name] || { n: 0, ok: 0, rtt: rtt };
    const a = 0.3;
    const n = cur.n + 1;
    const okc = cur.ok + (ok ? 1 : 0);
    const sm = cur.rtt * (1 - a) + rtt * a;
    m[name] = { n, ok: okc, rtt: Math.max(1, Math.round(sm)) };
    await env.PROVIDER_METRICS.put(METRICS_KEY, JSON.stringify(m));
  } catch {}
}

async function readMetrics(env) {
  try {
    if (!env.PROVIDER_METRICS) return {};
    const raw = await env.PROVIDER_METRICS.get(METRICS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

async function stats(env) {
  const m = await readMetrics(env);
  return { providers: await ranked(env), metrics: m, t: Date.now() };
}

async function bench(env) {
  const dnsB64 = b64urlEncode(buildQuery("cloudflare.com", 1));
  const top = PROVIDERS.slice(0);
  const results = [];
  for (const p of top) {
    const t0 = Date.now();
    const r = await fetchUp(p, dnsB64, env, true);
    results.push({ provider: p.name, status: r.status, rtt: Date.now() - t0 });
  }
  return { results, t: Date.now() };
}

async function health(env) {
  const dnsB64 = b64urlEncode(buildQuery("example.com", 1));
  for (const p of PROVIDERS) await fetchUp(p, dnsB64, env, true);
}

async function warm(env) {
  for (const d of WARM) {
    const q = b64urlEncode(buildQuery(d, 1));
    await sequential(q, env);
  }
}

function qtype(t) {
  if (t === "AAAA") return 28;
  if (t === "CNAME") return 5;
  if (t === "TXT") return 16;
  if (t === "MX") return 15;
  if (t === "NS") return 2;
  return 1;
}

function buildQuery(name, type) {
  const labels = name.split(".");
  const q = [];
  for (const l of labels) {
    q.push(l.length);
    for (let i = 0; i < l.length; i++) q.push(l.charCodeAt(i));
  }
  q.push(0);
  const id = Math.floor(Math.random() * 65536);
  const hdr = new Uint8Array(12);
  hdr[0] = (id >> 8) & 0xff; hdr[1] = id & 0xff;
  hdr[2] = 1; hdr[3] = 0;
  hdr[4] = 0; hdr[5] = 1;
  hdr[6] = hdr[7] = hdr[8] = hdr[9] = hdr[10] = hdr[11] = 0;
  const qname = new Uint8Array(q);
  const qtail = new Uint8Array(4);
  qtail[0] = (type >> 8) & 0xff; qtail[1] = type & 0xff;
  qtail[2] = 0; qtail[3] = 1;
  const out = new Uint8Array(hdr.length + qname.length + qtail.length);
  out.set(hdr, 0); out.set(qname, 12); out.set(qtail, 12 + qname.length);
  return out;
}

function safeExtractQname(b64) {
  try {
    const buf = b64urlDecode(b64);
    let i = 12, out = [];
    while (i < buf.length) {
      const len = buf[i++]; if (len === 0) break;
      if ((len & 0xc0) === 0xc0) return ""; 
      const label = [];
      for (let j = 0; j < len && i < buf.length; j++) label.push(String.fromCharCode(buf[i++]));
      out.push(label.join(""));
      if (out.join(".").length > 253) break;
    }
    return out.join(".").toLowerCase();
  } catch { return ""; }
}

async function dnsTtlOrDefault(res, dflt) {
  try {
    const ab = await res.clone().arrayBuffer();
    const buf = new Uint8Array(ab);
    let i = 4; 
    const qdcount = (buf[i] << 8) | buf[i+1]; i += 2;
    const ancount = (buf[i] << 8) | buf[i+1]; i += 6; 
    i = 12;
    for (let q = 0; q < qdcount; q++) { while (buf[i] && i < buf.length) i += 1 + buf[i]; i++; i += 4; }
    let best = dflt;
    for (let a = 0; a < ancount; a++) {
      if (i >= buf.length) break;
      if ((buf[i] & 0xc0) === 0xc0) i += 2; else { while (buf[i] && i < buf.length) i += 1 + buf[i]; i++; }
      i += 2;
      i += 2;
      const ttl = (buf[i]<<24)|(buf[i+1]<<16)|(buf[i+2]<<8)|buf[i+3]; i += 4;
      const rdlen = (buf[i]<<8)|buf[i+1]; i += 2 + rdlen;
      if (ttl > 0) best = Math.min(Math.max(ttl, 30), 1800);
    }
    return best;
  } catch { return dflt; }
}

function b64urlEncode(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function b64urlDecode(s) {
  const pad = s.length % 4 === 2 ? "==" : s.length % 4 === 3 ? "=" : "";
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}