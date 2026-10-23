// Servidor de notificaciones push de Conexión AR (Cloudflare Workers).
// Recibe "hay un mensaje nuevo en la sala X" y avisa a los otros miembros de esa sala.
// No ve el contenido de los mensajes: solo el nombre de quien escribe y un texto genérico.

const FIRESTORE = "https://firestore.googleapis.com/v1";
const ALLOWED_ORIGINS = ["https://conexion-ar.web.app", "http://localhost:3000"];
// La apiKey de Firebase está restringida al sitio: el Worker se identifica como tal
const GOOGLE_HEADERS = { Referer: "https://conexion-ar.web.app/" };

const enc = new TextEncoder();

// ---------- Utilidades ----------
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

function fromB64url(text) {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(text.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

// ---------- Web Push (RFC 8291: cifrado aes128gcm, RFC 8292: VAPID) ----------
export async function encryptPayload(subscription, payload) {
  const uaPublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);

  const asKeys = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", asKeys.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, asKeys.privateKey, 256));

  const ikm = await hkdf(authSecret, shared, concat(enc.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\0"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat(enc.encode(payload), new Uint8Array([2]));
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext));

  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, ciphertext);
}

export async function vapidHeader(endpoint, env) {
  const jwk = JSON.parse(env.VAPID_PRIVATE_JWK.replace(/^﻿/, "").trim());
  const key = await crypto.subtle.importKey("jwk", { ...jwk, ext: true }, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const header = b64url(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc.encode(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: env.VAPID_SUBJECT,
  })));
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${env.VAPID_PUBLIC_KEY}`;
}

async function sendPush(subscription, data, env) {
  const body = await encryptPayload(subscription, JSON.stringify(data));
  const res = await fetch(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: await vapidHeader(subscription.endpoint, env),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: data.kind === "call" ? "30" : "86400",
      Urgency: "high",
    },
    body,
  });
  return res.status;
}

// ---------- Firestore (con un usuario anónimo, igual que la app) ----------
let session = null;

async function idToken(env) {
  if (session && session.expires > Date.now()) return session.token;
  const url = session?.refresh
    ? `https://securetoken.googleapis.com/v1/token?key=${env.FIREBASE_API_KEY}`
    : `https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${env.FIREBASE_API_KEY}`;
  const res = await fetch(url, session?.refresh
    ? { method: "POST", headers: { ...GOOGLE_HEADERS, "Content-Type": "application/x-www-form-urlencoded" }, body: `grant_type=refresh_token&refresh_token=${session.refresh}` }
    : { method: "POST", headers: { ...GOOGLE_HEADERS, "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) });
  if (!res.ok) {
    session = null;
    throw new Error(`auth ${res.status}`);
  }
  const d = await res.json();
  session = {
    token: d.idToken || d.id_token,
    refresh: d.refreshToken || d.refresh_token,
    expires: Date.now() + 50 * 60 * 1000,
  };
  return session.token;
}

const docsUrl = (env, path) => `${FIRESTORE}/projects/${env.FIREBASE_PROJECT}/databases/(default)/documents/${path}`;

async function listMembers(env, chatId) {
  const res = await fetch(`${docsUrl(env, `chats/${chatId}/members`)}?pageSize=100`, {
    headers: { ...GOOGLE_HEADERS, Authorization: `Bearer ${await idToken(env)}` },
  });
  if (!res.ok) throw new Error(`firestore ${res.status}`);
  return (await res.json()).documents || [];
}

async function removeSubscription(env, chatId, memberId, device) {
  const mask = encodeURIComponent(`push.\`${device}\``);
  await fetch(`${docsUrl(env, `chats/${chatId}/members/${memberId}`)}?updateMask.fieldPaths=${mask}`, {
    method: "PATCH",
    headers: { ...GOOGLE_HEADERS, Authorization: `Bearer ${await idToken(env)}`, "Content-Type": "application/json" },
    body: JSON.stringify({ fields: {} }),
  });
}

// ---------- Rutas ----------
async function notify(request, env) {
  const { chatId, from, to, title, body, kind } = await request.json();
  if (!/^[0-9a-f]{40}$/.test(chatId || "") || typeof from !== "string") return json({ error: "datos inválidos" }, 400);

  // kind: "msg" (mensaje), "call" (está sonando) o "missed" (reemplaza el aviso de la llamada)
  const safeKind = ["call", "missed"].includes(kind) ? kind : "msg";
  const data = {
    title: String(title || "Conexión AR").slice(0, 80),
    body: String(body || "Nuevo mensaje").slice(0, 120),
    kind: safeKind,
    tag: `${safeKind === "msg" ? "msg" : "call"}-${chatId.slice(0, 8)}`,
    chat: chatId,
  };

  let sent = 0;
  const statuses = [];
  const members = await listMembers(env, chatId);
  await Promise.all(members.map(async (member) => {
    const memberId = member.name.split("/").pop();
    if (memberId === from) return;
    if (Array.isArray(to) && to.length && !to.includes(memberId)) return;
    const devices = member.fields?.push?.mapValue?.fields || {};
    await Promise.all(Object.entries(devices).map(async ([device, value]) => {
      try {
        const status = await sendPush(JSON.parse(value.stringValue), data, env);
        statuses.push(status);
        if (status === 404 || status === 410) await removeSubscription(env, chatId, memberId, device);
        else if (status < 300) sent++;
      } catch (err) {
        statuses.push(err.message);
        console.log("push error", err.message);
      }
    }));
  }));
  return json({ sent, members: members.length, statuses });
}

// Servidor TURN de Metered: solo se usa si la conexión directa entre dispositivos falla.
// Usuario y contraseña están como secretos del Worker (no en el código).
function turn(env) {
  if (!env.TURN_USERNAME || !env.TURN_PASSWORD) return json({ iceServers: [] });
  const host = env.TURN_HOST || "us-central.relay.metered.ca";
  const auth = { username: env.TURN_USERNAME, credential: env.TURN_PASSWORD };
  return json({
    iceServers: [
      { urls: `turn:${host}:80`, ...auth },
      { urls: `turn:${host}:80?transport=tcp`, ...auth },
      { urls: `turn:${host}:443`, ...auth },
      { urls: `turns:${host}:443?transport=tcp`, ...auth },
    ],
  });
}

let corsOrigin = ALLOWED_ORIGINS[0];
function json(value, status = 200) {
  return new Response(status === 204 ? null : JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": corsOrigin,
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    corsOrigin = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
    if (request.method === "OPTIONS") return json(null, 204);

    const { pathname } = new URL(request.url);
    try {
      if (request.method === "POST" && pathname === "/notify") return await notify(request, env);
      if (pathname === "/turn") return turn(env);
      if (pathname === "/") return json({ ok: true, service: "conexion-ar-push" });
      return json({ error: "no encontrado" }, 404);
    } catch (err) {
      console.log("error", err.message);
      return json({ error: "error interno" }, 500);
    }
  },
};
