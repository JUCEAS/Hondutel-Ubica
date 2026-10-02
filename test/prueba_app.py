"""
HONDUTEL UBICA - Prueba de punta a punta de la app del tecnico.
Navegador real (Chromium), servidor simulado con la logica de las reglas,
y paquetes cifrados/firmados con el MISMO codigo del Divisor.
Uso: python3 test/prueba_app.py   (requiere: node build.mjs --prueba)
"""
import json, os, subprocess, sys, threading, time, functools, http.server, socketserver
from playwright.sync_api import sync_playwright

RAIZ = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DIST = os.path.join(RAIZ, "dist-prueba")
CAPTURAS = os.path.join(RAIZ, "capturas")
PUERTO = 8765
os.makedirs(CAPTURAS, exist_ok=True)

resultados = []
def ok(cond, texto):
    resultados.append((bool(cond), texto))
    print(("  OK    " if cond else "  FALLO ") + texto, flush=True)

class H(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a): pass
srv = socketserver.TCPServer(("127.0.0.1", PUERTO), functools.partial(H, directory=DIST))
threading.Thread(target=srv.serve_forever, daemon=True).start()

H1, M = 3600_000, 60_000
ahora = int(time.time() * 1000)

with sync_playwright() as p:
    nav = p.chromium.launch()
    ctx = nav.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2,
                          geolocation={"latitude": 14.8497, "longitude": -85.8943, "accuracy": 15},
                          permissions=["geolocation"], locale="es-HN", timezone_id="America/Tegucigalpa")
    pg = ctx.new_page()
    errores_consola = []
    pg.on("console", lambda m: m.type == "error" and errores_consola.append(m.text))
    pg.on("pageerror", lambda e: errores_consola.append(str(e)))
    pg.goto(f"http://127.0.0.1:{PUERTO}/")
    pg.wait_for_selector("text=Iniciar sesión")

    print("\n1. Registro del telefono")
    pub = pg.evaluate("""() => new Promise(ok => { const r = indexedDB.open('hondutel-ubica', 1);
        r.onsuccess = () => { const g = r.result.transaction('llaves').objectStore('llaves').get('tecnico');
        g.onsuccess = () => ok({pub: g.result.publicaB64, privTipo: g.result.privada.type, extraible: g.result.privada.extractable}); }; })""")
    ok(len(pub["pub"]) > 500, "el telefono genero su llave y la guardo (codigo de %d caracteres)" % len(pub["pub"]))
    ok(pub["privTipo"] == "private" and pub["extraible"] is False, "la llave privada NO se puede exportar del telefono")
    pg.wait_for_selector("#qr svg")
    ok(pg.locator("#qr svg").count() == 1, "el codigo QR se muestra en la pantalla de inicio")
    pg.wait_for_function("document.querySelector('#huella').textContent.length > 5")
    ok(len(pg.inner_text("#huella").split("-")) == 6, "se muestra la huella corta: " + pg.inner_text("#huella"))

    # ---------- Paquetes reales del Divisor ----------
    A1 = {"id": "A1", "tecnicoUid": "tecCata", "inicio": ahora - H1, "fin": ahora + 2 * H1, "clientes": [
        {"tipo": "Mora", "nombre": "Cliente de Prueba Uno", "telefono": "27850000", "contacto": "99990000", "lat": 14.8497, "lon": -85.8943},
        {"tipo": "Reparacion", "nombre": "María Peña Núñez", "telefono": "27851111", "contacto": "", "lat": None, "lon": None},
        {"tipo": "Mora", "nombre": "<img src=x onerror=\"window.__xss=1\">Pedro", "telefono": "27852222", "contacto": "", "lat": 14.6, "lon": -86.2},
        {"tipo": "Mora", "nombre": "Cliente Alterado", "telefono": "27853333", "contacto": "", "lat": 14.7, "lon": -86.1}],
        "extensiones": [{"nombre": "valida", "fin": ahora + 3 * H1, "numero": 1},
                        {"nombre": "falsa", "fin": ahora + 3 * H1, "numero": 1, "falsa": True}]}
    A2 = {"id": "A2", "tecnicoUid": "tecCata", "inicio": ahora - 10 * M, "fin": ahora + 40_000,
          "clientes": [{"tipo": "Reparacion", "nombre": "Cliente Corto Plazo", "telefono": "27854444", "contacto": "", "lat": 14.5, "lon": -86.0}]}
    A3 = {"id": "A3", "tecnicoUid": "tecCata", "inicio": ahora + 20 * H1, "fin": ahora + 22 * H1,
          "clientes": [{"tipo": "Mora", "nombre": "Cliente Mañana", "telefono": "27855555", "contacto": "", "lat": 14.5, "lon": -86.0}]}
    A4 = {"id": "A4", "tecnicoUid": "tecOtroTel", "inicio": ahora - H1, "fin": ahora + H1,
          "clientes": [{"tipo": "Mora", "nombre": "Cliente Otro", "telefono": "27856666", "contacto": "", "lat": 14.5, "lon": -86.0}]}
    A5 = {"id": "A5", "tecnicoUid": "tecSinDiv", "inicio": ahora - H1, "fin": ahora + H1,
          "clientes": [{"tipo": "Mora", "nombre": "Cliente Sin Divisor", "telefono": "27857777", "contacto": "", "lat": 14.5, "lon": -86.0}]}
    entrada = {"tecnicoPublica": pub["pub"], "asignaciones": [A1, A2, A3, A4, A5]}
    gen = json.loads(subprocess.run([sys.executable, os.path.join(RAIZ, "test", "generar_paquetes.py")],
                                    input=json.dumps(entrada), capture_output=True, text=True, check=True,
                                    cwd=os.path.join(RAIZ, "test")).stdout)
    paq = {k: v["paquetes"] for k, v in gen["asignaciones"].items()}
    c = paq["A1"]["c04"]["cifrado"]
    paq["A1"]["c04"]["cifrado"] = c[:-8] + ("BBBBBBBB" if c.endswith("AAAAAAAA") else "AAAAAAAA")

    def meta(a, n):
        return {"tecnicoUid": a["tecnicoUid"], "autorizadorUid": "autCata", "municipio": "Catacamas",
                "inicio": a["inicio"], "fin": a["fin"], "finOriginal": a["fin"], "extensiones": 0,
                "cantidadClientes": n, "revocada": False}
    tec = lambda nombre, llave: {"nombre": nombre, "rol": "tecnico", "activo": True, "municipio": "Catacamas", "llavePublica": llave}
    pg.evaluate("([k, d]) => { globalThis.__HU_DIVISOR_KEY = k; __HU_FAKE.cargar(d); }", [gen["divisorPublica"], {
        "cuentas": {"tec@prueba.hn": {"clave": "clave-123", "uid": "tecCata"}, "admin@prueba.hn": {"clave": "clave-123", "uid": "adm"},
                    "otro@prueba.hn": {"clave": "clave-123", "uid": "tecOtroTel"}, "sindiv@prueba.hn": {"clave": "clave-123", "uid": "tecSinDiv"}},
        "usuarios": {"tecCata": tec("Técnico Catacamas", pub["pub"]), "adm": {"nombre": "Julio César", "rol": "admin", "activo": True},
                     "tecOtroTel": tec("Técnico Otro Teléfono", "MIIBOTRALLAVE"), "tecSinDiv": tec("Técnico Sin Divisor", pub["pub"])},
        "asignaciones": {"A1": meta(A1, 4), "A2": meta(A2, 1), "A3": meta(A3, 1), "A4": meta(A4, 1), "A5": meta(A5, 1)},
        "paquetes": paq,
    }])
    def entrar(correo, clave="clave-123"):
        pg.fill("#l-correo", correo); pg.fill("#l-clave", clave); pg.click("#f-login button")
    def salir():
        pg.click("#salir"); pg.wait_for_selector("text=Iniciar sesión")

    print("\n2. Inicio de sesion")
    entrar("tec@prueba.hn", "mala")
    pg.wait_for_selector("text=Correo o contraseña incorrectos.")
    ok(True, "contraseña incorrecta: muestra 'Correo o contraseña incorrectos.'")
    entrar("tec@prueba.hn")
    pg.wait_for_selector("text=Cliente de Prueba Uno", timeout=20000)
    ok(True, "el tecnico entra y ve sus visitas")
    ok("Técnico Catacamas · Catacamas" in pg.inner_text("#quien"), "la barra muestra su nombre y municipio")

    print("\n3. Lista de visitas y datos descifrados")
    tarjetas = pg.inner_text("section[data-asig='A1']")
    ok("María Peña Núñez" in tarjetas, "descifra nombres con tildes y ñ")
    ok("Sin ubicación registrada" in tarjetas, "cliente sin georreferencia: 'Sin ubicación registrada'")
    ok(pg.locator("section[data-asig='A1'] .tipo.mora").count() >= 1 and pg.locator("section[data-asig='A1'] .tipo.rep").count() == 1,
       "etiquetas Mora / Reparacion")
    c01 = pg.locator("section[data-asig='A1'] li[data-cli='c01']")
    ok(c01.locator("a.waze").get_attribute("href") == "https://waze.com/ul?ll=14.8497,-85.8943&navigate=yes", "enlace a Waze correcto")
    ok("destination=14.8497,-85.8943" in c01.locator("a.maps").get_attribute("href"), "enlace a Google Maps correcto")
    ok(c01.locator("a.wa").get_attribute("href") == "https://wa.me/50499990000", "WhatsApp al contacto con prefijo 504")
    ok(c01.locator("a[href='tel:27850000']").count() == 1, "boton para llamar al telefono")
    ok(pg.locator("section[data-asig='A1'] li[data-cli='c02'] a.waze").count() == 0, "sin ubicacion: no muestra Waze/Maps")
    ok(pg.locator("section[data-asig='A1'] li[data-cli='c02'] a.wa").count() == 0, "solo linea fija (empieza con 2): no muestra WhatsApp")
    ok(pg.locator("section[data-asig='A1'] li[data-cli='c02'] a[href='tel:27851111']").count() == 1, "solo linea fija: si muestra Llamar")
    ok(pg.evaluate("window.__xss") is None and "<img" in pg.inner_text("section[data-asig='A1'] li[data-cli='c03'] h3"),
       "un nombre con codigo malicioso se muestra como texto y NO se ejecuta")
    ok("firma válida" in pg.inner_text("section[data-asig='A1'] li[data-cli='c04']") and "Cliente Alterado" not in tarjetas,
       "paquete alterado: rechazado por firma invalida (los demas siguen visibles)")
    reg = pg.evaluate("__HU_FAKE.S.registro.map(r => r.op)")
    ok(reg.index("bitacora") < reg.index("paquete"), "la consulta queda en bitacora ANTES de leer los paquetes")
    ok("Se cierra a las" in pg.inner_text("section[data-asig='A1'] .cierre"), "muestra la hora de cierre y el tiempo restante")
    ok(pg.locator("section[data-asig='A2']").count() == 1, "una segunda asignacion vigente tambien se muestra")
    if os.environ.get("DEPURAR"): print(pg.inner_text("#app")[:3000]); print(pg.evaluate("__HU_FAKE.S.registro.map(r=>r.op+':'+r.det).join(' | ')"))
    pg.screenshot(path=os.path.join(CAPTURAS, "1_visitas.png"), full_page=True)

    print("\n4. No encontrado")
    pg.click("section[data-asig='A1'] li[data-cli='c01'] [data-accion='no-encontrado']")
    pg.select_option("#m-motivo", "vivienda_cerrada"); pg.fill("#m-detalle", "Regresar después de las 2")
    pg.screenshot(path=os.path.join(CAPTURAS, "3_no_encontrado.png"))
    pg.click("#m-ok"); pg.wait_for_selector("text=Intento registrado.")
    ok("Intentos sin éxito: 1 (último: Vivienda cerrada)" in pg.inner_text("section[data-asig='A1'] li[data-cli='c01']"), "registra el intento con motivo")
    ok(pg.locator("section[data-asig='A1'] li[data-cli='c01'] a.waze").count() == 1, "la direccion SIGUE visible para reintentar")
    if os.environ.get("DEPURAR"): print(pg.inner_html("section[data-asig='A1'] li[data-cli='c01']")[:2000])
    r = pg.evaluate("__HU_FAKE.S.resultados.A1[0]")
    ok(r["motivo"] == "vivienda_cerrada" and r["detalle"] == "Regresar después de las 2", "el servidor guardo motivo y detalle")

    print("\n5. Cliente encontrado")
    pg.click("section[data-asig='A1'] li[data-cli='c02'] [data-accion='encontrado']")
    ok(pg.is_checked("#m-gps"), "pide confirmacion y ofrece registrar el GPS")
    pg.screenshot(path=os.path.join(CAPTURAS, "2_confirmar_encontrado.png"))
    pg.click("#m-ok"); pg.wait_for_selector("text=Cliente marcado como encontrado.")
    ok("dirección retirada" in pg.inner_text("section[data-asig='A1'] li[data-cli='c02']") and "María Peña" not in pg.inner_text("#app"),
       "la direccion DESAPARECE de inmediato")
    r = pg.evaluate("__HU_FAKE.S.resultados.A1.find(x => x.resultado === 'encontrado')")
    ok(r["cliente"] == "c02" and abs(r["lat"] - 14.8497) < 1e-6 and r["precision"] == 15, "el servidor guardo 'encontrado' con el GPS del tecnico")
    denegado = pg.evaluate("__HU_FAKE.leerPaquete('A1','c02').then(() => 'entregado', e => e.code)")
    ok(denegado == "permission-denied", "el servidor ya NO entrega ese paquete")

    print("\n6. Cierre automatico a la hora de fin")
    while int(time.time() * 1000) < A2["fin"] + 17_000:
        time.sleep(1)
    ok(pg.locator("section[data-asig='A2']").count() == 0 and "Cliente Corto Plazo" not in pg.inner_text("body"),
       "al llegar la hora de cierre, los datos desaparecen solos")

    print("\n7. Segundo plano mas de 5 minutos")
    pg.evaluate("""() => { const real = Date.now; window.__realNow = real; Date.now = () => real() + 6 * 60000;
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange')); window.__horaOculta = 0; }""")
    pg.evaluate("""() => { const real = window.__realNow; Date.now = () => real() + 12 * 60000;
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        document.dispatchEvent(new Event('visibilitychange')); }""")
    pg.wait_for_function("document.querySelectorAll(\"section[data-asig='A1'] li[data-cli]\").length === 4", timeout=20000)
    n_bit = pg.evaluate("__HU_FAKE.S.bitacora.filter(b => b.asignacionId === 'A1').length")
    ok(n_bit >= 2, "al volver, borra lo que habia en pantalla y lo vuelve a pedir (nueva entrada en bitacora: %d)" % n_bit)
    ok("dirección retirada" in pg.inner_text("section[data-asig='A1'] li[data-cli='c02']"), "al recargar desde el servidor, el cliente encontrado sigue retirado")
    pg.evaluate("() => { Date.now = window.__realNow; }")

    print("\n8. Extension de horario")
    import re
    ext = gen["asignaciones"]["A1"]["extensiones"]
    hora_de = lambda: re.search(r"a las (.+?) \(", pg.inner_text("section[data-asig='A1'] .cierre")).group(1)
    def aplicar(fin, numero, firma):
        antes = pg.evaluate("__HU_FAKE.S.bitacora.length")
        pg.evaluate("([f, n, s]) => __HU_FAKE.extender('A1', f, n, s)", [fin, numero, firma])
        pg.wait_for_function(f"__HU_FAKE.S.bitacora.length > {antes}", timeout=20000)
        pg.wait_for_selector("section[data-asig='A1'] .clientes", timeout=20000)
    inicial = hora_de()
    aplicar(ext["falsa"]["fin"], 1, ext["falsa"]["firma"])
    ok("no trae una firma válida" in pg.inner_text("section[data-asig='A1']") and hora_de() == inicial,
       "extension con firma FALSA: avisa y respeta el horario original (" + inicial + ")")
    aplicar(ext["valida"]["fin"] + 60000, 1, ext["valida"]["firma"])
    ok("no trae una firma válida" in pg.inner_text("section[data-asig='A1']") and hora_de() == inicial,
       "firma valida pero hora alterada en el servidor: rechazada")
    aplicar(ext["valida"]["fin"], 1, ext["valida"]["firma"])
    ok("no trae una firma" not in pg.inner_text("section[data-asig='A1']") and hora_de() != inicial and "extendida" in pg.inner_text("section[data-asig='A1'] .cierre"),
       "extension FIRMADA por el Divisor: acepta la nueva hora de cierre (" + hora_de() + ")")

    print("\n9. Revocacion")
    pg.evaluate("__HU_FAKE.revocar('A1')")
    pg.wait_for_selector("text=No tienes clientes autorizados en este momento", timeout=20000)
    ok("Cliente de Prueba Uno" not in pg.inner_text("body"), "al revocar, la lista desaparece al instante")
    ok("Próxima asignación" in pg.inner_text("#app"), "muestra la proxima asignacion programada")
    pg.screenshot(path=os.path.join(CAPTURAS, "4_sin_visitas.png"))

    print("\n10. Mi codigo y diagnostico del tecnico")
    pg.click("[data-pestana='codigo']"); pg.wait_for_selector("#qr svg")
    ok(True, "pestaña 'Mi código' con QR")
    pg.click("[data-pestana='diagnostico']"); pg.wait_for_selector(".diag")
    d = pg.inner_text(".diag")
    ok("Técnico" in d and "Sí, el código coincide" in d and "Configurada" in d, "diagnostico: rol tecnico, telefono registrado, llave del Divisor")
    pg.screenshot(path=os.path.join(CAPTURAS, "5_diagnostico.png"), full_page=True)
    pg.click("[data-pestana='visitas']")

    print("\n11. Tecnico desactivado")
    pg.evaluate("__HU_FAKE.desactivar('tecCata')")
    pg.wait_for_selector("text=Tu usuario fue desactivado", timeout=20000)
    ok(True, "desactivar al tecnico corta su acceso de inmediato")

    print("\n12. Cerrar sesion: no queda nada en el telefono")
    salir()
    almacen = pg.evaluate("""async () => ({ ls: localStorage.length, ss: sessionStorage.length,
        idb: (await indexedDB.databases()).map(d => d.name),
        claves: await new Promise(ok => { const r = indexedDB.open('hondutel-ubica', 1); r.onsuccess = () => {
          const g = r.result.transaction('llaves').objectStore('llaves').getAllKeys(); g.onsuccess = () => ok(g.result); }; }),
        caches: (await caches.keys()).length })""")
    ok(almacen["ls"] == 0 and almacen["ss"] == 0 and almacen["claves"] == ["tecnico"] and almacen["caches"] == 0,
       "no hay datos de clientes en el almacenamiento del navegador (solo la llave del telefono)")
    ok("Cliente" not in pg.inner_text("body"), "la pantalla ya no muestra clientes")

    print("\n13. Administrador en la app")
    entrar("admin@prueba.hn"); pg.wait_for_selector("text=Esta app muestra visitas solo a técnicos")
    ok(True, "un administrador entra y la app le indica que es para tecnicos")
    pg.click("[data-pestana='diagnostico']"); pg.wait_for_selector(".diag")
    ok("Administrador" in pg.inner_text(".diag") and "Reglas de seguridad de Hondutel Ubica" in pg.inner_text(".diag"),
       "diagnostico: 'Administrador' reconocido por el servidor")
    pg.click("[data-pestana='visitas']")
    salir()

    print("\n14. Telefono no registrado")
    entrar("otro@prueba.hn"); pg.wait_for_selector("text=Este teléfono no está registrado", timeout=20000)
    ok("Cliente Otro" not in pg.inner_text("body"), "si el codigo del telefono no coincide, no muestra clientes")
    salir()

    print("\n15. Sin llave del Divisor (estado actual hasta la fase 4)")
    pg.evaluate("globalThis.__HU_DIVISOR_KEY = ''")
    entrar("sindiv@prueba.hn"); pg.wait_for_selector("text=no tiene configurada la llave del Divisor", timeout=20000)
    ok("Cliente Sin Divisor" not in pg.inner_text("body"), "sin la llave del Divisor, la app no muestra clientes (falla cerrada)")
    salir()

    ok(not errores_consola, "sin errores en la consola del navegador" + ("" if not errores_consola else ": " + "; ".join(errores_consola[:3])))
    nav.close()
srv.shutdown()

fallos = [t for c, t in resultados if not c]
print(f"\nRESULTADO: {len(resultados) - len(fallos)} de {len(resultados)} pruebas correctas")
sys.exit(1 if fallos else 0)
