// =====================================================================
//  HONDUTEL UBICA - App del tecnico (interfaz)
// =====================================================================
import QRCode from 'qrcode';
import * as D from './datos.js';
import {
  obtenerLlaves, huella, cierreValido, abrirCliente, llaveBusqueda, buscarCliente, normalizarTelefono,
} from './cripto.js';
import {
  APP_VERSION, DIVISOR_PUBLIC_KEYS, MINUTOS_OCULTA_PARA_BORRAR, PREFIJO_PAIS, MOTIVOS_NO_ENCONTRADO,
  GRACIA_MINUTOS_POR_DEFECTO,
} from './config.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ms = (t) => (t == null ? null : typeof t === 'number' ? t : t.toMillis());
const hora = (m) => new Date(m).toLocaleTimeString('es-HN', { hour: 'numeric', minute: '2-digit' });
const divisorKeys = () => {
  const k = globalThis.__HU_DIVISOR_KEY ?? DIVISOR_PUBLIC_KEYS;
  return (Array.isArray(k) ? k : [k]).filter(Boolean);
};
const AREA = { mora: 'Cobranza (Mora)', reparacion: 'Reparación' };

// ---------------- Estado (solo en memoria) ----------------
const S = {
  usuario: null,       // {uid, correo}
  perfil: null,
  llaves: null,        // {privada, publicaB64}
  pestana: 'visitas',
  asignaciones: [],    // metadatos del servidor
  vistas: new Map(),   // asigId -> {estado, cierre, llave, resultados, abierto, error}
  config: null,        // config/general (jornadas, minutos de gracia)
  busqueda: '',
  desuscribir: null,
  ocultaDesde: null,
  aviso: null,
};

const ERRORES = {
  SIN_LLAVE_DIVISOR: 'La app aún no tiene configurada la llave del Divisor. Avísale al administrador.',
  TELEFONO_NO_REGISTRADO: 'Este teléfono no está registrado para tu usuario. Muestra tu código (pestaña "Mi código") al administrador.',
  EXTENSION_NO_FIRMADA: 'La extensión de horario no trae una firma válida del Divisor; se respeta el horario original.',
  FIRMA_INVALIDA: 'Un paquete no tiene una firma válida del Divisor y fue rechazado.',
  FUERA_DE_HORARIO: 'Esta asignación está fuera de horario o fue revocada.',
  NO_COINCIDE: 'Un paquete no corresponde a esta asignación y fue rechazado.',
};

function mensajeError(e) {
  if (D.esNegado(e)) return ERRORES.FUERA_DE_HORARIO;
  return ERRORES[e?.message] || 'No se pudo cargar. Revisa tu conexión e inténtalo de nuevo.';
}

function avisar(texto, tipo = 'ok') {
  S.aviso = { texto, tipo };
  render();
  clearTimeout(avisar.t);
  avisar.t = setTimeout(() => { S.aviso = null; render(); }, 5000);
}

// ---------------- Borrado de datos ----------------
function borrarDatosClientes() {
  for (const v of S.vistas.values()) { v.abierto = null; v.llave = null; }
  S.vistas.clear();
}

const graciaMs = () => 60000 * (Number.isInteger(S.config?.graciaMinutos) ? S.config.graciaMinutos : GRACIA_MINUTOS_POR_DEFECTO);

// ---------------- Carga de una asignacion ----------------
// Ya NO se descargan los clientes: solo el resumen. Cada cliente se abre
// uno por uno escribiendo su numero (y el servidor exige que sea uno a la vez).
async function cargarAsignacion(a) {
  const vista = { estado: 'cargando', cierre: ms(a.finOriginal ?? a.fin), error: null, finVisto: ms(a.fin), resultados: [], abierto: null, llave: null };
  S.vistas.set(a.id, vista);
  render();
  try {
    if (!divisorKeys().length) throw new Error('SIN_LLAVE_DIVISOR');
    if (!S.perfil?.llavePublica || S.perfil.llavePublica !== S.llaves.publicaB64) throw new Error('TELEFONO_NO_REGISTRADO');
    vista.cierre = await cierreValido(a, divisorKeys()).catch((e) => {
      if (e.message === 'EXTENSION_NO_FIRMADA') { vista.aviso = ERRORES.EXTENSION_NO_FIRMADA; return ms(a.finOriginal); }
      throw e;
    });
    if (Date.now() >= vista.cierre) { S.vistas.delete(a.id); render(); return; }

    await D.registrarConsulta(a, S.usuario.uid);
    vista.llave = await llaveBusqueda(a, S.llaves.privada);
    vista.resultados = await D.resultados(a.id);
    // Si quedo un cliente abierto (por ejemplo, se cerro la app), se retoma ese.
    const abierto = await D.clienteAbierto(a.id);
    if (S.vistas.get(a.id) !== vista) return;
    vista.estado = 'lista';
    if (abierto) await mostrarCliente(a, vista, abierto).catch((e) => { vista.abierto = { id: abierto, datos: null, error: ERRORES[e.message] || mensajeError(e) }; });
  } catch (e) {
    vista.estado = 'error';
    vista.error = mensajeError(e);
  }
  render();
}

