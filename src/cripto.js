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

const cacheDivisor = new Map();
async function llaveDivisor(b64) {
  if (!cacheDivisor.has(b64)) {
    cacheDivisor.set(b64, await subtle.importKey('spki', b64aBytes(b64), { name: 'RSA-PSS', hash: 'SHA-256' }, false, ['verify']));
  }
  return cacheDivisor.get(b64);
}

/** Acepta la firma si coincide con ALGUNA de las llaves del Divisor autorizadas. */
async function verificar(llavesDivisor, firmaB64, texto) {
  const lista = (Array.isArray(llavesDivisor) ? llavesDivisor : [llavesDivisor]).filter(Boolean);
  if (!lista.length) throw new Error('SIN_LLAVE_DIVISOR');
  for (const b64 of lista) {
    try {
      if (await subtle.verify({ name: 'RSA-PSS', saltLength: 32 }, await llaveDivisor(b64), b64aBytes(firmaB64), enc.encode(texto))) return true;
    } catch { /* llave o firma con formato invalido: se prueba la siguiente */ }
  }
  return false;
}

const ms = (t) => (typeof t === 'number' ? t : t.toMillis());

/**
 * Hora de cierre que la app acepta para una asignacion:
 * la original, o una extension FIRMADA por el Divisor.
 */
export async function cierreValido(asig, llavesDivisor) {
  const fin = ms(asig.fin), finOriginal = ms(asig.finOriginal), inicio = ms(asig.inicio);
  if (fin === finOriginal) return fin;
  if (fin < finOriginal) throw new Error('CIERRE_INVALIDO');
  const texto = `HU1-EXT|${asig.id}|${asig.tecnicoUid}|${inicio}|${fin}|${asig.extensiones}`;
  if (!asig.firmaExtension || !(await verificar(llavesDivisor, asig.firmaExtension, texto))) {
    throw new Error('EXTENSION_NO_FIRMADA');
  }
  return fin;
}

// ---------------- Buscador (indice ciego) ----------------
/** 8 digitos de Honduras, o '' si no es un numero valido. */
export function normalizarTelefono(texto) {
  let d = String(texto ?? '').replace(/\D/g, '');
  if (d.length === 11 && d.startsWith('504')) d = d.slice(3);
  return /^[2-9]\d{7}$/.test(d) ? d : '';
}

/** Abre la llave de busqueda de la asignacion (solo este telefono puede). */
export async function llaveBusqueda(asig, privada) {
  const cruda = await subtle.decrypt({ name: 'RSA-OAEP' }, privada, b64aBytes(asig.llaveBusqueda));
  return subtle.importKey('raw', cruda, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/** Indice del numero (mismo calculo que el Divisor): HMAC-SHA256(...)[:16] en hex. */
export async function indiceTelefono(llaveHmac, telefono8) {
  const firma = new Uint8Array(await subtle.sign('HMAC', llaveHmac, enc.encode(`HU-TEL|${telefono8}`)));
  return [...firma.slice(0, 16)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Busca el numero en el indice de la asignacion: devuelve 'cNN' o null. */
export async function buscarCliente(asig, llaveHmac, telefono8) {
  const idx = await indiceTelefono(llaveHmac, telefono8);
  return Object.keys(asig.indice || {}).find((c) => asig.indice[c] === idx) || null;
}

/** Verifica la firma del Divisor y descifra el paquete de UN cliente. */
export async function abrirCliente(cliente, paquete, asig, privada, llavesDivisor) {
  const idx = (asig.indice || {})[cliente] || '';
  const texto = `HU2|${asig.id}|${asig.tecnicoUid}|${cliente}|${ms(asig.inicio)}|${ms(asig.finOriginal)}|${asig.area}|${idx}|${paquete.cifrado}`;
  if (!(await verificar(llavesDivisor, paquete.firma, texto))) throw new Error('FIRMA_INVALIDA');
  const sobre = JSON.parse(dec.decode(b64aBytes(paquete.cifrado)));
  const cruda = await subtle.decrypt({ name: 'RSA-OAEP' }, privada, b64aBytes(sobre.k));
  const aes = await subtle.importKey('raw', cruda, 'AES-GCM', false, ['decrypt']);
  const claro = await subtle.decrypt({ name: 'AES-GCM', iv: b64aBytes(sobre.iv) }, aes, b64aBytes(sobre.ct));
  const d = JSON.parse(dec.decode(claro));
  if (d.asignacionId !== asig.id || d.cliente !== cliente) throw new Error('NO_COINCIDE');
  return d;
}
