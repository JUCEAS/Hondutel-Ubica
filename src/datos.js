// =====================================================================
//  HONDUTEL UBICA - Acceso a Firebase (unico modulo que habla con el servidor)
//  Las pruebas reemplazan este archivo por test/datos_falso.js.
// =====================================================================
import { initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword, signOut,
} from 'firebase/auth';
import {
  initializeFirestore, memoryLocalCache, doc, getDoc, setDoc, collection, query, where,
  onSnapshot, getDocs, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { firebaseConfig } from './config.js';

// Cache SOLO en memoria: nada de Firestore se guarda en el disco del telefono.
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = initializeFirestore(app, { localCache: memoryLocalCache() });

export const esNegado = (e) => e && (e.code === 'permission-denied' || e.code === 'firestore/permission-denied');

export function alCambiarSesion(cb) {
  return onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, correo: u.email } : null));
}

export async function entrar(correo, clave) {
  await signInWithEmailAndPassword(auth, correo, clave);
}

export async function salir() {
  await signOut(auth);
}

/** Perfil propio (las reglas solo permiten leer el propio). null si no existe. */
export async function perfil(uid) {
  const s = await getDoc(doc(db, 'usuarios', uid));
  return s.exists() ? s.data() : null;
}

/** Escucha en tiempo real las asignaciones del tecnico (revocar/extender se ve al instante). */
export function escucharAsignaciones(uid, alRecibir, alFallar) {
  const q = query(collection(db, 'asignaciones'), where('tecnicoUid', '==', uid));
  return onSnapshot(q,
    (snap) => alRecibir(snap.docs.map((d) => ({ id: d.id, ...d.data() }))),
    alFallar);
}

/** Registra la consulta en la bitacora (requisito de las reglas antes de leer). */
export async function registrarConsulta(asig, uid) {
  const datos = () => ({
    tipo: 'consulta', asignacionId: asig.id, tecnicoUid: uid,
    autorizadorUid: asig.autorizadorUid, momento: serverTimestamp(),
  });
  try {
    await setDoc(doc(db, 'bitacora', `${asig.id}_${uid}`), datos());
  } catch (e) {
    if (!esNegado(e)) throw e;
    // Ya existia el primer registro: se agrega uno nuevo con marca de tiempo.
    await setDoc(doc(db, 'bitacora', `${asig.id}_${uid}_${Date.now()}`), datos());
  }
}

export async function resultados(asigId) {
  const s = await getDocs(collection(db, 'asignaciones', asigId, 'resultados'));
  return s.docs.map((d) => ({ id: d.id, ...d.data() }));
}

/** Paquete cifrado de un cliente. Lanza permission-denied si ya fue "encontrado" o fuera de horario. */
export async function paquete(asigId, cliente) {
  const s = await getDoc(doc(db, 'asignaciones', asigId, 'paquete', cliente));
  return s.exists() ? s.data() : null;
}

/** Configuracion general (jornadas, minutos de gracia). null si no se puede leer. */
export async function configuracion() {
  try {
    const s = await getDoc(doc(db, 'config', 'general'));
    return s.exists() ? s.data() : null;
  } catch (e) {
    if (esNegado(e)) return null;
    throw e;
  }
}

/** Cliente abierto ahora en esa asignacion ('' = ninguno). */
export async function clienteAbierto(asigId) {
  const s = await getDoc(doc(db, 'asignaciones', asigId, 'estado', 'actual'));
  return s.exists() ? (s.data().cliente || '') : '';
}

/**
 * Abre UN cliente: deja la apertura en bitacora y lo marca como "el abierto".
 * El servidor lo rechaza si ya hay otro abierto (uno a la vez).
 */
export async function abrir(asig, uid, cliente) {
  const registro = `${asig.id}_${uid}_${cliente}_${Date.now()}`;
  const b = writeBatch(db);
  b.set(doc(db, 'bitacora', registro), {
    tipo: 'apertura', asignacionId: asig.id, tecnicoUid: uid, autorizadorUid: asig.autorizadorUid,
    cliente, momento: serverTimestamp(),
  });
  b.set(doc(db, 'asignaciones', asig.id, 'estado', 'actual'), {
    cliente, tecnicoUid: uid, momento: serverTimestamp(), registro,
  });
  await b.commit();
}

function base(asig, uid, cliente, gps) {
  const d = {
    cliente, tecnicoUid: uid, autorizadorUid: asig.autorizadorUid, momento: serverTimestamp(),
  };
  if (gps) Object.assign(d, { lat: gps.lat, lon: gps.lon, precision: gps.precision });
  return d;
}

function liberar(b, asig, uid, liberadoPor) {
  b.set(doc(db, 'asignaciones', asig.id, 'estado', 'actual'), {
    cliente: '', tecnicoUid: uid, momento: serverTimestamp(), liberadoPor,
  });
}

/** Registra "encontrado" y libera al tecnico para buscar el siguiente (una sola operacion). */
export async function marcarEncontrado(asig, uid, cliente, gps) {
  const b = writeBatch(db);
  b.set(doc(db, 'asignaciones', asig.id, 'resultados', cliente), { resultado: 'encontrado', ...base(asig, uid, cliente, gps) });
  liberar(b, asig, uid, cliente);
  await b.commit();
}

/** Registra "no encontrado" (con motivo) y libera al tecnico; el cliente sigue pendiente. */
export async function marcarNoEncontrado(asig, uid, cliente, motivo, detalle) {
  const id = `${cliente}_ne_${Date.now()}`;
  const d = { resultado: 'no_encontrado', motivo, ...base(asig, uid, cliente, null) };
  if (detalle) d.detalle = detalle.slice(0, 300);
  const b = writeBatch(db);
  b.set(doc(db, 'asignaciones', asig.id, 'resultados', id), d);
  liberar(b, asig, uid, id);
  await b.commit();
}
