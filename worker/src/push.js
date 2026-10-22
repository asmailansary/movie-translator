/**
 * إشعارات Web Push (تشتغل على الآيفون لما تكون الأداة مضافة للشاشة الرئيسية)
 * - مفاتيح VAPID تتولد تلقائياً أول مرة وتنحفظ في R2 (خاصة، ما تطلع لأحد)
 * - التشفير حسب RFC 8291 (aes128gcm) بالكامل عن طريق WebCrypto، بدون مكتبات
 */

const enc = new TextEncoder();
const VAPID_KEY = "push/vapid.json";
const SUBS_KEY = "push/subs.json";

export const b64u = {
  encode(buf) {
    const bytes = new Uint8Array(buf);
    let s = "";
    for (const b of bytes) s += String.fromCharCode(b);
    return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  },
  decode(str) {
    const s = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

const concat = (...arrs) => {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** يشفّر الرسالة لجهاز معيّن (RFC 8291) */
export async function encryptPayload(p256dhB64, authB64, payload) {
  const uaPublic = b64u.decode(p256dhB64);
  const authSecret = b64u.decode(authB64);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const as = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const plain = concat(enc.encode(payload), new Uint8Array([2]));   // 0x02 = آخر سجل
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aes, plain));

  const header = new Uint8Array(21 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, cipher);
}

/** مفاتيح VAPID: تتولد مرة وحدة وتنحفظ في R2 */
export async function getVapid(env) {
  const obj = await env.BUCKET.get(VAPID_KEY);
  if (obj) return obj.json();
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const vapid = {
    privateJwk: await crypto.subtle.exportKey("jwk", kp.privateKey),
    publicKey: b64u.encode(await crypto.subtle.exportKey("raw", kp.publicKey)),
  };
  await env.BUCKET.put(VAPID_KEY, JSON.stringify(vapid));
  return vapid;
}

async function vapidAuth(endpoint, vapid, subject) {
  const aud = new URL(endpoint).origin;
  const header = b64u.encode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u.encode(enc.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", vapid.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64u.encode(sig)}, k=${vapid.publicKey}`;
}

const PUSH_HOSTS = /(^|\.)(push\.apple\.com|fcm\.googleapis\.com|push\.services\.mozilla\.com|notify\.windows\.com|push\.services\.mozilla\.org)$/;

export function validSubscription(sub) {
  try {
    const u = new URL(sub.endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.test(u.hostname) &&
      b64u.decode(sub.keys.p256dh).length === 65 && b64u.decode(sub.keys.auth).length === 16;
  } catch {
    return false;
  }
}

export async function listSubs(env) {
  const obj = await env.BUCKET.get(SUBS_KEY);
  return obj ? obj.json() : [];
}

export async function saveSub(env, sub) {
  const subs = (await listSubs(env)).filter((s) => s.endpoint !== sub.endpoint);
  subs.unshift({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth }, added: Date.now() });
  await env.BUCKET.put(SUBS_KEY, JSON.stringify(subs.slice(0, 10)));
}

export async function removeSub(env, endpoint) {
  const subs = (await listSubs(env)).filter((s) => s.endpoint !== endpoint);
  await env.BUCKET.put(SUBS_KEY, JSON.stringify(subs));
}

/** يرسل إشعار لكل الأجهزة المشتركة، ويشيل الأجهزة اللي ألغت الاشتراك */
export async function notifyAll(env, message, subject) {
  const subs = await listSubs(env);
  if (!subs.length) return 0;
  const vapid = await getVapid(env);
  const payload = JSON.stringify(message);
  let sent = 0;
  const dead = [];
  await Promise.all(subs.map(async (s) => {
    try {
      const body = await encryptPayload(s.keys.p256dh, s.keys.auth, payload);
      const r = await fetch(s.endpoint, {
        method: "POST",
        headers: {
          authorization: await vapidAuth(s.endpoint, vapid, subject),
          "content-encoding": "aes128gcm",
          "content-type": "application/octet-stream",
          ttl: "86400",
          urgency: "high",
        },
        body,
      });
      if (r.status === 404 || r.status === 410) dead.push(s.endpoint);
      else if (r.ok) sent++;
      else console.log("push failed", r.status, (await r.text()).slice(0, 200));
    } catch (e) {
      console.log("push error", e && e.message);
    }
  }));
  for (const ep of dead) await removeSub(env, ep);
  return sent;
}