async function mostrarCliente(a, vista, cliente) {
  const p = await D.paquete(a.id, cliente);
  if (!p) throw new Error('Sin datos');
  const datos = await abrirCliente(cliente, p, a, S.llaves.privada, divisorKeys());
  if (S.vistas.get(a.id) !== vista) return;
  vista.abierto = { id: cliente, datos, gracia: null };
}

function contar(vista, a) {
  const encontrados = new Set(vista.resultados.filter((r) => r.resultado === 'encontrado').map((r) => r.cliente));
  return { encontrados: encontrados.size, pendientes: a.cantidadClientes - encontrados.size, set: encontrados };
}

function intentos(vista, cliente) {
  return vista.resultados.filter((r) => r.resultado === 'no_encontrado' && r.cliente === cliente);
}

// ---------------- Buscar por numero ----------------
async function buscar(texto) {
  const tel = normalizarTelefono(texto);
  if (!tel) { avisar('Escribe un número de 8 dígitos (por ejemplo 2785-1234).', 'error'); return; }
  const ahora = Date.now();
  const activas = S.asignaciones.filter((a) => S.vistas.get(a.id)?.estado === 'lista' && ahora < S.vistas.get(a.id).cierre);
  const ocupada = activas.find((a) => S.vistas.get(a.id).abierto && !S.vistas.get(a.id).abierto.gracia);
  for (const a of activas) {
    const v = S.vistas.get(a.id);
    const cli = await buscarCliente(a, v.llave, tel);
    if (!cli) continue;
    if (contar(v, a).set.has(cli)) { avisar('Ese cliente ya fue marcado como encontrado.', 'error'); return; }
    if (v.abierto?.id === cli) { render(); return; }
    if (ocupada) { avisar('Primero registra el resultado del cliente que tienes abierto.', 'error'); return; }
    if (v.abierto?.gracia) { v.abierto = null; }
    try {
      await D.abrir(a, S.usuario.uid, cli);
    } catch (e) {
      avisar(D.esNegado(e) ? 'El servidor no permitió abrirlo (fuera de horario, revocado u otro cliente abierto).'
        : 'No se pudo abrir. Revisa tu conexión.', 'error');
      render();
      return;
    }
    S.busqueda = '';
    try {
      await mostrarCliente(a, v, cli);
    } catch (e) {
      // Quedo abierto en el servidor pero no se pudo mostrar: se ofrece cerrarlo.
      v.abierto = { id: cli, datos: null, error: ERRORES[e.message] || mensajeError(e) };
      avisar(D.esNegado(e) ? 'El servidor no permitió abrirlo (fuera de horario, revocado u otro cliente abierto).'
        : (ERRORES[e.message] || 'No se pudo abrir. Revisa tu conexión.'), 'error');
    }
    render();
    return;
  }
  avisar('Ese número no está entre tus clientes autorizados en este momento.', 'error');
}

