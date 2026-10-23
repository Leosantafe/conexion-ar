// Conexión AR: chat, audios, llamadas, videollamadas y archivos.
// - Sala rápida: todo viaja directo entre dos dispositivos (WebRTC). Firebase solo los presenta.
// - Sala privada: los mensajes se guardan cifrados de extremo a extremo en Firestore (historial,
//   mensajes pendientes, grupos). Las llamadas son directas entre dos personas (WebRTC).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  doc, collection, query, where, orderBy, limit, limitToLast,
  setDoc, getDoc, getDocFromCache, getDocFromServer, updateDoc, deleteDoc, addDoc, getDocs, onSnapshot, runTransaction,
  serverTimestamp, Timestamp, Bytes, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig, iceServers, pushConfig } from "./firebase-config.js";
import {
  deriveRoom, importKey, encryptBytes, decryptBytes, encryptJson, decryptJson, sha256Hex, toB64, normalizeRoom,
} from "./crypto.js";

const app = initializeApp(firebaseConfig);
const db = initializeFirestore(app, {
  localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }),
});
const authReady = signInAnonymously(getAuth(app));
authReady.catch((err) => console.error("Auth anónima falló:", err));

const $ = (sel) => document.querySelector(sel);

const APP_NAME = "Conexión AR";
const APP_URL = "https://conexion-ar.web.app/";
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);

// Siempre usar el dominio principal (no el alternativo *.firebaseapp.com)
if (location.hostname === "conexion-ar.firebaseapp.com") {
  location.replace(APP_URL + location.search);
}
const isTouch = matchMedia("(pointer: coarse)").matches;
const canShareScreen = Boolean(navigator.mediaDevices?.getDisplayMedia) && !isTouch;

const KEY_NAME = "conexion-ar-name";
const KEY_DEVICE = "conexion-ar-device";
const KEY_ROOMS = "conexion-ar-rooms-v2";
const KEY_NO_AUTO = "conexion-ar-no-auto";
const FIREBASE_ERROR = "No se pudo conectar con el servidor. Revisa tu conexión a internet.";

const CHUNK_SIZE = 16 * 1024;
const MAX_BUFFERED = 1024 * 1024;
const LINE_STALE_MS = 45000;
const MAX_VOICE_SECONDS = 300;
const MAX_HISTORY = 300;
const HISTORY_DAYS = 30;
const PART_SIZE = 700 * 1024;
const MAX_PRIVATE_FILE = 15 * 1024 * 1024;
const AUTO_DOWNLOAD = 2 * 1024 * 1024;
const ONLINE_MS = 100000;
const DAY_MS = 864e5;
const EMOJIS = "😀 😂 🤣 😊 😍 😘 😎 🤩 🥳 😇 🙂 😉 😜 🤔 🤗 😴 😢 😭 😡 😱 🤯 🥺 👍 👎 👏 🙏 💪 🤝 👋 ✌️ 👌 ❤️ 💔 🔥 ✨ 🎉 🎁 ⭐ ✅ ❌ 💯 📞 🎥 📷 💻 📱 🍕 ☕ 🌹 🐶 🐱".split(" ");
const SENDER_COLORS = ["#8b5cf6", "#ec4899", "#f97316", "#10b981", "#06b6d4", "#eab308"];

const state = {
  mode: null, // "quick" | "private"
  // WebRTC
  pc: null,
  dc: null,
  isCaller: false,
  unsubs: [],
  pendingIce: [],
  signalChain: Promise.resolve(),
  makingOffer: false,
  ignoreOffer: false,
  everConnected: false,
  left: false,
  // sala rápida
  roomId: null,
  shareLink: "",
  // punto de encuentro para conexiones directas (llamadas de salas privadas)
  line: null,
  lineGen: 0,
  lineTimers: [],
  restartPending: false,
  // sala privada
  chat: null, // { chatId, keyB64, label, key, ref }
  memberId: "", // misma persona = mismo nombre en la sala, desde cualquier dispositivo
  clockOffset: 0, // diferencia entre el reloj del servidor y el de este dispositivo
  retentionDays: HISTORY_DAYS, // mensajes temporales: 1, 7 o 30 días (lo elige cualquiera de la sala)
  chatUnsubs: [],
  chatTimers: [],
  chatChain: Promise.resolve(),
  fetchChain: Promise.resolve(),
  members: new Map(),
  msgs: new Map(),
  localFiles: new Map(),
  historyLoaded: false,
  enteredAt: 0,
  myRead: 0,
  readTimer: null,
  typingSent: 0,
  presenceTimer: null,
  call: null,
  incomingCall: null,
  // general
  myName: "",
  peerName: "Contacto",
  localStream: null,
  screenTrack: null,
  cameraTrack: null,
  inCall: false,
  callActive: false,
  incomingVideo: false,
  facing: "user",
  callTimer: null,
  callTimeout: null,
  recording: null,
  sendQueue: [],
  sending: false,
  incoming: null,
  unread: 0,
};

// ---------- Utilidades ----------
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};
const session = {
  get(k) { try { return sessionStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { sessionStorage.setItem(k, v); } catch { /* sin almacenamiento */ } },
};

function show(id) {
  document.querySelectorAll(".screen").forEach((s) => { s.hidden = s.id !== id; });
  document.documentElement.classList.toggle("chat-mode", id === "screen-chat");
}

// Pasos de la pantalla de inicio: "main" (elegir), "private" o "quick"
function showStep(step) {
  if (step !== "main" && !readName()) return;
  document.querySelectorAll("#screen-home .step").forEach((s) => { s.hidden = s.dataset.step !== step; });
  if (step === "private" && !isTouch) $("#lineName").focus();
}

// Diálogo propio en lugar de confirm() del navegador
function askConfirm({ title, text, yes }) {
  const modal = $("#confirmModal");
  $("#confirmTitle").textContent = title;
  $("#confirmText").textContent = text;
  $("#confirmYes").textContent = yes;
  modal.hidden = false;
  $("#confirmNo").focus();
  return new Promise((resolve) => {
    const close = (result) => {
      modal.hidden = true;
      $("#confirmYes").onclick = $("#confirmNo").onclick = modal.onclick = null;
      resolve(result);
    };
    $("#confirmYes").onclick = () => close(true);
    $("#confirmNo").onclick = () => close(false);
    modal.onclick = (e) => { if (e.target === modal) close(false); };
  });
}

// Ajusta la pantalla del chat al área visible (por ejemplo, cuando se abre el teclado del celular)
function setupViewport() {
  const vv = window.visualViewport;
  const root = document.documentElement;
  const update = () => {
    const height = vv ? vv.height : window.innerHeight;
    root.style.setProperty("--app-h", `${height}px`);
    root.style.setProperty("--app-top", `${vv ? vv.offsetTop : 0}px`);
    root.classList.toggle("kb-open", isTouch && window.innerHeight - height > 120);
    if (document.activeElement === $("#msgInput")) scrollToBottom(true);
  };
  update();
  if (vv) {
    vv.addEventListener("resize", update);
    vv.addEventListener("scroll", update);
  } else {
    window.addEventListener("resize", update);
  }
}

let toastTimer;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 3500);
}

function setStatus(text, kind = "") {
  const el = $("#connStatus");
  el.textContent = text;
  el.dataset.kind = kind;
}

const initial = (name) => (name.trim()[0] || "?").toUpperCase();
const timeLabel = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const isOnlyEmoji = (text) =>
  text.length <= 12 && /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|‍|️|\s)+$/u.test(text);

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(Date.now() - DAY_MS);
  if (d.toDateString() === today.toDateString()) return "Hoy";
  if (d.toDateString() === yesterday.toDateString()) return "Ayer";
  return d.toLocaleDateString([], { weekday: "long", day: "numeric", month: "long" });
}

function lastSeenLabel(ts) {
  const day = dayLabel(ts);
  return `${day === "Hoy" || day === "Ayer" ? day.toLowerCase() : day} a las ${timeLabel(ts)}`;
}

function formatSize(b) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 ** 2) return `${(b / 1024).toFixed(1)} KB`;
  if (b < 1024 ** 3) return `${(b / 1024 ** 2).toFixed(1)} MB`;
  return `${(b / 1024 ** 3).toFixed(2)} GB`;
}

function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

