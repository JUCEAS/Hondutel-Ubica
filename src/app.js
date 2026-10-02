// =====================================================================
//  HONDUTEL UBICA - App del tecnico (interfaz)
// =====================================================================
import QRCode from 'qrcode';
import * as D from './datos.js';
import {
  obtenerLlaves, huella, cierreValido, abrirCliente,
} from './cripto.js';
import {
  APP_VERSION, DIVISOR_PUBLIC_KEY_B64, MINUTOS_OCULTA_PARA_BORRAR, PREFIJO_PAIS, MOTIVOS_NO_ENCONTRADO,
} from './config.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const ms = (t) => (t == null ? null : typeof t === 'number' ? t : t.toMillis());
const hora = (m) => new Date(m).toLocaleTimeString('es-HN', { hour: 'numeric', minute: '2-digit' });
const divisorKey = () => globalThis.__HU_DIVISOR_KEY ?? DIVISOR_PUBLIC_KEY_B64;

// ---------------- Estado (solo en memoria) ----------------
const S = {
  usuario: null,       // {uid, correo}
  perfil: null,
  llaves: null,        // {privada, publicaB64}
  pestana: 'visitas',
  asignaciones: [],    // metadatos del servidor
  vistas: new Map(),   // asigId -> {estado, cierre, clientes:[], error}
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
  for (const v of S.vistas.values()) v.clientes = [];
  S.vistas.clear();
}

function esActiva(a, ahora = Date.now()) {
  const v = S.vistas.get(a.id);
  const cierre = v?.cierre ?? ms(a.finOriginal ?? a.fin);
  return !a.revocada && ahora >= ms(a.inicio) && ahora < cierre;
}

// ---------------- Carga de una asignacion ----------------
async function cargarAsignacion(a) {
  const vista = { estado: 'cargando', clientes: [], cierre: ms(a.finOriginal ?? a.fin), error: null, finVisto: ms(a.fin) };
  S.vistas.set(a.id, vista);
  render();
  try {
    if (!divisorKey()) throw new Error('SIN_LLAVE_DIVISOR');
    if (!S.perfil?.llavePublica || S.perfil.llavePublica !== S.llaves.publicaB64) throw new Error('TELEFONO_NO_REGISTRADO');
    vista.cierre = await cierreValido(a, divisorKey()).catch((e) => {
      if (e.message === 'EXTENSION_NO_FIRMADA') { vista.aviso = ERRORES.EXTENSION_NO_FIRMADA; return ms(a.finOriginal); }
      throw e;
    });
    if (Date.now() >= vista.cierre) { S.vistas.delete(a.id); render(); return; }

    await D.registrarConsulta(a, S.usuario.uid);
    const res = await D.resultados(a.id);
    const encontrados = new Set(res.filter((r) => r.resultado === 'encontrado').map((r) => r.cliente));
    const fallidos = {};
    for (const r of res.filter((x) => x.resultado === 'no_encontrado')) {
      (fallidos[r.cliente] ||= []).push(r.motivo);
    }

    const clientes = [];
    for (let i = 1; i <= a.cantidadClientes; i++) {
      const id = 'c' + String(i).padStart(2, '0');
      if (encontrados.has(id)) { clientes.push({ id, encontrado: true }); continue; }
      try {
        const p = await D.paquete(a.id, id);
        if (!p) { clientes.push({ id, error: 'Sin datos' }); continue; }
        const d = await abrirCliente(id, p, a, S.llaves.privada, divisorKey());
        clientes.push({ id, datos: d, fallidos: fallidos[id] || [] });
      } catch (e) {
        if (D.esNegado(e)) clientes.push({ id, encontrado: true });
        else clientes.push({ id, error: ERRORES[e.message] || 'No se pudo abrir' });
      }
    }
    if (S.vistas.get(a.id) !== vista) return;   // se borro mientras cargaba
    vista.clientes = clientes;
    vista.estado = 'lista';
  } catch (e) {
    vista.estado = 'error';
    vista.error = mensajeError(e);
  }
  render();
}