function sincronizar() {
  const ahora = Date.now();
  const porId = new Map(S.asignaciones.map((a) => [a.id, a]));
  // Quitar las que ya no estan, fueron revocadas, vencieron o cambiaron de cierre.
  for (const [id, v] of S.vistas) {
    const a = porId.get(id);
    if (!a || a.revocada || ahora >= v.cierre || (v.finVisto !== ms(a.fin) && v.estado !== 'cargando')) {
      v.abierto = null; v.llave = null;
      S.vistas.delete(id);
    }
  }
  // Fin del tiempo de gracia: la ficha se borra sola.
  for (const v of S.vistas.values()) {
    if (v.abierto?.gracia && ahora >= v.abierto.gracia) v.abierto = null;
  }
  // Cargar las que estan en horario.
  for (const a of S.asignaciones) {
    if (!S.vistas.has(a.id) && !a.revocada && ahora >= ms(a.inicio) && ahora < Math.max(ms(a.fin), ms(a.finOriginal ?? a.fin))) {
      cargarAsignacion(a);
    }
  }
  render();
}

// ---------------- Sesion ----------------
async function alCambiarSesion(u) {
  if (S.desuscribir) { S.desuscribir(); S.desuscribir = null; }
  borrarDatosClientes();
  S.usuario = u;
  S.perfil = null;
  S.asignaciones = [];
  S.errorPerfil = null;
  S.errorEscucha = null;
  S.config = null;
  S.busqueda = '';
  S.pestana = 'visitas';
  if (!u) { render(); return; }
  render();
  try {
    S.perfil = await D.perfil(u.uid);
  } catch (e) {
    S.perfil = null;
    S.errorPerfil = D.esNegado(e) ? 'El servidor no permite leer tu perfil.' : 'No se pudo leer tu perfil (sin conexión).';
  }
  if (S.perfil?.rol === 'tecnico' && S.perfil.activo) {
    S.config = await D.configuracion().catch(() => null);
    S.desuscribir = D.escucharAsignaciones(u.uid,
      (lista) => { S.asignaciones = lista; sincronizar(); },
      (e) => {
        borrarDatosClientes();
        S.asignaciones = [];
        S.errorEscucha = D.esNegado(e) ? 'Tu usuario fue desactivado o ya no tiene permiso.' : 'Se perdió la conexión con el servidor.';
        render();
      });
  }
  render();
}

