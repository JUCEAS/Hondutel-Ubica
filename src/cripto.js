// =====================================================================
//  HONDUTEL UBICA - Cifrado en el telefono (WebCrypto)
//  Mismo contrato probado en la fase 1 (test/cifrado_divisor.py).
//  - La llave PRIVADA se crea NO exportable y vive solo en este navegador (IndexedDB).
//  - Nada descifrado se guarda en disco: solo en memoria.
// =====================================================================

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

const DB = 'hondutel-ubica';
const STORE = 'llaves';
const ID = 'tecnico';

export const b64aBytes = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
export const bytesAB64 = (buf) => {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
};

function abrirDB() {
  return new Promise((ok, mal) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => ok(r.result);
    r.onerror = () => mal(r.error);
  });
}

async function idb(modo, fn) {
  const db = await abrirDB();
  return new Promise((ok, mal) => {
    const tx = db.transaction(STORE, modo);
    const req = fn(tx.objectStore(STORE));
    tx.oncomplete = () => { db.close(); ok(req && req.result); };
    tx.onerror = () => { db.close(); mal(tx.error); };
  });
}

/** Devuelve {privada, publicaB64}; las crea la primera vez. */
export async function obtenerLlaves() {
  let par = await idb('readonly', (s) => s.get(ID));
  if (!par) {
    const k = await subtle.generateKey(
      { name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      false, ['encrypt', 'decrypt']);
    const publicaB64 = bytesAB64(await subtle.exportKey('spki', k.publicKey));
    par = { privada: k.privateKey, publicaB64, creada: new Date().toISOString() };
    await idb('readwrite', (s) => s.put(par, ID));
  }
  return par;
}

export async function existenLlaves() {
  return !!(await idb('readonly', (s) => s.get(ID)));
}

/** Huella corta (para comparar a simple vista con el Divisor). */
export async function huella(publicaB64) {
  const h = new Uint8Array(await subtle.digest('SHA-256', b64aBytes(publicaB64)));
  return [...h.slice(0, 6)].map((x) => x.toString(16).padStart(2, '0').toUpperCase()).join('-');
}

let cacheDivisor = null;
async function llaveDivisor(b64) {
  if (!b64) throw new Error('SIN_LLAVE_DIVISOR');
  if (!cacheDivisor || cacheDivisor.b64 !== b64) {
    cacheDivisor = {
      b64,
      key: await subtle.importKey('spki', b64aBytes(b64), { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['verify']),
    };
  }
  return cacheDivisor.key;
}

async function verificar(divisorB64, firmaB64, texto) {
  const pub = await llaveDivisor(divisorB64);
  return subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, pub, b64aBytes(firmaB64), enc.encode(texto));
}

const ms = (t) => (typeof t === 'number' ? t : t.toMillis());

/**
 * Hora de cierre que la app acepta para una asignacion:
 * la original, o una extension FIRMADA por el Divisor.
 */
export async function cierreValido(asig, divisorB64) {
  const fin = ms(asig.fin), finOriginal = ms(asig.finOriginal), inicio = ms(asig.inicio);
  if (fin === finOriginal) return fin;
  if (fin < finOriginal) throw new Error('CIERRE_INVALIDO');
  const texto = `HU1-EXT|${asig.id}|${asig.tecnicoUid}|${inicio}|${fin}|${asig.extensiones}`;
  if (!asig.firmaExtension || !(await verificar(divisorB64, asig.firmaExtension, texto))) {
    throw new Error('EXTENSION_NO_FIRMADA');
  }
  return fin;
}

/** Verifica la firma del Divisor y descifra el paquete de UN cliente. */
export async function abrirCliente(cliente, paquete, asig, privada, divisorB64) {
  const texto = `HU1|${asig.id}|${asig.tecnicoUid}|${cliente}|${ms(asig.inicio)}|${ms(asig.finOriginal)}|${paquete.cifrado}`;
  if (!(await verificar(divisorB64, paquete.firma, texto))) throw new Error('FIRMA_INVALIDA');
  const sobre = JSON.parse(dec.decode(b64aBytes(paquete.cifrado)));
  const cruda = await subtle.decrypt({ name: 'RSA-OAEP' }, privada, b64aBytes(sobre.k));
  const aes = await subtle.importKey('raw', cruda, 'AES-GCM', false, ['decrypt']);
  const claro = await subtle.decrypt({ name: 'AES-GCM', iv: b64aBytes(sobre.iv) }, aes, b64aBytes(sobre.ct));
  const d = JSON.parse(dec.decode(claro));
  if (d.asignacionId !== asig.id || d.cliente !== cliente) throw new Error('NO_COINCIDE');
  return d;
}
