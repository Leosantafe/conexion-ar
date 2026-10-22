// Pega aquí la configuración de tu proyecto Firebase:
// Consola de Firebase → ⚙️ Configuración del proyecto → Tus apps → App web (</>)
export const firebaseConfig = {
  apiKey: "AIzaSyC51wXedoUkvnDToj4ovzi0nV4n1hnZUCU",
  authDomain: "conexion-ar.firebaseapp.com",
  projectId: "conexion-ar",
  storageBucket: "conexion-ar.firebasestorage.app",
  messagingSenderId: "548002333943",
  appId: "1:548002333943:web:c8d5485414aff7dcb8fff2",
};

// Notificaciones push con la app cerrada (servidor en Cloudflare Workers, carpeta worker/).
// server = URL del Worker, vapidPublicKey = clave pública VAPID (la privada está como secreto en el Worker).
export const pushConfig = {
  server: "https://conexion-ar-push.firmaestudio.workers.dev",
  vapidPublicKey: "BC5HIu9GByoovpM7aWvMpX-b8nQfg7edewFLNFiqHPeMlkszIKfkUIhE2ToIkmnJfijm_AnC1y-4e4m2ghSsbuc",
};

// Servidores para que los dispositivos se encuentren a través de internet.
// STUN (gratis, de Google) funciona en la mayoría de redes.
// Si en datos móviles o redes de empresa no conecta, agrega un servidor TURN
// (por ejemplo el plan gratis de https://www.metered.ca/stun-turn).
export const iceServers = [
  { urls: ["stun:stun.l.google.com:19302", "stun:stun1.l.google.com:19302"] },
  // { urls: "turn:TU_SERVIDOR_TURN:80", username: "USUARIO", credential: "CLAVE" },
];