// ---------------- Acciones ----------------
function obtenerGPS() {
  return new Promise((ok) => {
    if (!navigator.geolocation) return ok(null);
    navigator.geolocation.getCurrentPosition(
      (p) => ok({ lat: p.coords.latitude, lon: p.coords.longitude, precision: Math.round(p.coords.accuracy) }),
      () => ok(null), { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
  });
}

function clienteAbiertoDe(asigId) {
  const v = S.vistas.get(asigId);
  return v?.abierto && (v.abierto.datos || v.abierto.error) && !v.abierto.gracia ? v : null;
}

async function confirmarEncontrado(asigId) {
  const a = S.asignaciones.find((x) => x.id === asigId);
  const v = clienteAbiertoDe(asigId);
  if (!a || !v || !v.abierto.datos) return;
  const { id: cli, datos } = v.abierto;
  const min = Math.round(graciaMs() / 60000);
  abrirModal(`
    <h2>¿Confirmas que encontraste a este cliente?</h2>
    <p class="confirmar"><b>${esc(datos.nombre) || 'Sin nombre'}</b><br>${esc(datos.telefono)}</p>
    <p class="nota">${min ? `La ficha seguirá visible <b>${min} minuto(s)</b> por si necesitas llamar; después se borra sola.`
    : 'La ficha se borra de inmediato.'} No se puede deshacer.</p>
    <label class="check"><input type="checkbox" id="m-gps" checked> Registrar mi ubicación GPS como constancia</label>
    <div class="fila-botones">
      <button class="sec" data-accion="cerrar-modal">No, volver</button>
      <button class="pri" id="m-ok">Sí, cliente encontrado</button>
    </div>`);
  $('#m-ok').onclick = async () => {
    const b = $('#m-ok'); b.disabled = true; b.textContent = 'Guardando…';
    const quiereGps = $('#m-gps').checked;
    const gps = quiereGps ? await obtenerGPS() : null;
    try {
      await D.marcarEncontrado(a, S.usuario.uid, cli, gps);
      v.resultados.push({ resultado: 'encontrado', cliente: cli });
      if (graciaMs() > 0) v.abierto.gracia = Date.now() + graciaMs();
      else v.abierto = null;
      cerrarModal();
      avisar(quiereGps && !gps ? 'Cliente encontrado (no se pudo obtener el GPS).' : 'Cliente encontrado. Ya puedes buscar el siguiente.');
    } catch (e) {
      cerrarModal();
      avisar(D.esNegado(e) ? 'El servidor lo rechazó: la asignación ya no está vigente.' : 'No se pudo guardar. Revisa tu conexión.', 'error');
    }
    render();
  };
}

async function confirmarNoEncontrado(asigId) {
  const a = S.asignaciones.find((x) => x.id === asigId);
  const v = clienteAbiertoDe(asigId);
  if (!a || !v) return;
  const { id: cli } = v.abierto;
  const datos = v.abierto.datos || { nombre: 'Cliente con datos dañados', telefono: '' };
  abrirModal(`
    <h2>No encontrado</h2>
    <p><b>${esc(datos.nombre) || esc(datos.telefono)}</b></p>
    <label>Motivo
      <select id="m-motivo">${MOTIVOS_NO_ENCONTRADO.map(([val, txt]) => `<option value="${val}">${txt}</option>`).join('')}</select>
    </label>
    <label>Detalle (opcional)<textarea id="m-detalle" maxlength="300" rows="3" placeholder="Ej.: regresar después de las 2"></textarea></label>
    <p class="nota">La ficha se cierra para que puedas buscar el siguiente. Este cliente sigue pendiente: lo puedes volver a buscar hoy.</p>
    <div class="fila-botones">
      <button class="sec" data-accion="cerrar-modal">Cancelar</button>
      <button class="pri" id="m-ok">Guardar</button>
    </div>`);
  $('#m-ok').onclick = async () => {
    const motivo = $('#m-motivo').value, detalle = $('#m-detalle').value.trim();
    $('#m-ok').disabled = true;
    try {
      await D.marcarNoEncontrado(a, S.usuario.uid, cli, motivo, detalle);
      v.resultados.push({ resultado: 'no_encontrado', cliente: cli, motivo });
      v.abierto = null;
      cerrarModal();
      avisar('Intento registrado. Ya puedes buscar el siguiente.');
    } catch (e) {
      cerrarModal();
      avisar(D.esNegado(e) ? 'El servidor lo rechazó: la asignación ya no está vigente.' : 'No se pudo guardar. Revisa tu conexión.', 'error');
    }
    render();
  };
}

function abrirModal(html) {
  $('#modal-caja').innerHTML = html;
  $('#modal').hidden = false;
}
function cerrarModal() { $('#modal').hidden = true; $('#modal-caja').innerHTML = ''; }

// ---------------- Vistas ----------------
function vistaLogin() {
  return `
  <section class="tarjeta">
    <h2>Iniciar sesión</h2>
    <form id="f-login">
      <label>Correo<input type="email" id="l-correo" autocomplete="username" required></label>
      <label>Contraseña<input type="password" id="l-clave" autocomplete="current-password" required></label>
      <button class="pri ancho" type="submit">Entrar</button>
      <p class="error" id="l-error"></p>
    </form>
  </section>
  ${vistaCodigo(true)}`;
}

function vistaCodigo(compacta = false) {
  return `
  <section class="tarjeta">
    <h2>${compacta ? 'Primera vez: código de este teléfono' : 'Código de registro de este teléfono'}</h2>
    <p class="nota">El administrador escanea este código una sola vez para que este teléfono pueda abrir tus visitas.
    No es una contraseña: puede verse sin riesgo.</p>
    <div class="qr" id="qr"></div>
    <p class="huella">Huella: <b id="huella">…</b></p>
    <div class="fila-botones">
      <button class="sec" data-accion="copiar-codigo">Copiar código</button>
      <button class="sec" data-accion="compartir-codigo">Compartir</button>
    </div>
    <p class="nota">Si borras los datos del navegador o cambias de teléfono, se genera un código nuevo y hay que registrarlo otra vez.</p>
  </section>`;
}

// iPhone/iPad (incluye iPad que se presenta como Mac).
const esIPhone = () => /iPhone|iPad|iPod/.test(navigator.userAgent)
  || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

function enlaces(d) {
  const tel = String(d.telefono || '').replace(/\D/g, '');
  const contacto = String(d.contacto || '').replace(/\D/g, '');
  // WhatsApp solo para celulares: en Honduras las lineas fijas empiezan con 2 y no tienen WhatsApp.
  const local = (n) => (n.length === 11 && n.startsWith(PREFIJO_PAIS) ? n.slice(3) : n);
  const esCelular = (n) => /^[3-9]\d{7}$/.test(local(n));
  const wa = [contacto, tel].find((n) => n && esCelular(n)) || '';
  const geo = d.lat != null && d.lon != null;
  return `
    <div class="acciones">
      ${geo ? `<a class="btn waze" href="https://waze.com/ul?ll=${d.lat},${d.lon}&navigate=yes" target="_blank" rel="noopener">Waze</a>
               <a class="btn maps" href="https://www.google.com/maps/dir/?api=1&destination=${d.lat},${d.lon}" target="_blank" rel="noopener">Google Maps</a>
               ${esIPhone()
    ? `<a class="btn apple" href="https://maps.apple.com/?daddr=${d.lat},${d.lon}&dirflg=d" target="_blank" rel="noopener">Apple Maps</a>`
    : `<a class="btn otra" href="geo:${d.lat},${d.lon}?q=${d.lat},${d.lon}">Otra app de mapas</a>`}` : ''}
      ${tel ? `<a class="btn" href="tel:${tel}">Llamar ${esc(d.telefono)}</a>` : ''}
      ${contacto && contacto !== tel ? `<a class="btn" href="tel:${contacto}">Llamar contacto</a>` : ''}
      ${wa ? `<a class="btn wa" href="https://wa.me/${PREFIJO_PAIS + local(wa)}" target="_blank" rel="noopener">WhatsApp</a>` : ''}
    </div>`;
}

function fichaError(a, v) {
  return `
  <div class="cliente abierto" data-cli="${v.abierto.id}">
    <p class="error">${esc(v.abierto.error)}</p>
    <p class="nota">Para seguir con el siguiente cliente, cierra este registrándolo como no atendido y avisa al autorizador.</p>
    <div class="resultado"><button class="sec" data-accion="no-encontrado" data-asig="${a.id}">Cerrar este cliente</button></div>
  </div>`;
}

function fichaCliente(a, v) {
  if (!v.abierto.datos) return fichaError(a, v);
  const c = v.abierto, d = c.datos;
  const geo = d.lat != null && d.lon != null;
  const motivos = Object.fromEntries(MOTIVOS_NO_ENCONTRADO);
  const previos = intentos(v, c.id);
  const tec = d.tecnico || null;
  const restante = c.gracia ? Math.max(0, c.gracia - Date.now()) : 0;
  return `
  <div class="cliente abierto${c.gracia ? ' gracia' : ''}" data-cli="${c.id}">
    ${c.gracia ? `<p class="aviso-gracia">✓ Cliente encontrado. Esta ficha se borrará en <b id="cuenta">${Math.floor(restante / 60000)}:${String(Math.floor((restante % 60000) / 1000)).padStart(2, '0')}</b></p>` : ''}
    <div class="cab">
      <span class="tipo ${d.tipo === 'Mora' ? 'mora' : 'rep'}">${d.tipo === 'Mora' ? 'Mora' : d.tipo === 'Reparacion' ? 'Reparación' : esc(d.tipo)}</span>
      <h3>${esc(d.nombre) || 'Sin nombre'}</h3>
    </div>
    <dl>
      <dt>Teléfono</dt><dd>${esc(d.telefono) || '—'}</dd>
      <dt>Contacto</dt><dd>${esc(d.contacto) || '—'}</dd>
      <dt>Ubicación</dt><dd>${geo ? `${Number(d.lat).toFixed(5)}, ${Number(d.lon).toFixed(5)}` : '<span class="alerta">Sin ubicación registrada</span>'}</dd>
      ${tec ? `${tec.armario ? `<dt>Armario</dt><dd>${esc(tec.armario)}</dd>` : ''}${tec.caja_terminal ? `<dt>Caja terminal</dt><dd>${esc(tec.caja_terminal)}</dd>` : ''}${tec.par_primario || tec.par_secundario ? `<dt>Pares</dt><dd>${esc(tec.par_primario || '—')} / ${esc(tec.par_secundario || '—')}</dd>` : ''}` : ''}
    </dl>
    ${previos.length ? `<p class="intentos">Intentos sin éxito hoy: ${previos.length} (último: ${esc(motivos[previos.at(-1).motivo] || previos.at(-1).motivo)})</p>` : ''}
    ${enlaces(d)}
    ${c.gracia ? '' : `<div class="resultado">
      <button class="pri" data-accion="encontrado" data-asig="${a.id}">Cliente encontrado</button>
      <button class="sec" data-accion="no-encontrado" data-asig="${a.id}">No encontrado</button>
    </div>`}
  </div>`;
}

function vistaVisitas() {
  const p = S.perfil;
  if (S.errorPerfil) return `<section class="tarjeta"><p class="error">${esc(S.errorPerfil)}</p></section>`;
  if (!p) return `<section class="tarjeta"><p>Cargando tu perfil…</p></section>`;
  if (p.rol !== 'tecnico') {
    return `<section class="tarjeta"><h2>Hola, ${esc(p.nombre)}</h2>
      <p>Tu usuario es <b>${p.rol === 'admin' ? 'administrador' : esc(p.rol)}</b>. Esta app muestra visitas solo a técnicos.
      Revisa la pestaña <b>Diagnóstico</b> para confirmar que el servidor te reconoce.</p></section>`;
  }
  if (!p.activo) return `<section class="tarjeta"><p class="error">Tu usuario está desactivado. Habla con el administrador.</p></section>`;
  if (S.errorEscucha) return `<section class="tarjeta"><p class="error">${esc(S.errorEscucha)}</p></section>`;

  const ahora = Date.now();
  const activas = S.asignaciones.filter((a) => S.vistas.has(a.id));
  const proximas = S.asignaciones
    .filter((a) => !a.revocada && ms(a.inicio) > ahora)
    .sort((x, y) => ms(x.inicio) - ms(y.inicio));

  if (!activas.length) {
    return `<section class="tarjeta vacio">
      <h2>No tienes clientes autorizados en este momento</h2>
      ${proximas.length ? `<p>Próxima asignación: <b>${new Date(ms(proximas[0].inicio)).toLocaleDateString('es-HN', { weekday: 'long', day: 'numeric', month: 'long' })}</b>, de ${hora(ms(proximas[0].inicio))} a ${hora(ms(proximas[0].fin))}${proximas[0].cantidadClientes ? ` · ${proximas[0].cantidadClientes} cliente(s)` : ''}.</p>` : '<p>Cuando el autorizador te asigne visitas, aparecerán aquí en su horario.</p>'}
    </section>`;
  }

  const listas = activas.filter((a) => S.vistas.get(a.id).estado === 'lista');
  const ocupada = listas.some((a) => clienteAbiertoDe(a.id));
  const buscador = listas.length ? `
    <section class="tarjeta buscador">
      <form id="f-buscar">
        <label>Escribe el número telefónico del cliente
          <input id="b-tel" inputmode="numeric" autocomplete="off" maxlength="14" placeholder="2785-1234" value="${esc(S.busqueda)}" ${ocupada ? 'disabled' : ''}>
        </label>
        <button class="pri ancho" type="submit" ${ocupada ? 'disabled' : ''}>Buscar</button>
      </form>
      ${ocupada ? '<p class="nota">Registra el resultado del cliente abierto para buscar el siguiente.</p>' : '<p class="nota">Se muestra un cliente a la vez. Cada búsqueda queda registrada.</p>'}
    </section>` : '';

  return buscador + activas.map((a) => {
    const v = S.vistas.get(a.id);
    const restan = Math.max(0, v.cierre - ahora);
    const h = Math.floor(restan / 3600000), m = Math.floor((restan % 3600000) / 60000);
    const n = contar(v, a);
    return `
    <section class="tarjeta asig" data-asig="${a.id}">
      <div class="reloj">
        <div><b>${esc(a.municipio)}</b>${a.area ? ` · ${AREA[a.area] || esc(a.area)}` : ''}</div>
        <div class="conteo">${a.cantidadClientes} cliente(s) · <b>${n.encontrados}</b> encontrado(s) · <b>${n.pendientes}</b> pendiente(s)</div>
        <div class="cierre">Se cierra a las <b>${hora(v.cierre)}</b> (${h ? h + ' h ' : ''}${m} min)${a.extensiones ? ' · extendida' : ''}</div>
      </div>
      ${v.aviso ? `<p class="alerta">${esc(v.aviso)}</p>` : ''}
      ${v.estado === 'cargando' ? '<p>Preparando tus visitas…</p>' : ''}
      ${v.estado === 'error' ? `<p class="error">${esc(v.error)}</p><button class="sec" data-accion="reintentar" data-asig="${a.id}">Reintentar</button>` : ''}
      ${v.estado === 'lista' && (v.abierto?.datos || v.abierto?.error) ? fichaCliente(a, v) : ''}
    </section>`;
  }).join('');
}

function vistaDiagnostico() {
  const p = S.perfil;
  const filas = [];
  const fila = (ok, titulo, detalle) => filas.push(`<li class="${ok === true ? 'ok' : ok === false ? 'mal' : 'info'}"><b>${titulo}</b><span>${detalle}</span></li>`);
  fila(true, 'Sesión iniciada', `${esc(S.usuario.correo)}<br><small>UID: ${esc(S.usuario.uid)}</small>`);
  if (S.errorPerfil) fila(false, 'Perfil en el servidor', esc(S.errorPerfil));
  else if (!p) fila(false, 'Perfil en el servidor', 'No existe un perfil para tu usuario. El administrador debe crearlo.');
  else {
    fila(true, 'Reglas de seguridad de Hondutel Ubica', 'El servidor permitió leer tu propio perfil (solo es posible con las reglas correctas).');
    fila(p.activo === true, 'Usuario activo', p.activo ? 'Sí' : 'No — está desactivado');
    fila(['admin', 'autorizador', 'tecnico'].includes(p.rol), 'Rol reconocido por el servidor',
      { admin: 'Administrador', autorizador: 'Autorizador', tecnico: 'Técnico' }[p.rol] || esc(p.rol));
    if (p.rol === 'tecnico') fila(!!p.municipio, 'Municipio', esc(p.municipio || '—'));
    if (p.rol === 'tecnico') {
      const reg = p.llavePublica && p.llavePublica === S.llaves?.publicaB64;
      fila(reg, 'Este teléfono está registrado', reg ? 'Sí, el código coincide' : (p.llavePublica ? 'No: tu usuario tiene registrado OTRO teléfono' : 'No: falta registrar el código de este teléfono'));
    }
  }
  fila(divisorKeys().length > 0, 'Llave del Divisor', divisorKeys().length ? `Configurada (${divisorKeys().length})` : 'Pendiente. Sin ella la app no muestra clientes.');
  fila(null, 'Huella de este teléfono', `<span id="d-huella">…</span>`);
  fila(null, 'Hora del teléfono', new Date().toLocaleString('es-HN'));
  fila(null, 'Versión de la app', APP_VERSION);
  return `<section class="tarjeta"><h2>Diagnóstico</h2><ul class="diag">${filas.join('')}</ul>
    <p class="nota">El horario lo controla el servidor; la hora del teléfono solo se usa para el reloj en pantalla.</p></section>`;
}

function render() {
  const raiz = $('#app');
  const foco = document.activeElement?.id;
  const enSesion = !!S.usuario;
  $('#pestanas').hidden = !enSesion;
  $('#salir').hidden = !enSesion;
  $('#quien').textContent = enSesion && S.perfil ? `${S.perfil.nombre}${S.perfil.municipio ? ' · ' + S.perfil.municipio : ''}` : '';
  for (const b of document.querySelectorAll('#pestanas button')) b.classList.toggle('activa', b.dataset.pestana === S.pestana);
  $('#aviso').hidden = !S.aviso;
  if (S.aviso) { $('#aviso').textContent = S.aviso.texto; $('#aviso').className = 'aviso ' + S.aviso.tipo; }

  if (!enSesion) raiz.innerHTML = vistaLogin();
  else if (S.pestana === 'codigo') raiz.innerHTML = vistaCodigo();
  else if (S.pestana === 'diagnostico') raiz.innerHTML = vistaDiagnostico();
  else raiz.innerHTML = vistaVisitas();

  if ($('#qr') && S.llaves) {
    QRCode.toString(S.llaves.publicaB64, { type: 'svg', errorCorrectionLevel: 'M', margin: 1 })
      .then((svg) => { const q = $('#qr'); if (q) q.innerHTML = svg; });
  }
  const h = $('#huella') || $('#d-huella');
  if (h && S.llaves) huella(S.llaves.publicaB64).then((x) => { h.textContent = x; });
  const f = $('#f-login');
  if (f) f.onsubmit = entrarFormulario;
  const fb = $('#f-buscar');
  if (fb) {
    const inp = $('#b-tel');
    if (foco === 'b-tel' && !inp.disabled) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); }
    inp.oninput = () => { S.busqueda = inp.value; };
    fb.onsubmit = (ev) => { ev.preventDefault(); const tx = inp.value; fb.querySelector('button').disabled = true; buscar(tx); };
  }
}