function formatClock(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function randomId(len, abc = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789") {
  return [...crypto.getRandomValues(new Uint8Array(len))].map((n) => abc[n % abc.length]).join("");
}
const makeCode = () => randomId(6, "ABCDEFGHJKLMNPQRSTUVWXYZ23456789");

function colorFor(id = "") {
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return SENDER_COLORS[h % SENDER_COLORS.length];
}

let cachedDeviceId;
function deviceId() {
  if (!cachedDeviceId) {
    cachedDeviceId = store.get(KEY_DEVICE) || randomId(16);
    store.set(KEY_DEVICE, cachedDeviceId);
  }
  return cachedDeviceId;
}

function readName() {
  const name = $("#nameInput").value.trim();
  if (!name) {
    toast("Escribe tu nombre");
    $("#nameInput").focus();
    return false;
  }
  state.myName = name;
  store.set(KEY_NAME, name);
  return true;
}

function triggerDownload(url, name) {
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
}

// Hora del servidor: así no importa si el reloj de algún dispositivo está atrasado o adelantado
const serverNow = () => Date.now() + state.clockOffset;

async function syncClock() {
  try {
    const t0 = Date.now();
    await setDoc(memberRef(), { clock: serverTimestamp() }, { merge: true });
    const t1 = Date.now();
    const snap = await getDocFromServer(memberRef());
    const server = snap.data()?.clock?.toMillis?.();
    if (server) state.clockOffset = server - (t0 + t1) / 2;
  } catch (err) {
    console.warn("Reloj:", err);
  }
}

const dcOpen = () => state.dc?.readyState === "open";
const send = (obj) => state.dc.send(JSON.stringify(obj));

// ---------- Conexión WebRTC ----------
// Suma el servidor TURN (puente para redes que bloquean la conexión directa), pedido al Worker
let turnServers = null;
async function loadIceServers() {
  if (turnServers || !pushConfig?.server) return;
  try {
    const res = await Promise.race([
      fetch(`${pushConfig.server}/turn`).then((r) => r.json()),
      new Promise((_, reject) => setTimeout(() => reject(new Error("tiempo agotado")), 3000)),
    ]);
    turnServers = res.iceServers || [];
  } catch (err) {
    console.warn("TURN:", err);
  }
}

function setupPeer() {
  const pc = new RTCPeerConnection({ iceServers: [...iceServers, ...(turnServers || [])] });
  state.pc = pc;

  pc.ontrack = (e) => {
    const video = $("#remoteVideo");
    video.srcObject = e.streams[0] || new MediaStream([e.track]);
    video.play().catch(() => {});
    if (e.track.kind === "video") $("#callView").classList.add("live");
  };

  // Renegociación (al iniciar/terminar llamadas) por el canal de datos,
  // usando el patrón "perfect negotiation".
  pc.onnegotiationneeded = async () => {
    if (!dcOpen()) return; // la negociación inicial va por Firestore
    try {
      state.makingOffer = true;
      await pc.setLocalDescription();
      send({ type: "sdp", description: pc.localDescription });
    } catch (err) {
      console.warn(err);
    } finally {
      state.makingOffer = false;
    }
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    if (state.mode === "quick") {
      if (s === "connected") setStatus("Conectado", "ok");
      else if (s === "disconnected") setStatus("Reconectando…", "warn");
      else if (s === "failed") setStatus("Conexión perdida", "bad");
    }
    if (s === "failed") {
      if (!$("#screen-wait").hidden) {
        $("#waitStatus").textContent =
          "No se pudo conectar. Tu red puede estar bloqueando la conexión directa (configura un servidor TURN).";
      }
      if (state.line && !dcOpen()) restartLine();
    }
  };
}

function teardownPeer() {
  state.unsubs.splice(0).forEach((unsub) => unsub());
  state.lineTimers.splice(0).forEach((t) => { clearTimeout(t); clearInterval(t); });
  if (state.dc) {
    state.dc.onopen = state.dc.onclose = state.dc.onmessage = null;
    try { state.dc.close(); } catch { /* ya cerrado */ }
  }
  if (state.pc) {
    const pc = state.pc;
    pc.onicecandidate = pc.ontrack = pc.onnegotiationneeded = pc.onconnectionstatechange = pc.ondatachannel = null;
    try { pc.close(); } catch { /* ya cerrado */ }
  }
  state.pc = state.dc = null;
  state.pendingIce = [];
  state.signalChain = Promise.resolve();
  state.makingOffer = state.ignoreOffer = false;
  state.incoming = null;
}

function addRemoteCandidate(candidate) {
  if (!state.pc) return;
  if (state.pc.remoteDescription) state.pc.addIceCandidate(candidate).catch(console.warn);
  else state.pendingIce.push(candidate);
}

function flushPendingIce() {
  state.pendingIce.splice(0).forEach((c) => state.pc.addIceCandidate(c).catch(console.warn));
}

// addMine: guarda un candidato propio en Firestore; theirs: consulta con los del otro lado.
function exchangeCandidates(addMine, theirs, extract = (data) => data) {
  state.pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    if (dcOpen()) send({ type: "ice", candidate: e.candidate.toJSON() });
    else addMine(e.candidate.toJSON()).catch(console.warn);
  };
  state.unsubs.push(onSnapshot(theirs, (snap) => {
    snap.docChanges().forEach((change) => {
      if (change.type === "added") addRemoteCandidate(extract(change.doc.data()));
    });
  }));
}

async function onRemoteDescription(description) {
  const pc = state.pc;
  const polite = !state.isCaller;
  const collision = description.type === "offer" && (state.makingOffer || pc.signalingState !== "stable");
  state.ignoreOffer = !polite && collision;
  if (state.ignoreOffer) return;
  await pc.setRemoteDescription(description);
  if (description.type === "offer") {
    await pc.setLocalDescription();
    send({ type: "sdp", description: pc.localDescription });
  }
}

function bindDataChannel(dc) {
  state.dc = dc;
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = 256 * 1024;
  dc.onopen = onConnected;
  dc.onclose = onDisconnected;
  dc.onmessage = (e) => {
    if (typeof e.data === "string") handleMessage(JSON.parse(e.data));
    else handleChunk(e.data);
  };
}

// ---------- Salas rápidas (código de 6 letras) ----------
async function createRoom() {
  if (!readName()) return;
  setBusy(true);
  try {
    await authReady;
    state.mode = "quick";
    state.isCaller = true;
    state.roomId = makeCode();
    const roomRef = doc(db, "rooms", state.roomId);

    await loadIceServers();
    setupPeer();
    bindDataChannel(state.pc.createDataChannel("chat"));
    exchangeCandidates(
      (c) => addDoc(collection(roomRef, "callerCandidates"), c),
      collection(roomRef, "calleeCandidates"),
    );

    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    await setDoc(roomRef, { offer: { type: offer.type, sdp: offer.sdp }, created: Date.now() });

    state.unsubs.push(onSnapshot(roomRef, async (snap) => {
      const data = snap.data();
      if (data?.answer && !state.pc.currentRemoteDescription) {
        await state.pc.setRemoteDescription(data.answer);
        flushPendingIce();
        $("#waitStatus").textContent = "Conectando…";
      }
    }));

    showWaiting("room");
  } catch (err) {
    console.error(err);
    toast(FIREBASE_ERROR);
  } finally {
    setBusy(false);
  }
}

async function joinRoom() {
  if (!readName()) return;
  const code = $("#codeInput").value.trim().toUpperCase();
  if (!code) {
    toast("Escribe el código de la sala");
    return;
  }
  setBusy(true);
  try {
    await authReady;
    const roomRef = doc(db, "rooms", code);
    const snap = await getDoc(roomRef);
    if (!snap.exists()) return toast("Esa sala no existe");
    if (snap.data().answer) return toast("Esa sala ya está ocupada");

    state.mode = "quick";
    state.isCaller = false;
    state.roomId = code;
    await loadIceServers();
    setupPeer();
    state.pc.ondatachannel = (e) => bindDataChannel(e.channel);

    await state.pc.setRemoteDescription(snap.data().offer);
    exchangeCandidates(
      (c) => addDoc(collection(roomRef, "calleeCandidates"), c),
      collection(roomRef, "callerCandidates"),
    );
    const answer = await state.pc.createAnswer();
    await state.pc.setLocalDescription(answer);
    await updateDoc(roomRef, { answer: { type: answer.type, sdp: answer.sdp } });

    showWaiting("join");
  } catch (err) {
    console.error(err);
    toast(FIREBASE_ERROR);
  } finally {
    setBusy(false);
  }
}

function setBusy(busy) {
  ["#createBtn", "#joinBtn", "#lineBtn"].forEach((sel) => { $(sel).disabled = busy; });
}

function inviteLink() {
  const base = isLocal ? `${location.origin}${location.pathname}` : APP_URL;
  return `${base}?sala=${state.roomId}`;
}

async function cleanupRoom() {
  // Borra los datos de señalización: ya no hacen falta una vez conectados.
  try {
    const roomRef = doc(db, "rooms", state.roomId);
    for (const sub of ["callerCandidates", "calleeCandidates"]) {
      const snap = await getDocs(collection(roomRef, sub));
      await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
    }
    await deleteDoc(roomRef);
  } catch (err) {
    console.warn("No se pudo limpiar la sala:", err);
  }
}

// ---------- Punto de encuentro para conexiones directas ----------
// Dos dispositivos con el mismo "secret" se encuentran: el primero espera ("caller") y el
// segundo responde ("callee"). Una transacción evita que los dos esperen a la vez.
async function joinLine({ force = false } = {}) {
  teardownPeer();
  await loadIceServers();
  const gen = ++state.lineGen;
  const lineRef = doc(db, "lines", state.line.secret);
  const me = deviceId();
  const newSession = randomId(12);

  const result = await runTransaction(db, async (tx) => {
    const snap = await tx.get(lineRef);
    const d = snap.data();
    const someoneWaiting = !force && d?.state === "waiting" && d.from !== me
      && serverNow() - (d.alive || 0) < LINE_STALE_MS;
    if (someoneWaiting) {
      tx.update(lineRef, { state: "claimed", claimedBy: me });
      return { role: "callee", session: d.session };
    }
    tx.set(lineRef, { state: "waiting", from: me, session: newSession, alive: serverNow(), offer: null, answer: null });
    return { role: "caller", session: newSession };
  });
  if (gen !== state.lineGen) return;

  state.isCaller = result.role === "caller";
  setupPeer();

  const iceCol = collection(lineRef, "ice");
  exchangeCandidates(
    (c) => addDoc(iceCol, { session: result.session, role: result.role, c }),
    query(iceCol, where("session", "==", result.session), where("role", "==", state.isCaller ? "callee" : "caller")),
    (data) => data.c,
  );

  const watch = (onData) => {
    state.unsubs.push(onSnapshot(lineRef, (snap) => {
      const d = snap.data();
      if (!d || gen !== state.lineGen) return;
      // Otro dispositivo reinició el encuentro: volver a intentar
      if (d.session !== result.session) return restartLine();
      onData(d).catch(console.error);
    }));
  };

  if (state.isCaller) {
    bindDataChannel(state.pc.createDataChannel("chat"));
    const offer = await state.pc.createOffer();
    await state.pc.setLocalDescription(offer);
    if (gen !== state.lineGen) return;
    await updateDoc(lineRef, { offer: { type: offer.type, sdp: offer.sdp } });

    const beat = () => {
      if (gen === state.lineGen && !dcOpen()) updateDoc(lineRef, { alive: serverNow() }).catch(() => {});
    };
    state.lineTimers.push(setInterval(beat, 15000));

    watch(async (d) => {
      if (d.answer && !state.pc.currentRemoteDescription) {
        await state.pc.setRemoteDescription(d.answer);
        flushPendingIce();
      }
    });
  } else {
    state.pc.ondatachannel = (e) => bindDataChannel(e.channel);
    watch(async (d) => {
      if (d.offer && !state.pc.remoteDescription) {
        await state.pc.setRemoteDescription(d.offer);
        flushPendingIce();
        const answer = await state.pc.createAnswer();
        await state.pc.setLocalDescription(answer);
        await updateDoc(lineRef, { answer: { type: answer.type, sdp: answer.sdp }, state: "answered" });
      }
    });
    // Si quien esperaba ya no está, esperar nosotros
    state.lineTimers.push(setTimeout(() => {
      if (gen === state.lineGen && !dcOpen()) restartLine({ force: true });
    }, 20000));
  }
}

function restartLine(options) {
  if (state.left || !state.line || state.restartPending) return;
  state.restartPending = true;
  // Pequeña espera aleatoria para que los dos dispositivos no choquen
  setTimeout(() => {
    state.restartPending = false;
    if (state.left || !state.line) return;
    joinLine(options).catch((err) => {
      console.error(err);
      setTimeout(() => restartLine(), 5000);
    });
  }, 400 + Math.random() * 800);
}

async function cleanupLine(secret) {
  try {
    const lineRef = doc(db, "lines", secret);
    const snap = await getDocs(collection(lineRef, "ice"));
    await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
    await deleteDoc(lineRef);
  } catch (err) {
    console.warn("No se pudo limpiar el punto de encuentro:", err);
  }
}

// ---------- Salas privadas: guardadas y formulario ----------
function getSavedRooms() {
  try {
    return (JSON.parse(store.get(KEY_ROOMS)) || []).filter((r) => r.chatId && r.keyB64);
  } catch {
    return [];
  }
}