function sincronizar() {
  const ahora = Date.now();
  const porId = new Map(S.asignaciones.map((a) => [a.id, a]));
  // Quitar las que ya no estan, fueron revocadas, vencieron o cambiaron de cierre.
  for (const [id, v] of S.vistas) {
    const a = porId.get(id);
    if (!a || a.revocada || ahora >= v.cierre || (v.finVisto !== ms(a.fin) && v.estado !== 'cargando')) {
      v.clientes = [];
      S.vistas.delete(id);
    }
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

async function confirmarEncontrado(asigId, cli) {
  const a = S.asignaciones.find((x) => x.id === asigId);
  const c = S.vistas.get(asigId)?.clientes.find((x) => x.id === cli);
  if (!a || !c?.datos) return;
  abrirModal(`
    <h2>¿Cliente encontrado?</h2>
    <p><b>${esc(c.datos.nombre)}</b></p>
    <p class="nota">Al confirmar, la dirección de este cliente <b>desaparece de inmediato</b> y no se puede deshacer.</p>
    <label class="check"><input type="checkbox" id="m-gps" checked> Registrar mi ubicación GPS como constancia</label>
    <div class="fila-botones">
      <button class="sec" data-accion="cerrar-modal">Cancelar</button>
      <button class="pri" id="m-ok">Sí, encontrado</button>
    </div>`);
  $('#m-ok').onclick = async () => {
    const b = $('#m-ok'); b.disabled = true; b.textContent = 'Guardando…';
    const quiereGps = $('#m-gps').checked;
    const gps = quiereGps ? await obtenerGPS() : null;
    try {
      await D.marcarEncontrado(a, S.usuario.uid, cli, gps);
      c.datos = null; c.encontrado = true;
      cerrarModal();
      avisar(quiereGps && !gps ? 'Cliente marcado como encontrado (no se pudo obtener el GPS).' : 'Cliente marcado como encontrado.');
    } catch (e) {
      cerrarModal();
      avisar(D.esNegado(e) ? 'El servidor lo rechazó: la asignación ya no está vigente.' : 'No se pudo guardar. Revisa tu conexión.', 'error');
    }
    render();
  };
}

async function confirmarNoEncontrado(asigId, cli) {
  const a = S.asignaciones.find((x) => x.id === asigId);
  const c = S.vistas.get(asigId)?.clientes.find((x) => x.id === cli);
  if (!a || !c?.datos) return;
  abrirModal(`
    <h2>No encontrado</h2>
    <p><b>${esc(c.datos.nombre)}</b></p>
    <label>Motivo
      <select id="m-motivo">${MOTIVOS_NO_ENCONTRADO.map(([v, t]) => `<option value="${v}">${t}</option>`).join('')}</select>
    </label>
    <label>Detalle (opcional)<textarea id="m-detalle" maxlength="300" rows="3" placeholder="Ej.: regresar después de las 2"></textarea></label>
    <p class="nota">La dirección seguirá visible para que puedas intentarlo de nuevo hoy.</p>
    <div class="fila-botones">
      <button class="sec" data-accion="cerrar-modal">Cancelar</button>
      <button class="pri" id="m-ok">Guardar</button>
    </div>`);
  $('#m-ok').onclick = async () => {
    const motivo = $('#m-motivo').value, detalle = $('#m-detalle').value.trim();
    $('#m-ok').disabled = true;
    try {
      await D.marcarNoEncontrado(a, S.usuario.uid, cli, motivo, detalle);
      c.fallidos = [...(c.fallidos || []), motivo];
      cerrarModal();
      avisar('Intento registrado.');
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

function tarjetaCliente(asigId, c) {
  if (c.encontrado) {
    return `<li class="cliente hecho" data-cli="${c.id}"><span class="marca">✓</span> Cliente encontrado — dirección retirada</li>`;
  }
  if (c.error) return `<li class="cliente error" data-cli="${c.id}">${esc(c.error)}</li>`;
  const d = c.datos;
  const geo = d.lat != null && d.lon != null;
  const motivos = Object.fromEntries(MOTIVOS_NO_ENCONTRADO);
  return `
  <li class="cliente" data-cli="${c.id}">
    <div class="cab">
      <span class="tipo ${d.tipo === 'Mora' ? 'mora' : 'rep'}">${d.tipo === 'Mora' ? 'Mora' : d.tipo === 'Reparacion' ? 'Reparación' : esc(d.tipo)}</span>
      <h3>${esc(d.nombre)}</h3>
    </div>
    <dl>
      <dt>Teléfono</dt><dd>${esc(d.telefono) || '—'}</dd>
      <dt>Contacto</dt><dd>${esc(d.contacto) || '—'}</dd>
      <dt>Ubicación</dt><dd>${geo ? `${Number(d.lat).toFixed(5)}, ${Number(d.lon).toFixed(5)}` : '<span class="alerta">Sin ubicación registrada</span>'}</dd>
    </dl>
    ${c.fallidos?.length ? `<p class="intentos">Intentos sin éxito: ${c.fallidos.length} (último: ${esc(motivos[c.fallidos.at(-1)] || c.fallidos.at(-1))})</p>` : ''}
    ${enlaces(d)}
    <div class="resultado">
      <button class="pri" data-accion="encontrado" data-asig="${asigId}" data-cli="${c.id}">Cliente encontrado</button>
      <button class="sec" data-accion="no-encontrado" data-asig="${asigId}" data-cli="${c.id}">No encontrado</button>
    </div>
  </li>`;
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
      ${proximas.length ? `<p>Próxima asignación: <b>${new Date(ms(proximas[0].inicio)).toLocaleDateString('es-HN', { weekday: 'long', day: 'numeric', month: 'long' })}</b>, de ${hora(ms(proximas[0].inicio))} a ${hora(ms(proximas[0].fin))}.</p>` : '<p>Cuando el autorizador te asigne visitas, aparecerán aquí en su horario.</p>'}
    </section>`;
  }

  return activas.map((a) => {
    const v = S.vistas.get(a.id);
    const restan = Math.max(0, v.cierre - ahora);
    const h = Math.floor(restan / 3600000), m = Math.floor((restan % 3600000) / 60000);
    const pendientes = v.clientes.filter((c) => c.datos).length;
    return `
    <section class="tarjeta asig" data-asig="${a.id}">
      <div class="reloj">
        <div><b>${esc(a.municipio)}</b> · ${v.clientes.length ? `${pendientes} pendiente(s) de ${a.cantidadClientes}` : `${a.cantidadClientes} cliente(s)`}</div>
        <div class="cierre">Se cierra a las <b>${hora(v.cierre)}</b> (${h ? h + ' h ' : ''}${m} min)${a.extensiones ? ' · extendida' : ''}</div>
      </div>
      ${v.aviso ? `<p class="alerta">${esc(v.aviso)}</p>` : ''}
      ${v.estado === 'cargando' ? '<p>Abriendo tus visitas…</p>' : ''}
      ${v.estado === 'error' ? `<p class="error">${esc(v.error)}</p><button class="sec" data-accion="reintentar" data-asig="${a.id}">Reintentar</button>` : ''}
      ${v.estado === 'lista' ? `<ul class="clientes">${v.clientes.map((c) => tarjetaCliente(a.id, c)).join('')}</ul>` : ''}
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
  fila(!!divisorKey(), 'Llave del Divisor', divisorKey() ? 'Configurada' : 'Pendiente (fase 4). Sin ella la app no muestra clientes.');
  fila(null, 'Huella de este teléfono', `<span id="d-huella">…</span>`);
  fila(null, 'Hora del teléfono', new Date().toLocaleString('es-HN'));
  fila(null, 'Versión de la app', APP_VERSION);
  return `<section class="tarjeta"><h2>Diagnóstico</h2><ul class="diag">${filas.join('')}</ul>
    <p class="nota">El horario lo controla el servidor; la hora del teléfono solo se usa para el reloj en pantalla.</p></section>`;
}

function render() {
  const raiz = $('#app');
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
  if (acc === 'encontrado') confirmarEncontrado(t.dataset.asig, t.dataset.cli);
  else if (acc === 'no-encontrado') confirmarNoEncontrado(t.dataset.asig, t.dataset.cli);
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
