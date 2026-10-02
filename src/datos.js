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
  onSnapshot, getDocs, serverTimestamp,
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

function base(asig, uid, cliente, gps) {
  const d = {
    cliente, tecnicoUid: uid, autorizadorUid: asig.autorizadorUid, momento: serverTimestamp(),
  };
  if (gps) Object.assign(d, { lat: gps.lat, lon: gps.lon, precision: gps.precision });
  return d;
}

export async function marcarEncontrado(asig, uid, cliente, gps) {
  await setDoc(doc(db, 'asignaciones', asig.id, 'resultados', cliente),
    { resultado: 'encontrado', ...base(asig, uid, cliente, gps) });
}

export async function marcarNoEncontrado(asig, uid, cliente, motivo, detalle) {
  const d = { resultado: 'no_encontrado', motivo, ...base(asig, uid, cliente, null) };
  if (detalle) d.detalle = detalle.slice(0, 300);
  await setDoc(doc(db, 'asignaciones', asig.id, 'resultados', `${cliente}_ne_${Date.now()}`), d);
}