function setSavedRooms(list) {
  store.set(KEY_ROOMS, JSON.stringify(list));
  renderSavedRooms();
}

function renderSavedRooms() {
  const list = getSavedRooms();
  $("#contactsBox").hidden = !list.length;
  $("#contactList").replaceChildren(...list.map((room) => {
    const row = document.createElement("div");
    row.className = "contact";

    const main = document.createElement("button");
    main.type = "button";
    main.className = "contact-main";
    main.innerHTML = '<span class="avatar"></span><span class="contact-text"><strong></strong><small>Toca para entrar</small></span><svg class="i"><use href="#i-arrow"/></svg>';
    main.querySelector(".avatar").textContent = initial(room.label);
    main.querySelector("strong").textContent = room.label;
    main.addEventListener("click", () => enterChat(room));

    const del = document.createElement("button");
    del.type = "button";
    del.className = "icon-btn sm";
    del.setAttribute("aria-label", `Olvidar ${room.label}`);
    del.innerHTML = '<svg class="i"><use href="#i-trash"/></svg>';
    del.addEventListener("click", async () => {
      const ok = await askConfirm({
        title: `¿Olvidar «${room.label}»?`,
        text: "Se borra solo de este dispositivo. Podrás volver a entrar escribiendo el nombre y la contraseña.",
        yes: "Olvidar",
      });
      if (ok) setSavedRooms(getSavedRooms().filter((r) => r.chatId !== room.chatId));
    });

    row.append(main, del);
    return row;
  }));
}

async function submitPrivateForm(e) {
  e.preventDefault();
  if (!readName()) return;
  const label = $("#lineName").value.trim();
  const password = $("#linePass").value;
  if (label.length < 3) {
    toast("El nombre de la sala debe tener al menos 3 letras");
    $("#lineName").focus();
    return;
  }
  if (password.length < 6) {
    toast("La contraseña debe tener al menos 6 caracteres");
    $("#linePass").focus();
    return;
  }
  setBusy(true);
  try {
    const room = { ...(await deriveRoom(label, password)), label };
    if ($("#lineRemember").checked) {
      setSavedRooms([room, ...getSavedRooms().filter((r) => r.chatId !== room.chatId)]);
    }
    $("#linePass").value = "";
    await enterChat(room);
  } finally {
    setBusy(false);
  }
}

// ---------- Salas privadas: chat cifrado en Firestore ----------
const chatCol = (name) => collection(state.chat.ref, name);
const memberRef = () => doc(chatCol("members"), state.memberId);
const memberName = (id) => (id === state.memberId ? state.myName : state.members.get(id)?.name || "Alguien");

function others() {
  return [...state.members].filter(([id, m]) => id !== state.memberId && serverNow() - m.lastSeen < HISTORY_DAYS * DAY_MS);
}

function saveMember(data) {
  if (!state.chat) return;
  setDoc(memberRef(), data, { merge: true }).catch((err) => console.warn("member:", err));
}

async function encryptedName() {
  const { iv, ct } = await encryptJson(state.chat.key, { name: state.myName });
  return { nameIv: Bytes.fromUint8Array(iv), nameCt: Bytes.fromUint8Array(ct) };
}

async function enterChat(room) {
  if (!readName()) return;
  try {
    await authReady;
    state.mode = "private";
    state.chat = { ...room, key: await importKey(room.keyB64), ref: doc(db, "chats", room.chatId) };
    state.memberId = (await sha256Hex(`${room.chatId}|${normalizeRoom(state.myName)}`)).slice(0, 20);
    state.enteredAt = Date.now();
    state.historyLoaded = false;

    $("#messages").replaceChildren();
    $("#peerName").textContent = room.label;
    $("#peerAvatar").textContent = initial(room.label);
    setStatus("Cargando…");
    $("#composer").classList.remove("disabled");
    $("#audioCallBtn").disabled = false;
    $("#videoCallBtn").disabled = false;
    $("#menuBtn").hidden = false;
    updateNotifButton();
    show("screen-chat");

    // Sincronizar el reloj con el servidor (máximo 3 segundos de espera)
    await Promise.race([syncClock(), new Promise((r) => setTimeout(r, 3000))]);
    subscribePrivate();
    setDoc(state.chat.ref, { v: 2 }, { merge: true }).catch((err) => console.warn(err));
    saveMember({ lastSeen: serverNow(), ...(await encryptedName()) });
    state.chatTimers.push(setInterval(heartbeat, 45000), setInterval(renderPresence, 15000));
    setupPush();
    if ("Notification" in window && Notification.permission === "default" && !store.get("conexion-ar-notif-hint")) {
      store.set("conexion-ar-notif-hint", "1");
      setTimeout(() => toast("Toca la 🔔 de arriba para recibir avisos aunque la app esté cerrada"), 1500);
    }
    setTimeout(cleanupOldData, 5000);
    state.chatTimers.push(setInterval(cleanupOldData, 60 * 60 * 1000));
  } catch (err) {
    console.error(err);
    toast(FIREBASE_ERROR);
  }
}

function subscribePrivate() {
  const me = state.memberId;
  const queue = (fn) => (snap) => {
    state.chatChain = state.chatChain.then(() => fn(snap)).catch(console.error);
  };
  state.chatUnsubs.push(
    onSnapshot(state.chat.ref, (snap) => applyRetention(snap.data()?.retention)),
    onSnapshot(chatCol("members"), queue(applyMembers)),
    onSnapshot(
      query(chatCol("messages"), orderBy("ts"), limitToLast(MAX_HISTORY)),
      { includeMetadataChanges: true },
      queue(applyMessages),
    ),
    onSnapshot(
      query(chatCol("calls"), where("to", "==", me), where("state", "==", "ringing")),
      (snap) => snap.docChanges().forEach(onCallDocChange),
    ),
  );
}

function heartbeat() {
  if (state.mode === "private" && !document.hidden) saveMember({ lastSeen: serverNow() });
}

async function applyMembers(snap) {
  for (const change of snap.docChanges()) {
    const id = change.doc.id;
    if (change.type === "removed") {
      state.members.delete(id);
      continue;
    }
    const d = change.doc.data();
    const prev = state.members.get(id);
    let name = prev?.name || "Alguien";
    const nameTag = d.nameIv ? toB64(d.nameIv.toUint8Array()) : "";
    if (d.nameCt && nameTag !== prev?.nameTag) {
      try {
        name = (await decryptJson(state.chat.key, d.nameIv.toUint8Array(), d.nameCt.toUint8Array())).name || name;
      } catch { /* nombre ilegible */ }
    }
    state.members.set(id, {
      name, nameTag, lastSeen: d.lastSeen || 0, lastRead: d.lastRead || 0, typing: d.typing || 0,
    });
  }
  renderPresence();
  refreshTicks();
  document.querySelectorAll(".sender[data-from]").forEach((el) => { el.textContent = memberName(el.dataset.from); });
}

function renderPresence() {
  if (state.mode !== "private" || !state.chat) return;
  const list = others();
  const now = serverNow();
  const typing = list.filter(([, m]) => now - m.typing < 6000);
  const online = list.filter(([, m]) => now - m.lastSeen < ONLINE_MS);
  const title = list.length === 1 ? list[0][1].name : state.chat.label;
  state.peerName = title;
  // En grupos se muestra quién escribió cada mensaje
  $("#messages").classList.toggle("group", list.length > 1);
  $("#peerName").textContent = title;
  $("#peerAvatar").textContent = initial(title);

  const status = $("#connStatus");
  status.classList.toggle("typing", typing.length > 0);
  if (typing.length) {
    const names = typing.map(([, m]) => m.name).join(", ");
    setStatus(list.length === 1 ? "escribiendo…" : `${names} ${typing.length > 1 ? "están" : "está"} escribiendo…`);
    clearTimeout(state.presenceTimer);
    state.presenceTimer = setTimeout(renderPresence, 3000);
  } else if (!list.length) {
    setStatus("Nadie más entró todavía");
  } else if (list.length === 1) {
    setStatus(online.length ? "en línea" : `últ. vez ${lastSeenLabel(list[0][1].lastSeen)}`, online.length ? "ok" : "");
  } else {
    setStatus(`${list.length + 1} personas · ${online.length} en línea`, online.length ? "ok" : "");
  }
}

async function applyMessages(snap) {
  const me = state.memberId;
  const firstLoad = !state.historyLoaded;
  for (const change of snap.docChanges({ includeMetadataChanges: true })) {
    const id = change.doc.id;
    const existing = state.msgs.get(id);
    if (change.type === "removed") {
      existing?.el.remove();
      state.msgs.delete(id);
      continue;
    }
    const d = change.doc.data({ serverTimestamps: "estimate" });
    const ts = d.ts?.toMillis ? d.ts.toMillis() : Date.now();
    if (!existing && ts < retentionCutoff()) continue; // ya venció (se borra en la próxima limpieza)
    const pending = change.doc.metadata.hasPendingWrites;
    if (existing) {
      existing.pending = pending;
      updateTicks(existing);
      continue;
    }
    let body;
    try {
      body = await decryptJson(state.chat.key, d.iv.toUint8Array(), d.ct.toUint8Array());
    } catch {
      body = { t: "text", text: "🔒 Mensaje ilegible" };
    }
    const entry = { id, from: d.from, mine: d.from === me, ts, pending, body };
    entry.el = renderPrivateMessage(entry);
    state.msgs.set(id, entry);
    updateTicks(entry);
    if (!entry.mine && !firstLoad && ts > state.enteredAt - 3000) onIncomingPrivate(entry);
  }
  refreshDays();
  if (firstLoad) {
    state.historyLoaded = true;
    scrollToBottom(true);
  }
  markRead();
}

function renderPrivateMessage(entry) {
  const b = entry.body;
  const opts = {
    ts: entry.ts,
    ticks: entry.mine,
    senderId: entry.mine ? "" : entry.from,
  };
  if (b.t === "call") return addCallLog(entry);
  if (b.t === "setting" || b.t === "cleared") return addInfoLog(entry);
  if (b.t === "file") {
    const ui = addFileMessage({ name: b.name, size: b.size, mine: entry.mine, voice: b.voice, duration: b.duration }, opts);
    loadPrivateFile(entry, ui);
    return ui.el;
  }
  return addTextMessage(b.text || "", entry.mine, opts);
}

function updateTicks(entry) {
  if (!entry.mine) return;
  const ticks = entry.el?.querySelector(".ticks");
  if (!ticks) return;
  const list = others();
  const read = !entry.pending && list.length > 0 && list.every(([, m]) => m.lastRead >= entry.ts);
  const icon = entry.pending ? "#i-clock" : read ? "#i-checks" : "#i-check";
  ticks.classList.toggle("read", read);
  ticks.querySelector("use").setAttribute("href", icon);
  ticks.title = entry.pending ? "Enviando" : read ? "Leído" : "Enviado";
}