async function entrarFormulario(ev) {
  ev.preventDefault();
  const err = $('#l-error');
  const b = ev.target.querySelector('button');
  b.disabled = true; err.textContent = '';
  try {
    await D.entrar($('#l-correo').value.trim(), $('#l-clave').value);
  } catch (e) {
    const c = e.code || '';
    err.textContent = /invalid-credential|wrong-password|user-not-found|invalid-email/.test(c) ? 'Correo o contraseña incorrectos.'
      : /too-many-requests/.test(c) ? 'Demasiados intentos. Espera unos minutos.'
        : /user-disabled/.test(c) ? 'Este usuario está deshabilitado.'
          : 'No se pudo iniciar sesión. Revisa tu conexión.';
    b.disabled = false;
  }
}

// ---------------- Eventos globales ----------------
document.addEventListener('click', async (ev) => {
  const t = ev.target.closest('[data-accion],[data-pestana]');
  if (!t) return;
  if (t.dataset.pestana) { S.pestana = t.dataset.pestana; render(); return; }
  const acc = t.dataset.accion;
  if (acc === 'encontrado') confirmarEncontrado(t.dataset.asig);
  else if (acc === 'no-encontrado') confirmarNoEncontrado(t.dataset.asig);
  else if (acc === 'cerrar-modal') cerrarModal();
  else if (acc === 'reintentar') { S.vistas.delete(t.dataset.asig); sincronizar(); }
  else if (acc === 'copiar-codigo') {
    try { await navigator.clipboard.writeText(S.llaves.publicaB64); avisar('Código copiado.'); } catch { avisar('No se pudo copiar.', 'error'); }
  } else if (acc === 'compartir-codigo') {
    if (navigator.share) navigator.share({ title: 'Código Hondutel Ubica', text: S.llaves.publicaB64 }).catch(() => {});
    else avisar('Tu navegador no permite compartir; usa "Copiar código".', 'error');
  } else if (acc === 'salir') {
    borrarDatosClientes();
    await D.salir();
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) { S.ocultaDesde = Date.now(); return; }
  if (S.ocultaDesde && Date.now() - S.ocultaDesde > MINUTOS_OCULTA_PARA_BORRAR * 60000) {
    borrarDatosClientes();
    sincronizar();   // vuelve a pedirlos al servidor (si sigue en horario) y queda en bitacora
  }
  S.ocultaDesde = null;
});

// Reloj: actualiza el contador, borra al cierre y abre las que entran en horario.
setInterval(() => { if (S.usuario) sincronizar(); }, 15000);

// Cuenta regresiva del tiempo de gracia (cada segundo, sin redibujar todo).
setInterval(() => {
  for (const v of S.vistas.values()) {
    if (!v.abierto?.gracia) continue;
    const r = v.abierto.gracia - Date.now();
    if (r <= 0) { v.abierto = null; render(); return; }
    const el = $('#cuenta');
    if (el) el.textContent = `${Math.floor(r / 60000)}:${String(Math.floor((r % 60000) / 1000)).padStart(2, '0')}`;
  }
}, 1000);

// ---------------- Arranque ----------------
(async () => {
  try {
    S.llaves = await obtenerLlaves();
  } catch {
    $('#app').innerHTML = '<section class="tarjeta"><p class="error">Este navegador no permite guardar la llave segura. Usa Chrome actualizado y no el modo incógnito.</p></section>';
    return;
  }
  render();
  D.alCambiarSesion(alCambiarSesion);
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('./sw.js').catch(() => {});
})();
