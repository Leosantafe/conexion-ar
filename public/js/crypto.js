// Cifrado de extremo a extremo para las salas privadas (AES-GCM de 256 bits).
// La clave se deriva del nombre de la sala + la contraseña con PBKDF2 y nunca sale del dispositivo:
// Firebase solo guarda datos ilegibles.
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const normalizeRoom = (label) => label.trim().toLowerCase().replace(/\s+/g, " ");

export const toHex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");

export function toB64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromB64(b64) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

// Devuelve el ID público de la sala (40 caracteres) y la clave de cifrado (en base64).
export async function deriveRoom(label, password) {
  const base = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: encoder.encode(`conexion-ar|v2|${normalizeRoom(label)}`), iterations: 150000, hash: "SHA-256" },
    base,
    512,
  ));
  return { chatId: toHex(bits.slice(32, 52)), keyB64: toB64(bits.slice(0, 32)) };
}

export const importKey = (keyB64) =>
  crypto.subtle.importKey("raw", fromB64(keyB64), "AES-GCM", false, ["encrypt", "decrypt"]);

export async function encryptBytes(key, bytes) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, bytes));
  return { iv, ct };
}

export async function decryptBytes(key, iv, ct) {
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ct));
}

export const encryptJson = (key, value) => encryptBytes(key, encoder.encode(JSON.stringify(value)));

export async function decryptJson(key, iv, ct) {
  return JSON.parse(decoder.decode(await decryptBytes(key, iv, ct)));
}

export async function sha256Hex(text) {
  return toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(text))));
}