function refreshTicks() {
  state.msgs.forEach(updateTicks);
}

// Separadores "Hoy", "Ayer", etc.
function refreshDays() {
  const list = $("#messages");
  list.querySelectorAll(".day").forEach((el) => el.remove());
  let last = "";
  [...list.children].forEach((el) => {
    const ts = Number(el.dataset.ts);
    if (!ts) return;
    const label = dayLabel(ts);
    if (label !== last) {
      const day = document.createElement("div");
      day.className = "day";
      day.dataset.ts = String(ts);
      day.textContent = label;
      el.before(day);
      last = label;
    }
  });
}

function markRead() {
  if (state.mode !== "private" || document.hidden) return;
  let newest = 0;
  state.msgs.forEach((m) => { if (!m.mine && m.ts > newest) newest = m.ts; });
  if (newest <= state.myRead) return;
  state.myRead = newest;
  clearTimeout(state.readTimer);
  state.readTimer = setTimeout(() => saveMember({ lastRead: state.myRead, lastSeen: serverNow() }), 800);
}

function onIncomingPrivate(entry) {
  notifyUnread();
  if (!document.hidden) return;
  const b = entry.body;
  const preview = b.t === "file" ? (b.voice ? "🎤 Audio" : `📎 ${b.name}`) : b.t === "call" ? "📞 Llamada" : b.text;
  const title = others().length > 1 ? `${memberName(entry.from)} · ${state.chat.label}` : memberName(entry.from);
  localNotify(title, preview, `msg-${state.chat.chatId}`);
}

async function sendPrivate(body, ref = doc(chatCol("messages"))) {
  const { iv, ct } = await encryptJson(state.chat.key, body);
  setDoc(ref, {
    from: state.memberId, ts: serverTimestamp(), iv: Bytes.fromUint8Array(iv), ct: Bytes.fromUint8Array(ct),
  }).catch((err) => {
    console.error(err);
    toast("No se pudo enviar el mensaje");
  });
  pushNotify(body);
  return ref.id;
}

async function sendPrivateFile({ file, meta }) {
  file = await compressImage(file);
  if (file.size > MAX_PRIVATE_FILE) {
    toast(`En salas privadas el máximo es ${formatSize(MAX_PRIVATE_FILE)} por archivo`);
    return;
  }
  const ref = doc(chatCol("messages"));
  const ui = addFileMessage({ name: file.name, size: file.size, mine: true, ...meta });
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parts = Math.max(1, Math.ceil(bytes.length / PART_SIZE));
  try {
    for (let i = 0; i < parts; i++) {
      const { iv, ct } = await encryptBytes(state.chat.key, bytes.subarray(i * PART_SIZE, (i + 1) * PART_SIZE));
      await setDoc(doc(chatCol("parts"), `${ref.id}_${i}`), {
        msg: ref.id, ts: serverTimestamp(), iv: Bytes.fromUint8Array(iv), ct: Bytes.fromUint8Array(ct),
      });
      ui.progress((i + 1) / parts);
    }
  } catch (err) {
    console.error(err);
    ui.fail();
    return;
  }
  state.localFiles.set(ref.id, URL.createObjectURL(file));
  ui.el.remove();
  await sendPrivate({ t: "file", name: file.name, mime: file.type, size: file.size, parts, ...meta }, ref);
}

function loadPrivateFile(entry, ui) {
  const b = entry.body;
  const local = state.localFiles.get(entry.id);
  if (local) return ui.done(local, b.mime);
  const media = /^(image|audio|video)\//.test(b.mime || "");
  if (b.voice || media || b.size <= AUTO_DOWNLOAD) fetchParts(entry, ui, false);
  else ui.lazy(() => fetchParts(entry, ui, true));
}

function fetchParts(entry, ui, download) {
  const b = entry.body;
  state.fetchChain = state.fetchChain.then(async () => {
    try {
      const chunks = [];
      for (let i = 0; i < b.parts; i++) {
        const ref = doc(chatCol("parts"), `${entry.id}_${i}`);
        let snap;
        try { snap = await getDocFromCache(ref); } catch { snap = await getDoc(ref); }
        if (!snap.exists()) throw new Error("falta una parte");
        const d = snap.data();
        chunks.push(await decryptBytes(state.chat.key, d.iv.toUint8Array(), d.ct.toUint8Array()));
        ui.progress((i + 1) / b.parts);
      }
      const url = URL.createObjectURL(new Blob(chunks, { type: b.mime || "application/octet-stream" }));
      state.localFiles.set(entry.id, url);
      ui.done(url, b.mime);
      if (download) triggerDownload(url, b.name);
    } catch (err) {
      console.warn(err);
      ui.fail("Ya no está disponible");
    }
  });
}

// ---------- Mensajes temporales y vaciar chat ----------
const retentionCutoff = () => serverNow() - state.retentionDays * DAY_MS;
const RETENTION_LABEL = { 1: "24 horas", 7: "7 días", 30: "30 días" };

// Borra en tandas todo lo que devuelve la consulta (hasta 4000 documentos por vez)
async function deleteAll(q) {
  for (let round = 0; round < 20; round++) {
    const snap = await getDocs(q);
    if (snap.empty) return;
    const batch = writeBatch(db);
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    if (snap.size < 200) return;
  }
}

async function cleanupOldData() {
  if (!state.chat) return;
  try {
    const cutoff = Timestamp.fromMillis(retentionCutoff());
    for (const name of ["messages", "parts"]) {
      await deleteAll(query(chatCol(name), where("ts", "<", cutoff), limit(200)));
    }
    await deleteAll(query(chatCol("calls"), where("at", "<", serverNow() - DAY_MS), limit(200)));
  } catch (err) {
    console.warn("Limpieza:", err);
  }
}

function applyRetention(days) {
  state.retentionDays = [1, 7, 30].includes(days) ? days : HISTORY_DAYS;
  document.querySelectorAll("#roomMenu [data-days]").forEach((b) => {
    b.setAttribute("aria-checked", String(Number(b.dataset.days) === state.retentionDays));
  });
  // Quitar de la vista lo que ya venció con la nueva duración
  const cutoff = retentionCutoff();
  state.msgs.forEach((m, id) => {
    if (m.ts < cutoff) {
      m.el.remove();
      state.msgs.delete(id);
    }
  });
  refreshDays();
}

async function setRetention(days) {
  $("#roomMenu").hidden = true;
  if (days === state.retentionDays) return;
  try {
    await setDoc(state.chat.ref, { retention: days }, { merge: true });
    sendPrivate({ t: "setting", retention: days });
    setTimeout(cleanupOldData, 2000);
  } catch (err) {
    console.error(err);
    toast(FIREBASE_ERROR);
  }
}

async function clearChat() {
  $("#roomMenu").hidden = true;
  const ok = await askConfirm({
    title: "¿Vaciar el chat?",
    text: "Se borrarán todos los mensajes, fotos, audios y archivos de esta sala para todos. No se puede deshacer.",
    yes: "Vaciar",
  });
  if (!ok) return;
  toast("Vaciando el chat…");
  try {
    for (const name of ["messages", "parts", "calls"]) {
      await deleteAll(query(chatCol(name), limit(200)));
    }
    state.localFiles.clear();
    sendPrivate({ t: "cleared" });
    toast("Chat vaciado");
  } catch (err) {
    console.error(err);
    toast(FIREBASE_ERROR);
  }
}

function addInfoLog(entry) {
  const who = entry.mine ? "Activaste" : `${memberName(entry.from)} activó`;
  const text = entry.body.t === "cleared"
    ? `${entry.mine ? "Vaciaste" : `${memberName(entry.from)} vació`} el chat`
    : `${who} mensajes temporales: ${RETENTION_LABEL[entry.body.retention] || "30 días"}`;
  const el = document.createElement("div");
  el.className = "call-log info";
  el.innerHTML = `<svg class="i"><use href="#i-${entry.body.t === "cleared" ? "trash" : "timer"}"/></svg><span></span><time></time>`;
  el.querySelector("span").textContent = text;
  el.querySelector("time").textContent = timeLabel(entry.ts);
  insertByTs(el, entry.ts);
  scrollToBottom(false);
  return el;
}

// ---------- Pantalla de espera (salas rápidas) ----------
function showWaiting(mode) {
  const texts = {
    room: ["Tu sala está lista", "Escanea el QR con el otro dispositivo o comparte el enlace", "Esperando al otro dispositivo…"],
    join: ["Uniéndote a la sala", "", `Conectando con la sala ${state.roomId}…`],
  }[mode];
  $("#waitTitle").textContent = texts[0];
  $("#waitText").textContent = texts[1];
  $("#waitText").hidden = !texts[1];
  $("#waitStatus").textContent = texts[2];
  $("#waitAvatar").hidden = true;
  $("#shareBox").hidden = mode !== "room";

  if (mode === "room") {
    state.shareLink = inviteLink();
    $("#roomCode").replaceChildren(...[...state.roomId].map((ch) => {
      const span = document.createElement("span");
      span.textContent = ch;
      return span;
    }));
    $("#qr").innerHTML = "";
    if (window.QRCode) {
      new QRCode($("#qr"), { text: state.shareLink, width: 400, height: 400, colorDark: "#1e1b4b", colorLight: "#ffffff" });
    } else {
      $("#qr").hidden = true;
    }
    $("#shareBtn").hidden = !navigator.share;
  }
  show("screen-wait");
}

// ---------- Conexión directa establecida / perdida ----------
function onConnected() {
  state.unsubs.splice(0).forEach((unsub) => unsub());
  state.lineTimers.splice(0).forEach((t) => { clearTimeout(t); clearInterval(t); });

  if (state.mode === "private") {
    // En salas privadas la conexión directa es solo para la llamada
    const call = state.call;
    if (!call) return teardownPeer();
    if (state.isCaller) setTimeout(() => cleanupLine(call.lineSecret), 3000);
    call.start = Date.now();
    clearTimeout(call.connectTimer);
    clearTimeout(state.callTimeout);
    addLocalTracks();
    startCallTimer();
    return;
  }

  if (state.isCaller) setTimeout(cleanupRoom, 3000);
  send({ type: "hello", name: state.myName });
  setStatus("Conectado", "ok");
  $("#composer").classList.remove("disabled");
  $("#audioCallBtn").disabled = false;
  $("#videoCallBtn").disabled = false;

  const reconnected = state.everConnected;
  state.everConnected = true;
  if (!reconnected) {
    $("#peerName").textContent = state.peerName;
    $("#peerAvatar").textContent = initial(state.peerName);
  }
  show("screen-chat");
  addSystemMessage(reconnected ? "Reconectado 🔒" : "Conexión directa establecida 🔒");
}

