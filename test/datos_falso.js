// =====================================================================
//  Servidor SIMULADO para pruebas (reemplaza src/datos.js en dist-prueba/).
//  Aplica la misma logica que firestore.rules para lo que usa la app del tecnico:
//  hora del servidor, revocacion, bitacora previa, "encontrado" oculta el paquete,
//  usuario desactivado, solo el propio perfil.
//  La prueba lo controla con window.__HU_FAKE.
// =====================================================================
const negado = () => Object.assign(new Error('permission-denied'), { code: 'permission-denied' });

const S = {
  cuentas: {}, usuarios: {}, asignaciones: {}, paquetes: {}, resultados: {}, bitacora: [],
  sesion: null, authCbs: [], escuchas: [], registro: [],
};

export const esNegado = (e) => e && e.code === 'permission-denied';

const vigente = (a, uid) => a && a.tecnicoUid === uid && !a.revocada && Date.now() >= a.inicio && Date.now() < a.fin;
const esTecnicoActivo = (uid) => S.usuarios[uid]?.rol === 'tecnico' && S.usuarios[uid]?.activo === true;
const log = (op, det) => S.registro.push({ op, det, t: Date.now() });

function emitir() {
  for (const e of S.escuchas) {
    if (!esTecnicoActivo(e.uid)) { e.fail(negado()); continue; }
    e.ok(Object.entries(S.asignaciones).filter(([, a]) => a.tecnicoUid === e.uid).map(([id, a]) => ({ id, ...a })));
  }
}

export function alCambiarSesion(cb) { S.authCbs.push(cb); setTimeout(() => cb(S.sesion), 0); return () => {}; }

export async function entrar(correo, clave) {
  const c = S.cuentas[correo];
  if (!c || c.clave !== clave) throw Object.assign(new Error('x'), { code: 'auth/invalid-credential' });
  S.sesion = { uid: c.uid, correo };
  log('entrar', correo);
  S.authCbs.forEach((cb) => cb(S.sesion));
}

export async function salir() { S.sesion = null; S.escuchas = []; S.authCbs.forEach((cb) => cb(null)); }

export async function perfil(uid) {
  if (!S.sesion || S.sesion.uid !== uid) throw negado();
  return S.usuarios[uid] ? structuredClone(S.usuarios[uid]) : null;
}

export function escucharAsignaciones(uid, ok, fail) {
  const e = { uid, ok, fail };
  S.escuchas.push(e);
  setTimeout(emitir, 0);
  return () => { S.escuchas = S.escuchas.filter((x) => x !== e); };
}

export async function registrarConsulta(a, uid) {
  const srv = S.asignaciones[a.id];
  if (!esTecnicoActivo(uid) || !vigente(srv, uid) || a.autorizadorUid !== srv.autorizadorUid) throw negado();
  S.bitacora.push({ asignacionId: a.id, tecnicoUid: uid, momento: Date.now() });
  log('bitacora', a.id);
}

export async function resultados(asigId) {
  const a = S.asignaciones[asigId];
  if (!S.sesion || a?.tecnicoUid !== S.sesion.uid) throw negado();
  return structuredClone(S.resultados[asigId] || []);
}

const encontrado = (asigId, cli) => (S.resultados[asigId] || []).some((r) => r.resultado === 'encontrado' && r.cliente === cli);

export async function paquete(asigId, cli) {
  const uid = S.sesion?.uid;
  const a = S.asignaciones[asigId];
  const conBitacora = S.bitacora.some((b) => b.asignacionId === asigId && b.tecnicoUid === uid);
  if (!esTecnicoActivo(uid) || !vigente(a, uid) || !conBitacora || encontrado(asigId, cli)) {
    log('paquete-negado', `${asigId}/${cli}`);
    throw negado();
  }
  log('paquete', `${asigId}/${cli}`);
  return S.paquetes[asigId]?.[cli] ? structuredClone(S.paquetes[asigId][cli]) : null;
}

function validarResultado(a, uid, cli) {
  const srv = S.asignaciones[a.id];
  if (!esTecnicoActivo(uid) || !vigente(srv, uid)) throw negado();
  if (!/^c(0[1-9]|1[0-9]|20)$/.test(cli) || Number(cli.slice(1)) > srv.cantidadClientes) throw negado();
}

export async function marcarEncontrado(a, uid, cli, gps) {
  validarResultado(a, uid, cli);
  if (encontrado(a.id, cli)) throw negado();
  (S.resultados[a.id] ||= []).push({ resultado: 'encontrado', cliente: cli, tecnicoUid: uid, momento: Date.now(), ...(gps || {}) });
  log('encontrado', `${a.id}/${cli}`);
}

export async function marcarNoEncontrado(a, uid, cli, motivo, detalle) {
  validarResultado(a, uid, cli);
  if (encontrado(a.id, cli)) throw negado();
  (S.resultados[a.id] ||= []).push({ resultado: 'no_encontrado', cliente: cli, motivo, detalle, tecnicoUid: uid, momento: Date.now() });
  log('no_encontrado', `${a.id}/${cli}`);
}

// ---------- Control desde la prueba ----------
globalThis.__HU_FAKE = {
  S,
  cargar(datos) { Object.assign(S, structuredClone(datos)); emitir(); },
  asignacion(id, a, paquetes) { S.asignaciones[id] = a; if (paquetes) S.paquetes[id] = paquetes; emitir(); },
  revocar(id) { S.asignaciones[id].revocada = true; emitir(); },
  extender(id, fin, numero, firma) { Object.assign(S.asignaciones[id], { fin, extensiones: numero, firmaExtension: firma }); emitir(); },
  desactivar(uid) { S.usuarios[uid].activo = false; emitir(); },
  emitir,
  leerPaquete: (a, c) => paquete(a, c),
};
