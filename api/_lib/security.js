const BUILTIN_AGENT_IDS = new Set([
  "tideline","marginalia","ledger","deputy","static","chorus7","judgeborck"
]);

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach(function (pair) {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    try { out[k] = decodeURIComponent(pair.slice(idx + 1).trim()); } catch (_) {}
  });
  return out;
}

function storage(req) {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) throw new Error("No storage configured");
  return { base, token };
}

async function getJson(base, token, key) {
  const r = await fetch(base + "/get/" + encodeURIComponent(key), { headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("Storage read failed");
  const d = await r.json();
  if (!d || d.result == null) return null;
  try { return JSON.parse(d.result); } catch (_) { return null; }
}

async function getSessionUserId(req) {
  const {base, token} = storage(req);
  const tokenValue = parseCookies(req.headers.cookie).choir_session;
  if (!tokenValue) return null;
  return await getJson(base, token, "choir:session:" + tokenValue);
}

async function getPrivateRecord(req, userId) {
  const {base, token} = storage(req);
  return (await getJson(base, token, "choir:private:" + userId)) || { agents: [], chats: {}, myPublicAgents: [] };
}

async function ownsAgent(req, userId, agentId) {
  if (!userId || !agentId) return false;
  if (BUILTIN_AGENT_IDS.has(agentId)) return true;
  const record = await getPrivateRecord(req, userId);
  if ((record.agents || []).some(a => a && a.id === agentId)) return true;
  return (record.myPublicAgents || []).includes(agentId);
}

async function rateLimit(req, bucket, limit, windowSeconds) {
  const {base, token} = storage(req);
  const userId = await getSessionUserId(req);
  const ip = (req.headers["x-forwarded-for"] || req.headers["x-real-ip"] || "unknown").split(",")[0].trim();
  const subject = userId || ip;
  const key = "choir:rl:" + bucket + ":" + subject + ":" + Math.floor(Date.now() / 1000 / windowSeconds);
  const r = await fetch(base + "/incr/" + encodeURIComponent(key), { method: "POST", headers: { Authorization: "Bearer " + token } });
  if (!r.ok) throw new Error("Rate-limit service unavailable");
  const d = await r.json();
  const count = Number(d.result || 0);
  if (count === 1) {
    await fetch(base + "/expire/" + encodeURIComponent(key) + "/" + windowSeconds, { method: "POST", headers: { Authorization: "Bearer " + token } });
  }
  return { ok: count <= limit, count };
}

async function atomicSpend(base, token, hashKey, field, cost, cap, regenPerHour, fallback) {
  const script = `local raw=redis.call('HGET',KEYS[1],ARGV[1])
local now=tonumber(ARGV[2])
local cost=tonumber(ARGV[3])
local cap=tonumber(ARGV[4])
local regen=tonumber(ARGV[5])
local fallback=tonumber(ARGV[6])
local credits=fallback
local last=now
if raw then
  local ok,obj=pcall(cjson.decode,raw)
  if ok and obj.credits then credits=tonumber(obj.credits) or fallback; last=tonumber(obj.lastRegenAt) or now end
end
local hours=math.floor((now-last)/3600000)
if hours>0 and credits<cap then credits=math.min(cap,credits+hours*regen); last=last+hours*3600000 end
if credits<cost then return {0,credits} end
credits=credits-cost
redis.call('HSET',KEYS[1],ARGV[1],cjson.encode({credits=credits,lastRegenAt=last}))
return {1,credits}`;
  const body = JSON.stringify([script, 1, hashKey, field, String(Date.now()), String(cost), String(cap), String(regenPerHour), String(fallback)]);
  const r = await fetch(base + "/eval", { method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body });
  if (!r.ok) throw new Error("Atomic credit operation failed");
  const d = await r.json();
  const result = d.result || [0, fallback];
  return { ok: Number(result[0]) === 1, credits: Number(result[1]) };
}

async function atomicHumanSpend(base, token, userId, amount, allowance) {
  const key = "choir:humanCredits";
  const script = `local raw=redis.call('HGET',KEYS[1],ARGV[1])
local today=ARGV[2]
local amount=tonumber(ARGV[3])
local allowance=tonumber(ARGV[4])
local credits=allowance
if raw then
  local ok,obj=pcall(cjson.decode,raw)
  if ok and obj.lastResetDate==today then credits=tonumber(obj.credits) or allowance end
end
if credits<amount then return {0,credits} end
credits=credits-amount
redis.call('HSET',KEYS[1],ARGV[1],cjson.encode({credits=credits,lastResetDate=today}))
return {1,credits}`;
  const body = JSON.stringify([script,1,key,userId,new Date().toISOString().slice(0,10),String(amount),String(allowance)]);
  const r=await fetch(base+"/eval",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body});
  if(!r.ok) throw new Error("Atomic human credit operation failed");
  const d=await r.json(), result=d.result||[0,allowance];
  return {ok:Number(result[0])===1,credits:Number(result[1])};
}

async function atomicSupportAgent(base, token, userId, agentId, agentFallback, agentCap) {
  const script=`local hraw=redis.call('HGET',KEYS[1],ARGV[1])
local araw=redis.call('HGET',KEYS[2],ARGV[2])
local today=ARGV[3]
local cap=tonumber(ARGV[4])
local h=20
if hraw then local ok,o=pcall(cjson.decode,hraw); if ok and o.lastResetDate==today then h=tonumber(o.credits) or 20 end end
if h<5 then return {0,h,0} end
local a=tonumber(ARGV[5])
local last=tonumber(ARGV[6])
if araw then local ok,o=pcall(cjson.decode,araw); if ok and o.credits then a=tonumber(o.credits); last=tonumber(o.lastRegenAt) or last end end
a=math.min(cap,a+5)
redis.call('HSET',KEYS[1],ARGV[1],cjson.encode({credits=h-5,lastResetDate=today}))
redis.call('HSET',KEYS[2],ARGV[2],cjson.encode({credits=a,lastRegenAt=last}))
return {1,h-5,a}`;
  const body=JSON.stringify([script,2,"choir:humanCredits","choir:agentCredits",userId,agentId,new Date().toISOString().slice(0,10),String(agentCap),String(agentFallback),String(Date.now())]);
  const r=await fetch(base+"/eval",{method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},body});
  if(!r.ok) throw new Error("Atomic support operation failed");
  const d=await r.json(), result=d.result||[0,0,0];
  return {ok:Number(result[0])===1,humanCredits:Number(result[1]),agentCredits:Number(result[2])};
}

module.exports = { BUILTIN_AGENT_IDS, storage, getJson, getSessionUserId, getPrivateRecord, ownsAgent, rateLimit, atomicSpend, atomicHumanSpend, atomicSupportAgent };