function onDisconnected() {
  if (state.left) return;
  if (state.mode === "private") {
    finishCall({ notify: false });
    return;
  }
  endCall(false);
  cancelRecording();
  state.incoming = null;
  $("#composer").classList.add("disabled");
  $("#audioCallBtn").disabled = true;
  $("#videoCallBtn").disabled = true;
  setStatus("Desconectado", "bad");
  addSystemMessage(`${state.peerName} se desconectó`);
}

function leave() {
  state.left = true;
  if (state.mode === "private") finishCall();
  else endCall(true);
  cancelRecording();
  teardownPeer();
  state.chatUnsubs.splice(0).forEach((unsub) => unsub());
  session.set(KEY_NO_AUTO, "1");
  location.href = location.pathname;
}

// ---------- Mensajes del canal de datos ----------
function handleMessage(msg) {
  switch (msg.type) {
    case "sdp":
    case "ice":
      // En orden, para no aplicar candidatos antes de su descripción.
      state.signalChain = state.signalChain.then(() => handleSignal(msg)).catch(console.error);
      break;
    case "hello":
      state.peerName = msg.name || "Contacto";
      $("#peerName").textContent = state.peerName;
      $("#peerAvatar").textContent = initial(state.peerName);
      break;
    case "chat":
      addTextMessage(msg.text, false);
      notifyUnread();
      if (document.hidden) localNotify(state.peerName, msg.text, "quick");
      break;
    case "file-start":
      startIncomingFile(msg);
      break;
    case "file-end":
      finishIncomingFile();
      notifyUnread();
      break;
    case "call-request":
      onCallRequest(msg.video);
      break;
    case "call-accept":
      onCallAccepted();
      break;
    case "call-reject":
      toast("Llamada rechazada");
      endCall(false);
      break;
    case "call-busy":
      toast(`${state.peerName} está ocupado`);
      endCall(false);
      break;
    case "hangup":
      if (state.mode === "private") {
        finishCall({ notify: false });
        break;
      }
      if (!$("#incomingCall").hidden) {
        stopRing();
        $("#incomingCall").hidden = true;
        addSystemMessage(`Llamada perdida de ${state.peerName}`);
      }
      endCall(false);
      break;
  }
}

async function handleSignal(msg) {
  if (!state.pc) return;
  if (msg.type === "sdp") {
    await onRemoteDescription(msg.description);
  } else {
    try {
      await state.pc.addIceCandidate(msg.candidate);
    } catch (err) {
      if (!state.ignoreOffer) console.warn(err);
    }
  }
}

function notifyUnread() {
  if (!document.hidden) return;
  state.unread++;
  document.title = `(${state.unread}) ${APP_NAME}`;
}

// ---------- Chat: burbujas ----------
function scrollToBottom(force) {
  const list = $("#messages");
  const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 120;
  if (force || nearBottom) list.scrollTop = list.scrollHeight;
}

// Inserta un elemento respetando el orden por hora
function insertByTs(el, ts) {
  el.dataset.ts = String(ts);
  const list = $("#messages");
  let ref = list.lastElementChild;
  while (ref && Number(ref.dataset.ts || 0) > ts) ref = ref.previousElementSibling;
  if (ref) ref.after(el);
  else list.prepend(el);
}

function addBubble(mine, build, { ts = Date.now(), ticks = false, senderId = "" } = {}) {
  const el = document.createElement("div");
  el.className = `msg ${mine ? "mine" : "theirs"}`;
  if (senderId) {
    const sender = document.createElement("span");
    sender.className = "sender";
    sender.dataset.from = senderId;
    sender.style.color = colorFor(senderId);
    sender.textContent = memberName(senderId);
    el.append(sender);
  }
  build(el);
  const time = document.createElement("time");
  time.textContent = timeLabel(ts);
  if (ticks) {
    const t = document.createElement("span");
    t.className = "ticks";
    t.innerHTML = '<svg class="i"><use href="#i-clock"/></svg>';
    time.append(t);
  }
  el.append(time);
  insertByTs(el, ts);
  scrollToBottom(mine);
  return el;
}

function addTextMessage(text, mine, opts) {
  return addBubble(mine, (el) => {
    const p = document.createElement("p");
    p.textContent = text;
    if (isOnlyEmoji(text)) el.classList.add("big-emoji");
    el.append(p);
  }, opts);
}

function addSystemMessage(text) {
  const el = document.createElement("div");
  el.className = "sys";
  el.textContent = text;
  insertByTs(el, Date.now());
  scrollToBottom(true);
}

function addCallLog(entry) {
  const b = entry.body;
  const kind = b.video ? "Videollamada" : "Llamada de voz";
  let text;
  if (b.outcome === "done") text = `${kind} · ${formatDuration(b.duration * 1000)}`;
  else if (b.outcome === "rejected") text = `${kind} rechazada`;
  else text = entry.mine ? `${kind} sin respuesta` : `${kind} perdida de ${memberName(entry.from)}`;

  const el = document.createElement("div");
  el.className = "call-log";
  el.classList.toggle("missed", b.outcome !== "done");
  el.innerHTML = `<svg class="i"><use href="#i-${b.video ? "video" : "phone"}"/></svg><span></span><time></time>`;
  el.querySelector("span").textContent = text;
  el.querySelector("time").textContent = timeLabel(entry.ts);
  insertByTs(el, entry.ts);
  scrollToBottom(false);
  return el;
}

// ---------- Composer ----------
// El botón principal envía el texto; si no hay texto, graba un audio.
function onComposerSubmit(e) {
  e.preventDefault();
  if (state.recording) return stopRecording(true);
  const input = $("#msgInput");
  const text = input.value.trim();
  if (!text) return startRecording();

  if (state.mode === "private") {
    sendPrivate({ t: "text", text });
    if (state.typingSent) saveMember({ typing: 0 });
    state.typingSent = 0;
  } else {
    if (!dcOpen()) return toast("No hay conexión");
    send({ type: "chat", text });
    addTextMessage(text, true);
  }
  input.value = "";
  autoGrow();
  updateSendButton();
  closeEmojiPanel();
}

function onTyping() {
  autoGrow();
  updateSendButton();
  if (state.mode !== "private" || !$("#msgInput").value.trim()) return;
  if (Date.now() - state.typingSent > 3000) {
    state.typingSent = Date.now();
    saveMember({ typing: serverNow(), lastSeen: serverNow() });
  }
}

function updateSendButton() {
  const hasText = $("#msgInput").value.trim().length > 0;
  const mic = !hasText && !state.recording;
  const btn = $("#sendBtn");
  btn.querySelector("use").setAttribute("href", mic ? "#i-mic" : "#i-send");
  btn.setAttribute("aria-label", state.recording ? "Enviar audio" : mic ? "Grabar audio" : "Enviar");
  btn.classList.toggle("recording", Boolean(state.recording));
}

function autoGrow() {
  const input = $("#msgInput");
  input.style.height = "auto";
  input.style.height = `${input.scrollHeight}px`;
}

function toggleEmojiPanel() {
  const panel = $("#emojiPanel");
  panel.hidden = !panel.hidden;
  $("#emojiBtn").classList.toggle("active", !panel.hidden);
  // En el celular, el panel reemplaza al teclado
  if (!panel.hidden && isTouch) $("#msgInput").blur();
  scrollToBottom(true);
}

function closeEmojiPanel() {
  $("#emojiPanel").hidden = true;
  $("#emojiBtn").classList.remove("active");
}

function buildEmojiPanel() {
  const panel = $("#emojiPanel");
  EMOJIS.forEach((emoji) => {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = emoji;
    b.addEventListener("click", () => insertAtCaret($("#msgInput"), emoji));
    panel.append(b);
  });
}

function insertAtCaret(input, text) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  input.value = input.value.slice(0, start) + text + input.value.slice(end);
  input.selectionStart = input.selectionEnd = start + text.length;
  autoGrow();
  updateSendButton();
  if (!isTouch) input.focus();
}

const canSend = () => state.mode === "private" || dcOpen();

// ---------- Mensajes de voz ----------
async function startRecording() {
  if (!canSend()) return toast("No hay conexión");
  if (!window.MediaRecorder) return toast("Este navegador no permite grabar audios");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    return toast("No se pudo acceder al micrófono");
  }
  const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus"]
    .find((t) => MediaRecorder.isTypeSupported(t));
  const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  const rec = { recorder, stream, chunks: [], start: Date.now(), send: false, timer: null };
  state.recording = rec;

  recorder.ondataavailable = (e) => { if (e.data.size) rec.chunks.push(e.data); };
  recorder.onstop = () => {
    stream.getTracks().forEach((t) => t.stop());
    clearInterval(rec.timer);
    if (state.recording === rec) state.recording = null;
    showRecordingBar(false);
    const duration = (Date.now() - rec.start) / 1000;
    if (!rec.send) return;
    if (duration < 0.7) return toast("Audio muy corto");
    const type = recorder.mimeType || mime || "audio/webm";
    const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
    const file = new File(rec.chunks, `audio-${Date.now()}.${ext}`, { type });
    queueFiles([file], { voice: true, duration });
  };

  recorder.start(250);
  rec.timer = setInterval(() => {
    const seconds = (Date.now() - rec.start) / 1000;
    $("#recTime").textContent = formatClock(seconds);
    if (seconds >= MAX_VOICE_SECONDS) stopRecording(true);
  }, 250);
  $("#recTime").textContent = "0:00";
  showRecordingBar(true);
}

function stopRecording(sendIt) {
  const rec = state.recording;
  if (!rec) return;
  rec.send = sendIt;
  if (rec.recorder.state !== "inactive") rec.recorder.stop();
}

function cancelRecording() {
  stopRecording(false);
}

function showRecordingBar(visible) {
  $(".input-wrap").hidden = visible;
  $("#recBar").hidden = !visible;
  if (visible) closeEmojiPanel();
  updateSendButton();
}

const voicePlayers = new Set();

function addVoiceMessage({ mine, duration }, opts) {
  const BARS = 30;
  const total = Number(duration) || 0;
  let playBtn, bars, timeEl, audio;
  const el = addBubble(mine, (el) => {
    el.classList.add("voice-msg", "loading");
    const wrap = document.createElement("div");
    wrap.className = "voice";
    playBtn = document.createElement("button");
    playBtn.type = "button";
    playBtn.className = "voice-play";
    playBtn.disabled = true;
    playBtn.setAttribute("aria-label", "Reproducir audio");
    playBtn.innerHTML = '<svg class="i"><use href="#i-play"/></svg>';
    bars = document.createElement("div");
    bars.className = "voice-bars";
    for (let i = 0; i < BARS; i++) {
      const bar = document.createElement("span");
      bar.style.height = `${Math.round(22 + Math.abs(Math.sin(i * 1.3 + total)) * 55 + Math.random() * 20)}%`;
      bars.append(bar);
    }
    timeEl = document.createElement("span");
    timeEl.className = "voice-time";
    timeEl.textContent = formatClock(total);
    wrap.append(playBtn, bars, timeEl);
    el.append(wrap);
  }, opts);

  const paint = (ratio) => {
    const on = Math.round(Math.min(1, ratio) * BARS);
    [...bars.children].forEach((b, i) => b.classList.toggle("on", i < on));
  };
  const setPlaying = (playing) => {
    playBtn.querySelector("use").setAttribute("href", playing ? "#i-pause" : "#i-play");
    playBtn.setAttribute("aria-label", playing ? "Pausar audio" : "Reproducir audio");
  };
  const length = () => (total || (Number.isFinite(audio.duration) ? audio.duration : 0));

  return {
    el,
    progress() {},
    lazy(load) { load(); },
    done(url) {
      el.classList.remove("loading");
      audio = new Audio(url);
      audio.preload = "metadata";
      voicePlayers.add(audio);
      playBtn.disabled = false;
      playBtn.addEventListener("click", () => {
        if (audio.paused) {
          voicePlayers.forEach((a) => { if (a !== audio) a.pause(); });
          audio.play().catch(() => toast("No se pudo reproducir el audio"));
        } else {
          audio.pause();
        }
      });
      audio.addEventListener("play", () => setPlaying(true));
      audio.addEventListener("pause", () => setPlaying(false));
      audio.addEventListener("timeupdate", () => {
        if (length()) paint(audio.currentTime / length());
        timeEl.textContent = formatClock(audio.currentTime);
      });
      audio.addEventListener("ended", () => {
        paint(0);
        timeEl.textContent = formatClock(total);
        setPlaying(false);
      });
      bars.addEventListener("click", (e) => {
        if (!length()) return;
        const rect = bars.getBoundingClientRect();
        audio.currentTime = ((e.clientX - rect.left) / rect.width) * length();
      });
    },
    fail() {
      el.classList.remove("loading");
      timeEl.textContent = "❌";
    },
  };
}

// ---------- Archivos ----------
function addFileMessage({ name, size, mine, voice, duration }, opts) {
  if (voice) return addVoiceMessage({ mine, duration }, opts);

  let bar, info, body, progress;
  const el = addBubble(mine, (el) => {
    body = document.createElement("div");
    body.className = "file-body";
    const icon = document.createElement("span");
    icon.className = "file-icon";
    icon.innerHTML = '<svg class="i"><use href="#i-file"/></svg>';
    info = document.createElement("div");
    info.className = "file-info";
    const title = document.createElement("strong");
    title.textContent = name;
    const meta = document.createElement("small");
    meta.textContent = formatSize(size);
    info.append(title, meta);
    body.append(icon, info);

    progress = document.createElement("div");
    progress.className = "progress";
    bar = document.createElement("span");
    progress.append(bar);
    el.append(body, progress);
  }, opts);

  return {
    el,
    progress(ratio) {
      progress.hidden = false;
      bar.style.width = `${Math.min(100, ratio * 100).toFixed(1)}%`;
    },
    lazy(load) {
      progress.hidden = true;
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "lazy-download";
      btn.innerHTML = '<svg class="i"><use href="#i-download"/></svg>Descargar';
      btn.addEventListener("click", () => {
        btn.remove();
        progress.hidden = false;
        load();
      }, { once: true });
      info.append(btn);
    },
    done(url, mime = "") {
      progress.remove();
      let preview;
      if (mime.startsWith("image/")) {
        preview = new Image();
        preview.alt = name;
      } else if (mime.startsWith("video/") || mime.startsWith("audio/")) {
        preview = document.createElement(mime.startsWith("video/") ? "video" : "audio");
        preview.controls = true;
        preview.playsInline = true;
      }
      if (preview) {
        preview.src = url;
        preview.className = "preview";
        el.insertBefore(preview, body);
      }
      if (mime.startsWith("image/")) {
        el.classList.add("image-msg");
        preview.addEventListener("click", () => openViewer(url, name));
        preview.addEventListener("load", () => scrollToBottom(mine), { once: true });
      }
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.className = "download";
      if (mine) a.textContent = "Enviado ✓";
      else a.innerHTML = '<svg class="i"><use href="#i-download"/></svg>Descargar';
      info.append(a);
      scrollToBottom(mine);
    },
    fail(text = "No se pudo enviar") {
      progress.remove();
      const s = document.createElement("small");
      s.textContent = `❌ ${text}`;
      info.append(s);
    },
  };
}

// ---------- Fotos ----------
function openViewer(url, name) {
  $("#viewerImg").src = url;
  $("#viewerImg").alt = name;
  $("#viewerDownload").href = url;
  $("#viewerDownload").download = name;
  $("#viewer").hidden = false;
}

function closeViewer() {
  $("#viewer").hidden = true;
  $("#viewerImg").removeAttribute("src");
}

// Reduce las fotos grandes (máx. 1920 px, JPEG) para que suban rápido y ocupen poco
async function compressImage(file) {
  if (!/^image\/(jpeg|png|webp|heic|heif)$/.test(file.type) || file.size < 400 * 1024) return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    const scale = Math.min(1, 1920 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
    if (!blob || blob.size >= file.size) return file;
    return new File([blob], file.name.replace(/\.[^.]+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

function queueFiles(files, meta = {}) {
  if (!canSend()) return toast("No hay conexión");
  files.forEach((file) => state.sendQueue.push({ file, meta }));
  pumpQueue();
}

async function pumpQueue() {
  if (state.sending) return;
  state.sending = true;
  while (state.sendQueue.length) {
    const item = state.sendQueue.shift();
    await (state.mode === "private" ? sendPrivateFile(item) : sendFile(item));
  }
  state.sending = false;
}

function waitForDrain() {
  return new Promise((resolve) => {
    state.dc.addEventListener("bufferedamountlow", resolve, { once: true });
    state.dc.addEventListener("close", resolve, { once: true });
  });
}

async function sendFile({ file, meta }) {
  const ui = addFileMessage({ name: file.name, size: file.size, mine: true, ...meta });
  if (!dcOpen()) return ui.fail();
  send({ type: "file-start", name: file.name, size: file.size, mime: file.type, ...meta });
  let offset = 0;
  while (offset < file.size) {
    if (!dcOpen()) return ui.fail();
    if (state.dc.bufferedAmount > MAX_BUFFERED) {
      await waitForDrain();
      continue;
    }
    const buf = await file.slice(offset, offset + CHUNK_SIZE).arrayBuffer();
    if (!dcOpen()) return ui.fail();
    state.dc.send(buf);
    offset += buf.byteLength;
    ui.progress(offset / file.size);
  }
  send({ type: "file-end" });
  ui.done(URL.createObjectURL(file), file.type);
}

function startIncomingFile(meta) {
  state.incoming = {
    ...meta,
    chunks: [],
    received: 0,
    ui: addFileMessage({ name: meta.name, size: meta.size, mine: false, voice: meta.voice, duration: meta.duration }),
  };
}

function handleChunk(buf) {
  const f = state.incoming;
  if (!f) return;
  f.chunks.push(buf);
  f.received += buf.byteLength;
  f.ui.progress(f.received / f.size);
}

function finishIncomingFile() {
  const f = state.incoming;
  if (!f) return;
  const blob = new Blob(f.chunks, { type: f.mime || "application/octet-stream" });
  f.ui.done(URL.createObjectURL(blob), f.mime);
  state.incoming = null;
}

// ---------- Llamadas: cámara, micrófono y pantalla ----------
async function openMedia(video) {
  state.facing = "user";
  state.localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true },
    video: video ? { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } } : false,
  });
  $("#localVideo").srcObject = state.localStream;
}

function addLocalTracks() {
  state.localStream?.getTracks().forEach((t) => state.pc.addTrack(t, state.localStream));
}

function showCallView(video, status) {
  const view = $("#callView");
  view.hidden = false;
  $(".chat-main").classList.add("in-call");
  view.classList.toggle("video", video);
  view.classList.toggle("audio", !video);
  view.classList.remove("live");
  $("#callAvatar").textContent = initial(state.peerName);
  $("#callName").textContent = state.peerName;
  $("#callStatus").textContent = status;
  $("#camBtn").hidden = !video;
  $("#screenBtn").hidden = !(video && canShareScreen);
  $("#flipBtn").hidden = true;
  $("#micBtn").classList.remove("off");
  $("#camBtn").classList.remove("off");
  $("#screenBtn").classList.remove("active");
  $("#localVideo").classList.add("mirror");
  if (video) {
    navigator.mediaDevices.enumerateDevices().then((devices) => {
      $("#flipBtn").hidden = devices.filter((d) => d.kind === "videoinput").length < 2;
    });
  }
}

function startCallTimer() {
  state.callActive = true;
  const start = Date.now();
  const tick = () => { $("#callStatus").textContent = `En llamada · ${formatDuration(Date.now() - start)}`; };
  tick();
  clearInterval(state.callTimer);
  state.callTimer = setInterval(tick, 1000);
}

// Corta cámara, micrófono y pantalla y oculta la vista de llamada
function stopCallMedia() {
  clearTimeout(state.callTimeout);
  clearInterval(state.callTimer);
  stopRing();
  stopScreenShare();
  if (state.localStream) {
    state.localStream.getTracks().forEach((t) => t.stop());
    state.localStream = null;
  }
  if (state.pc && state.pc.signalingState !== "closed") {
    state.pc.getSenders().forEach((s) => {
      if (s.track) state.pc.removeTrack(s);
    });
  }
  $("#remoteVideo").srcObject = null;
  $("#localVideo").srcObject = null;
  $("#callView").hidden = true;
  $(".chat-main").classList.remove("in-call");
}

function toggleTrack(kind, button) {
  const track = state.localStream?.[kind === "audio" ? "getAudioTracks" : "getVideoTracks"]()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  button.classList.toggle("off", !track.enabled);
}

async function flipCamera() {
  const old = state.localStream?.getVideoTracks()[0];
  if (!old) return;
  const previous = state.facing;
  const sender = state.pc.getSenders().find((s) => s.track === old);
  old.stop(); // muchos celulares no permiten abrir dos cámaras a la vez
  state.localStream.removeTrack(old);

  let track;
  try {
    state.facing = previous === "user" ? "environment" : "user";
    track = (await navigator.mediaDevices.getUserMedia({ video: { facingMode: state.facing } })).getVideoTracks()[0];
  } catch {
    toast("No hay otra cámara disponible");
    state.facing = previous;
    track = (await navigator.mediaDevices.getUserMedia({ video: { facingMode: previous } })).getVideoTracks()[0];
  }
  state.localStream.addTrack(track);
  if (sender) await sender.replaceTrack(track);
  $("#localVideo").srcObject = state.localStream;
  $("#localVideo").classList.toggle("mirror", state.facing === "user");
  $("#camBtn").classList.remove("off");
}

async function toggleScreenShare() {
  if (state.screenTrack) return stopScreenShare();
  const sender = state.pc?.getSenders().find((s) => s.track?.kind === "video");
  if (!sender) return toast("Primero tiene que conectarse la videollamada");
  let stream;
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  } catch {
    return;
  }
  const track = stream.getVideoTracks()[0];
  state.cameraTrack = sender.track;
  state.screenTrack = track;
  await sender.replaceTrack(track);
  track.onended = stopScreenShare;
  $("#localVideo").srcObject = stream;
  $("#localVideo").classList.remove("mirror");
  $("#screenBtn").classList.add("active");
}

async function stopScreenShare() {
  const track = state.screenTrack;
  if (!track) return;
  state.screenTrack = null;
  track.onended = null;
  track.stop();
  const sender = state.pc?.getSenders().find((s) => s.track === track);
  if (sender && state.cameraTrack) await sender.replaceTrack(state.cameraTrack).catch(() => {});
  if (state.localStream) $("#localVideo").srcObject = state.localStream;
  $("#localVideo").classList.toggle("mirror", state.facing === "user");
  $("#screenBtn").classList.remove("active");
}

// ---------- Llamadas en salas rápidas (por el canal directo) ----------
async function startCall(video) {
  if (state.inCall) return;
  if (!dcOpen()) return toast("No hay conexión");
  cancelRecording();
  try {
    await openMedia(video);
  } catch {
    return toast("No se pudo acceder al micrófono o la cámara");
  }
  state.inCall = true;
  showCallView(video, "Llamando…");
  send({ type: "call-request", video });
  state.callTimeout = setTimeout(() => {
    if (!state.callActive) {
      toast("Sin respuesta");
      endCall(true);
    }
  }, 30000);
}

function onCallRequest(video) {
  if (state.inCall || !$("#incomingCall").hidden) {
    send({ type: "call-busy" });
    return;
  }
  state.incomingVideo = video;
  showIncomingCall(video);
}

function showIncomingCall(video) {
  $("#incomingAvatar").textContent = initial(state.peerName);
  $("#incomingTitle").textContent = `${state.peerName} te está ${video ? "videollamando" : "llamando"}`;
  $("#incomingCall").hidden = false;
  startRing();
  if (document.hidden) localNotify(state.peerName, video ? "📹 Te está videollamando" : "📞 Te está llamando", "call");
}

async function acceptCall() {
  $("#incomingCall").hidden = true;
  stopRing();
  cancelRecording();
  const video = state.incomingVideo;
  try {
    await openMedia(video);
  } catch {
    toast("No se pudo acceder al micrófono o la cámara");
    send({ type: "call-reject" });
    return;
  }
  state.inCall = true;
  showCallView(video, "Conectando…");
  addLocalTracks();
  startCallTimer();
  send({ type: "call-accept" });
}

function rejectCall() {
  $("#incomingCall").hidden = true;
  stopRing();
  send({ type: "call-reject" });
  addSystemMessage("Llamada rechazada");
}

function onCallAccepted() {
  if (!state.inCall) return;
  clearTimeout(state.callTimeout);
  addLocalTracks();
  startCallTimer();
}

function endCall(notify) {
  if (notify && state.inCall && dcOpen()) send({ type: "hangup" });
  const wasActive = state.callActive;
  const label = $("#callStatus").textContent.split("· ")[1];
  stopCallMedia();
  if (state.inCall) addSystemMessage(wasActive ? `Llamada finalizada · ${label}` : "Llamada cancelada");
  state.inCall = false;
  state.callActive = false;
}

// ---------- Llamadas en salas privadas (aviso por Firestore + conexión directa) ----------
function pickMember() {
  const list = others();
  const modal = $("#pickModal");
  $("#pickList").replaceChildren(...list.map(([id, m]) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "contact-main contact";
    const online = serverNow() - m.lastSeen < ONLINE_MS;
    btn.innerHTML = '<span class="avatar"></span><span class="contact-text"><strong></strong><small></small></span>';
    btn.querySelector(".avatar").textContent = initial(m.name);
    btn.querySelector("strong").textContent = m.name;
    btn.querySelector("small").textContent = online ? "en línea" : `últ. vez ${lastSeenLabel(m.lastSeen)}`;
    btn.dataset.id = id;
    return btn;
  }));
  modal.hidden = false;
  return new Promise((resolve) => {
    const close = (id) => {
      modal.hidden = true;
      $("#pickList").onclick = $("#pickCancel").onclick = modal.onclick = null;
      resolve(id);
    };
    $("#pickList").onclick = (e) => {
      const btn = e.target.closest("[data-id]");
      if (btn) close(btn.dataset.id);
    };
    $("#pickCancel").onclick = () => close(null);
    modal.onclick = (e) => { if (e.target === modal) close(null); };
  });
}

async function startPrivateCall(video) {
  if (state.call || state.inCall) return;
  const list = others();
  if (!list.length) return toast("Todavía no entró nadie más a la sala");
  const target = list.length === 1 ? list[0][0] : await pickMember();
  if (!target) return;
  cancelRecording();
  try {
    await openMedia(video);
  } catch {
    return toast("No se pudo acceder al micrófono o la cámara");
  }

  const ref = doc(chatCol("calls"));
  const call = { id: ref.id, ref, role: "caller", video, peer: target, peerName: memberName(target), start: 0 };
  state.call = call;
  state.inCall = true;
  state.peerName = call.peerName;
  showCallView(video, `Llamando a ${call.peerName}…`);
  setDoc(ref, { from: state.memberId, to: target, video, state: "ringing", at: serverNow() }).catch((err) => {
    console.error(err);
    toast(FIREBASE_ERROR);
    finishCall({ notify: false, outcome: "missed" });
  });
  // Si tiene la app cerrada, el aviso se repite (suena y vibra) hasta que atienda o pasen 40 s
  pushNotify({ t: "ring", video }, [target]);
  call.ringTimer = setInterval(() => {
    if (state.call === call && !call.joining) pushNotify({ t: "ring", video }, [target]);
    else clearInterval(call.ringTimer);
  }, 5000);

  call.unsub = onSnapshot(ref, (snap) => {
    const d = snap.data();
    if (!d || state.call !== call) return;
    if (d.state === "accepted" && !call.joining) {
      call.joining = true;
      $("#callStatus").textContent = "Conectando…";
      joinCallLine(call);
    } else if (d.state === "rejected" || d.state === "busy") {
      toast(d.state === "busy" ? `${call.peerName} está en otra llamada` : "Llamada rechazada");
      finishCall({ notify: false, outcome: "rejected" });
    } else if (d.state === "ended" && !call.start) {
      finishCall({ notify: false, outcome: "missed" });
    }
  });
  state.callTimeout = setTimeout(() => {
    if (state.call === call && !call.joining) {
      toast("Sin respuesta");
      updateDoc(ref, { state: "missed" }).catch(() => {});
      finishCall({ notify: false, outcome: "missed" });
    }
  }, 40000);
}

function onCallDocChange(change) {
  const d = change.doc.data();
  const id = change.doc.id;
  if (change.type === "added") {
    if (serverNow() - d.at > 45000) return;
    if (state.call || state.inCall || state.incomingCall) {
      updateDoc(change.doc.ref, { state: "busy" }).catch(() => {});
      return;
    }
    state.incomingCall = { id, ref: change.doc.ref, video: d.video, from: d.from };
    state.incomingVideo = d.video;
    state.peerName = memberName(d.from);
    showIncomingCall(d.video);
  } else if (change.type === "removed" && state.incomingCall?.id === id) {
    // El que llamaba cortó antes de que atendiéramos
    stopRing();
    $("#incomingCall").hidden = true;
    state.incomingCall = null;
    renderPresence();
  }
}

async function acceptPrivateCall() {
  const inc = state.incomingCall;
  state.incomingCall = null;
  $("#incomingCall").hidden = true;
  stopRing();
  if (!inc) return;
  cancelRecording();
  try {
    await openMedia(inc.video);
  } catch {
    toast("No se pudo acceder al micrófono o la cámara");
    updateDoc(inc.ref, { state: "rejected" }).catch(() => {});
    return;
  }
  updateDoc(inc.ref, { state: "accepted" }).catch(() => {});
  const call = { id: inc.id, ref: inc.ref, role: "callee", video: inc.video, peer: inc.from, peerName: memberName(inc.from), start: 0 };
  state.call = call;
  state.inCall = true;
  state.peerName = call.peerName;
  showCallView(inc.video, "Conectando…");
  call.unsub = onSnapshot(inc.ref, (snap) => {
    if (snap.data()?.state === "ended" && state.call === call && !call.start) finishCall({ notify: false });
  });
  joinCallLine(call);
}

function rejectPrivateCall() {
  const inc = state.incomingCall;
  state.incomingCall = null;
  $("#incomingCall").hidden = true;
  stopRing();
  if (inc) updateDoc(inc.ref, { state: "rejected" }).catch(() => {});
}

async function joinCallLine(call) {
  try {
    call.lineSecret = (await sha256Hex(`${state.chat.chatId}|${call.id}`)).slice(0, 40);
    if (state.call !== call) return;
    state.line = { secret: call.lineSecret };
    call.connectTimer = setTimeout(() => {
      if (state.call === call && !call.start) {
        toast("No se pudo conectar la llamada. Puede que su red bloquee la conexión directa.");
        finishCall({ outcome: "missed" });
      }
    }, 35000);
    await joinLine();
  } catch (err) {
    console.error(err);
    toast(FIREBASE_ERROR);
    finishCall();
  }
}

function finishCall({ notify = true, outcome } = {}) {
  const call = state.call;
  if (!call) return;
  state.call = null;
  clearTimeout(call.connectTimer);
  clearInterval(call.ringTimer);
  call.unsub?.();
  // Si nunca atendió, su aviso de "te está llamando" pasa a "llamada perdida"
  if (call.role === "caller" && !call.start) pushNotify({ t: "missed", video: call.video }, [call.peer]);
  const duration = call.start ? Math.round((Date.now() - call.start) / 1000) : 0;
  if (notify && dcOpen()) send({ type: "hangup" });
  if (notify) updateDoc(call.ref, { state: "ended" }).catch(() => {});
  stopCallMedia();
  state.inCall = false;
  state.callActive = false;
  state.line = null;
  state.lineGen++;
  teardownPeer();
  // Borrar el punto de encuentro de la llamada (de los dos lados, por si uno no llega)
  if (call.lineSecret) cleanupLine(call.lineSecret);
  if (call.role === "caller" && state.chat) {
    sendPrivate({ t: "call", video: call.video, duration, outcome: outcome || (call.start ? "done" : "missed") });
  }
  renderPresence();
}

// ---------- Tono de llamada (sin archivos de audio) ----------
let ringCtx, ringTimer;
function startRing() {
  navigator.vibrate?.([400, 200, 400, 200, 400]);
  try {
    ringCtx = new (window.AudioContext || window.webkitAudioContext)();
    const beep = () => {
      const osc = ringCtx.createOscillator();
      const gain = ringCtx.createGain();
      osc.frequency.value = 440;
      gain.gain.value = 0.08;
      osc.connect(gain).connect(ringCtx.destination);
      osc.start();
      osc.stop(ringCtx.currentTime + 0.4);
    };
    beep();
    ringTimer = setInterval(beep, 1500);
  } catch { /* sin audio */ }
}

function stopRing() {
  clearInterval(ringTimer);
  ringCtx?.close().catch(() => {});
  ringCtx = null;
  navigator.vibrate?.(0);
}

// ---------- Avisos ----------
function updateNotifButton() {
  const btn = $("#notifBtn");
  const supported = "Notification" in window;
  btn.hidden = !supported || state.mode !== "private";
  if (!supported) return;
  const on = Notification.permission === "granted";
  btn.classList.toggle("on", on);
  btn.title = on ? "Avisos activados" : "Activar avisos";
  btn.setAttribute("aria-label", btn.title);
}

async function enableNotifications() {
  if (Notification.permission === "granted") return toast("Los avisos ya están activados");
  if (Notification.permission === "denied") {
    return toast("Los avisos están bloqueados. Actívalos desde el candado de la barra de direcciones.");
  }
  const permission = await Notification.requestPermission();
  updateNotifButton();
  if (permission === "granted") {
    toast("Avisos activados");
    setupPush();
  }
}

async function localNotify(title, body, tag) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const options = { body, tag, icon: "icons/icon-192.png", badge: "icons/icon-192.png", renotify: true };
    if (reg) reg.showNotification(title, options);
    else new Notification(title, options);
  } catch { /* sin avisos */ }
}

// Notificaciones push con la app cerrada (servidor en Cloudflare Workers)
async function setupPush() {
  if (!pushConfig?.server || !pushConfig.vapidPublicKey || state.mode !== "private") return;
  if (!("PushManager" in window) || Notification.permission !== "granted") return;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const key = Uint8Array.from(atob(pushConfig.vapidPublicKey.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    }
    // Una suscripción por dispositivo: a la misma persona le avisa en el celular y en la PC
    saveMember({ push: { [deviceId()]: JSON.stringify(sub) } });
  } catch (err) {
    console.warn("Push:", err);
  }
}

function pushNotify(body, to = null) {
  if (!pushConfig?.server || state.mode !== "private") return;
  const kind = body.t === "ring" ? "call" : body.t === "missed" ? "missed" : "msg";
  const preview = {
    ring: body.video ? "📹 Te está videollamando… toca para atender" : "📞 Te está llamando… toca para atender",
    missed: body.video ? "📹 Videollamada perdida" : "📞 Llamada perdida",
    file: body.voice ? "🎤 Audio" : "📎 Archivo",
    text: "Nuevo mensaje",
  }[body.t];
  if (!preview) return;
  const group = others().length > 1;
  fetch(`${pushConfig.server}/notify`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chatId: state.chat.chatId,
      from: state.memberId,
      to,
      title: group ? `${state.myName} · ${state.chat.label}` : state.myName,
      body: preview,
      kind,
    }),
  }).catch(() => {});
}

// ---------- PWA ----------
let installPrompt;
function setupPwa() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((err) => console.warn("SW:", err));
  }
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    installPrompt = e;
    $("#installBtn").hidden = false;
  });
  $("#installBtn").addEventListener("click", async () => {
    if (!installPrompt) return;
    installPrompt.prompt();
    await installPrompt.userChoice;
    installPrompt = null;
    $("#installBtn").hidden = true;
  });
}

// ---------- Inicio ----------
function init() {
  if (firebaseConfig.apiKey.startsWith("TU_")) $("#configWarning").hidden = false;

  $("#nameInput").value = store.get(KEY_NAME) || "";
  const invite = new URLSearchParams(location.search).get("sala");
  if (invite) {
    $("#codeInput").value = invite.toUpperCase();
    $("#inviteHint").textContent = `Te invitaron a la sala ${invite.toUpperCase()}. Pulsa «Unirse».`;
    $("#inviteHint").hidden = false;
  }

  document.querySelectorAll("[data-go]").forEach((btn) => {
    btn.addEventListener("click", () => showStep(btn.dataset.go));
  });
  $("#nameInput").addEventListener("keydown", (e) => { if (e.key === "Enter") e.currentTarget.blur(); });
  if (invite && $("#nameInput").value.trim()) showStep("quick");
  else if (invite) $("#nameInput").addEventListener("change", () => showStep("quick"), { once: true });

  renderSavedRooms();
  $("#privateForm").addEventListener("submit", submitPrivateForm);
  $("#passToggle").addEventListener("click", () => {
    const input = $("#linePass");
    const visible = input.type === "text";
    input.type = visible ? "password" : "text";
    $("#passToggle").setAttribute("aria-label", visible ? "Mostrar contraseña" : "Ocultar contraseña");
  });

  $("#createBtn").addEventListener("click", createRoom);
  $("#joinBtn").addEventListener("click", joinRoom);
  $("#codeInput").addEventListener("keydown", (e) => { if (e.key === "Enter") joinRoom(); });

  $("#copyBtn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.shareLink);
      toast("Enlace copiado");
    } catch {
      toast(state.shareLink);
    }
  });
  $("#shareBtn").addEventListener("click", () => {
    navigator.share({ title: APP_NAME, text: `Únete a mi sala en ${APP_NAME}`, url: state.shareLink }).catch(() => {});
  });
  $("#cancelBtn").addEventListener("click", async () => {
    if (state.roomId && state.isCaller) await cleanupRoom();
    leave();
  });

  $("#composer").addEventListener("submit", onComposerSubmit);
  $("#emojiBtn").addEventListener("click", toggleEmojiPanel);
  $("#recCancel").addEventListener("click", cancelRecording);
  const msgInput = $("#msgInput");
  msgInput.addEventListener("input", onTyping);
  msgInput.addEventListener("focus", () => { if (isTouch) closeEmojiPanel(); });
  msgInput.addEventListener("keydown", (e) => {
    // En PC: Enter envía, Shift+Enter hace salto de línea. En celular, Enter hace salto de línea.
    if (e.key === "Enter" && !e.shiftKey && !isTouch) {
      e.preventDefault();
      if (msgInput.value.trim()) $("#composer").requestSubmit();
    }
  });
  // Mantener el teclado abierto al tocar "Enviar" en el celular
  $("#sendBtn").addEventListener("pointerdown", (e) => {
    if (document.activeElement === msgInput && msgInput.value.trim()) e.preventDefault();
  });
  // Pegar imágenes con Ctrl+V (por ejemplo, una captura de pantalla)
  msgInput.addEventListener("paste", (e) => {
    const files = [...(e.clipboardData?.files || [])];
    if (!files.length) return;
    e.preventDefault();
    queueFiles(files);
  });
  $("#viewerClose").addEventListener("click", closeViewer);
  $("#viewer").addEventListener("click", (e) => { if (e.target.id === "viewer") closeViewer(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("#viewer").hidden) closeViewer(); });
  $("#fileInput").addEventListener("change", (e) => {
    queueFiles([...e.target.files]);
    e.target.value = "";
  });

  const chat = $("#screen-chat");
  chat.addEventListener("dragover", (e) => {
    e.preventDefault();
    $("#dropOverlay").hidden = false;
  });
  $("#dropOverlay").addEventListener("dragleave", () => { $("#dropOverlay").hidden = true; });
  chat.addEventListener("drop", (e) => {
    e.preventDefault();
    $("#dropOverlay").hidden = true;
    if (e.dataTransfer.files.length) queueFiles([...e.dataTransfer.files]);
  });

  const isPrivate = () => state.mode === "private";
  $("#audioCallBtn").addEventListener("click", () => (isPrivate() ? startPrivateCall(false) : startCall(false)));
  $("#videoCallBtn").addEventListener("click", () => (isPrivate() ? startPrivateCall(true) : startCall(true)));
  $("#hangupBtn").addEventListener("click", () => (isPrivate() ? finishCall() : endCall(true)));
  $("#acceptBtn").addEventListener("click", () => (isPrivate() ? acceptPrivateCall() : acceptCall()));
  $("#rejectBtn").addEventListener("click", () => (isPrivate() ? rejectPrivateCall() : rejectCall()));
  $("#micBtn").addEventListener("click", (e) => toggleTrack("audio", e.currentTarget));
  $("#camBtn").addEventListener("click", (e) => toggleTrack("video", e.currentTarget));
  $("#flipBtn").addEventListener("click", flipCamera);
  $("#screenBtn").addEventListener("click", toggleScreenShare);
  $("#notifBtn").addEventListener("click", enableNotifications);
  $("#menuBtn").addEventListener("click", () => { $("#roomMenu").hidden = false; });
  $("#menuClose").addEventListener("click", () => { $("#roomMenu").hidden = true; });
  $("#roomMenu").addEventListener("click", (e) => { if (e.target.id === "roomMenu") $("#roomMenu").hidden = true; });
  document.querySelectorAll("#roomMenu [data-days]").forEach((btn) => {
    btn.addEventListener("click", () => setRetention(Number(btn.dataset.days)));
  });
  $("#clearChatBtn").addEventListener("click", clearChat);
  $("#leaveBtn").addEventListener("click", async () => {
    if (isPrivate() && !state.call) return leave();
    const ok = await askConfirm({
      title: isPrivate() ? "¿Cortar la llamada y salir?" : "¿Salir de la conversación?",
      text: isPrivate() ? "Los mensajes quedan guardados en la sala." : "Se cortará la conexión con el otro dispositivo.",
      yes: "Salir",
    });
    if (ok) leave();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) return;
    state.unread = 0;
    document.title = APP_NAME;
    heartbeat();
    markRead();
    renderPresence();
  });

  buildEmojiPanel();
  updateSendButton();
  setupViewport();
  setupPwa();

  // Al tocar un aviso: abrir la sala de ese aviso (si está guardada en este dispositivo)
  const openChat = (chatId) => {
    const room = getSavedRooms().find((r) => r.chatId === chatId);
    if (!room || !store.get(KEY_NAME)) return false;
    if (state.chat?.chatId === chatId) return true;
    if (state.mode) {
      location.href = `${location.pathname}?abrir=${chatId}`;
      return true;
    }
    enterChat(room);
    return true;
  };
  navigator.serviceWorker?.addEventListener("message", (e) => {
    if (e.data?.type === "open-chat") openChat(e.data.chat);
  });

  const fromNotification = new URLSearchParams(location.search).get("abrir");
  if (fromNotification) history.replaceState(null, "", location.pathname);

  // Si hay una sola sala guardada, entrar directo al abrir la app
  const saved = getSavedRooms();
  if (fromNotification && openChat(fromNotification)) return;
  if (!invite && saved.length === 1 && store.get(KEY_NAME) && !session.get(KEY_NO_AUTO)) {
    enterChat(saved[0]);
  }
}

init();
