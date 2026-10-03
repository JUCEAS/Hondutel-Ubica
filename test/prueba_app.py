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
socketserver.TCPServer.allow_reuse_address = True
srv = socketserver.TCPServer(("127.0.0.1", 0), functools.partial(H, directory=DIST))
PUERTO = srv.server_address[1]
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

    # ---------- Paquetes reales del Divisor (ubica_cripto.py) ----------
    A1 = {"id": "A1", "area": "mora", "tecnicoUid": "tecCata", "inicio": ahora - H1, "fin": ahora + 2 * H1, "clientes": [
        {"tipo": "Mora", "nombre": "Cliente de Prueba Uno", "telefono": "27850000", "contacto": "99990000", "lat": 14.8497, "lon": -85.8943},
        {"tipo": "Mora", "nombre": "María Peña Núñez", "telefono": "27851111", "contacto": "", "lat": None, "lon": None},
        {"tipo": "Mora", "nombre": "<img src=x onerror=\"window.__xss=1\">Pedro", "telefono": "27852222", "contacto": "", "lat": 14.6, "lon": -86.2},
        {"tipo": "Mora", "nombre": "Cliente Alterado", "telefono": "27853333", "contacto": "", "lat": 14.7, "lon": -86.1}],
        "extensiones": [{"nombre": "valida", "fin": ahora + 3 * H1, "numero": 1},
                        {"nombre": "falsa", "fin": ahora + 3 * H1, "numero": 1, "falsa": True}]}
    A2 = {"id": "A2", "area": "reparacion", "tecnicoUid": "tecCata", "inicio": ahora - 10 * M, "fin": ahora + 75_000,
          "clientes": [{"tipo": "Reparacion", "nombre": "Cliente Corto Plazo", "telefono": "27854444", "contacto": "", "lat": 14.5, "lon": -86.0,
                        "tecnico": {"armario": "2101", "caja_terminal": "36", "par_primario": "155", "par_secundario": "449"}}]}
    A3 = {"id": "A3", "area": "mora", "tecnicoUid": "tecCata", "inicio": ahora + 20 * H1, "fin": ahora + 22 * H1,
          "clientes": [{"tipo": "Mora", "nombre": "Cliente Mañana", "telefono": "27855555", "contacto": "", "lat": 14.5, "lon": -86.0}]}
    A4 = {"id": "A4", "area": "mora", "tecnicoUid": "tecOtroTel", "inicio": ahora - H1, "fin": ahora + H1,
          "clientes": [{"tipo": "Mora", "nombre": "Cliente Otro", "telefono": "27856666", "contacto": "", "lat": 14.5, "lon": -86.0}]}
    A5 = {"id": "A5", "area": "mora", "tecnicoUid": "tecSinDiv", "inicio": ahora - H1, "fin": ahora + H1,
          "clientes": [{"tipo": "Mora", "nombre": "Cliente Sin Divisor", "telefono": "27857777", "contacto": "", "lat": 14.5, "lon": -86.0}]}
    entrada = {"tecnicoPublica": pub["pub"], "asignaciones": [A1, A2, A3, A4, A5]}
    gen = json.loads(subprocess.run([sys.executable, os.path.join(RAIZ, "test", "generar_paquetes.py")],
                                    input=json.dumps(entrada), capture_output=True, text=True, check=True,
                                    cwd=os.path.join(RAIZ, "test")).stdout)
    paq = {k: v["paquetes"] for k, v in gen["asignaciones"].items()}
    c = paq["A1"]["c04"]["cifrado"]
    paq["A1"]["c04"]["cifrado"] = c[:-8] + ("BBBBBBBB" if c.endswith("AAAAAAAA") else "AAAAAAAA")
    ok(all(len(v) == 32 for v in gen["asignaciones"]["A1"]["indice"].values()) and
       "27850000" not in json.dumps(gen["asignaciones"]["A1"]["indice"]),
       "el indice de busqueda no contiene los numeros (solo huellas)")

    def meta(a, n):
        g = gen["asignaciones"][a["id"]]
        return {"tecnicoUid": a["tecnicoUid"], "autorizadorUid": "autCata", "municipio": "Catacamas", "area": a["area"],
                "inicio": a["inicio"], "fin": a["fin"], "finOriginal": a["fin"], "extensiones": 0,
                "cantidadClientes": n, "revocada": False, "indice": g["indice"], "llaveBusqueda": g["llaveBusqueda"]}
    tec = lambda nombre, llave: {"nombre": nombre, "rol": "tecnico", "activo": True, "municipio": "Catacamas", "llavePublica": llave}
    pg.evaluate("([k, d]) => { globalThis.__HU_DIVISOR_KEY = [k]; __HU_FAKE.cargar(d); }", [gen["divisorPublica"], {
        "cuentas": {"tec@prueba.hn": {"clave": "clave-123", "uid": "tecCata"}, "admin@prueba.hn": {"clave": "clave-123", "uid": "adm"},
                    "otro@prueba.hn": {"clave": "clave-123", "uid": "tecOtroTel"}, "sindiv@prueba.hn": {"clave": "clave-123", "uid": "tecSinDiv"}},
        "usuarios": {"tecCata": tec("Técnico Catacamas", pub["pub"]), "adm": {"nombre": "Julio César", "rol": "admin", "activo": True},
                     "tecOtroTel": tec("Técnico Otro Teléfono", "MIIBOTRALLAVE"), "tecSinDiv": tec("Técnico Sin Divisor", pub["pub"])},
        "asignaciones": {"A1": meta(A1, 4), "A2": meta(A2, 1), "A3": meta(A3, 1), "A4": meta(A4, 1), "A5": meta(A5, 1)},
        "paquetes": paq,
        "config": {"graciaMinutos": 5, "jornadas": {}, "maxDias": 7},
    }])
    def entrar(correo, clave="clave-123"):
        pg.fill("#l-correo", correo); pg.fill("#l-clave", clave); pg.click("#f-login button")
    def salir():
        pg.click("#salir"); pg.wait_for_selector("text=Iniciar sesión")
    def buscar(numero, esperar=None):
        pg.fill("#b-tel", numero); pg.click("#f-buscar button")
        if esperar:
            pg.wait_for_selector(f"text={esperar}", timeout=20000)
    def esperar(cond, timeout=20):
        fin = time.time() + timeout
        while time.time() < fin:
            if cond():
                return True
            time.sleep(0.3)
        raise AssertionError("tiempo agotado esperando una condicion")
    def registro():
        return pg.evaluate("__HU_FAKE.S.registro.map(r => r.op + ':' + r.det)")
    sec = lambda a: pg.inner_text(f"section[data-asig='{a}']")

    print("\n2. Inicio de sesion")
    entrar("tec@prueba.hn", "mala")
    pg.wait_for_selector("text=Correo o contraseña incorrectos.")
    ok(True, "contraseña incorrecta: muestra 'Correo o contraseña incorrectos.'")
    entrar("tec@prueba.hn")
    pg.wait_for_selector("section[data-asig='A1'] .conteo", timeout=20000)
    ok(True, "el tecnico entra y ve el resumen de sus visitas")
    ok("Técnico Catacamas · Catacamas" in pg.inner_text("#quien"), "la barra muestra su nombre y municipio")

    print("\n3. Resumen sin datos de clientes")
    ok("4 cliente(s) · 0 encontrado(s) · 4 pendiente(s)" in sec("A1") and "Cobranza (Mora)" in sec("A1"),
       "muestra cuantos clientes tiene, cuantos encontrados y pendientes, y el area")
    ok(not any(x in pg.inner_text("#app") for x in ("Cliente de Prueba Uno", "María", "Pedro")), "NO muestra ningun nombre antes de buscar")
    ok(not any(r.startswith("paquete:") for r in registro()), "no se descargo ningun paquete de cliente")
    ok(pg.locator("#b-tel").count() == 1, "muestra el buscador por numero telefonico")
    pg.screenshot(path=os.path.join(CAPTURAS, "1_resumen_buscador.png"), full_page=True)

    print("\n4. Buscar un cliente")
    buscar("123", "Escribe un número de 8 dígitos")
    ok(True, "un numero incompleto se rechaza con un aviso")
    buscar("2785-9999", "no está entre tus clientes autorizados")
    ok(not any(r.startswith("abrir") for r in registro()), "un numero que no esta asignado no abre nada en el servidor")
    buscar("2785-0000", "Cliente de Prueba Uno")
    r = registro()
    ok(r.index("abrir:A1/c01") < r.index("paquete:A1/c01"), "la apertura queda registrada en el servidor ANTES de leer el paquete")
    ok(pg.evaluate("__HU_FAKE.S.bitacora.some(b => b.tipo === 'apertura' && b.cliente === 'c01')"), "la bitacora guarda que se abrio el cliente c01")
    ok(sum(1 for x in r if x.startswith("paquete:")) == 1, "solo se descargo ESE cliente")
    ficha = pg.locator("section[data-asig='A1'] .cliente.abierto")
    ok(ficha.locator("a.waze").get_attribute("href") == "https://waze.com/ul?ll=14.8497,-85.8943&navigate=yes", "enlace a Waze correcto")
    ok("destination=14.8497,-85.8943" in ficha.locator("a.maps").get_attribute("href"), "enlace a Google Maps correcto")
    ok(ficha.locator("a.otra").count() == 1 and ficha.locator("a.apple").count() == 0, "Android: 'Otra app de mapas' (sin Apple Maps)")
    ok(ficha.locator("a.wa").get_attribute("href") == "https://wa.me/50499990000", "WhatsApp al contacto con prefijo 504")
    ok(ficha.locator("a[href='tel:27850000']").count() == 1, "boton para llamar al telefono")
    pg.screenshot(path=os.path.join(CAPTURAS, "2_cliente_abierto.png"), full_page=True)

    print("\n5. Uno a la vez")
    ok(pg.locator("#b-tel").is_disabled(), "con un cliente abierto, el buscador se bloquea")
    neg = pg.evaluate("__HU_FAKE.abrirDirecto('A1','c02').then(() => 'abierto', e => e.code)")
    ok(neg == "permission-denied", "el servidor NO deja abrir otro cliente mientras hay uno abierto")
    neg = pg.evaluate("__HU_FAKE.leerPaquete('A1','c02').then(() => 'entregado', e => e.code)")
    ok(neg == "permission-denied", "el servidor NO entrega el paquete de un cliente que no esta abierto")

    print("\n6. No encontrado libera al tecnico")
    pg.click("section[data-asig='A1'] [data-accion='no-encontrado']")
    pg.select_option("#m-motivo", "vivienda_cerrada"); pg.fill("#m-detalle", "Regresar después de las 2")
    pg.click("#m-ok"); pg.wait_for_selector("text=Intento registrado.")
    ok("Cliente de Prueba Uno" not in pg.inner_text("#app") and not pg.locator("#b-tel").is_disabled(),
       "la ficha se cierra y el buscador vuelve a quedar libre")
    r = pg.evaluate("__HU_FAKE.S.resultados.A1[0]")
    ok(r["motivo"] == "vivienda_cerrada" and r["detalle"] == "Regresar después de las 2", "el servidor guardo motivo y detalle")
    buscar("27850000", "Intentos sin éxito hoy: 1")
    ok("Vivienda cerrada" in sec("A1"), "al volver a buscarlo, muestra el intento anterior")

    print("\n7. Cliente encontrado con confirmacion y 5 minutos de gracia")
    pg.click("section[data-asig='A1'] [data-accion='encontrado']")
    modal = pg.inner_text("#modal-caja")
    ok("Cliente de Prueba Uno" in modal and "27850000" in modal and "5 minuto" in modal,
       "pide confirmar con el nombre y el numero, y avisa los 5 minutos")
    ok(pg.is_checked("#m-gps"), "ofrece registrar el GPS")
    pg.screenshot(path=os.path.join(CAPTURAS, "3_confirmar_encontrado.png"))
    pg.click("[data-accion='cerrar-modal']")
    ok(pg.evaluate("(__HU_FAKE.S.resultados.A1 || []).filter(x => x.resultado === 'encontrado').length") == 0,
       "si responde 'No, volver', no se registra nada")
    pg.click("section[data-asig='A1'] [data-accion='encontrado']"); pg.click("#m-ok")
    pg.wait_for_selector("text=Esta ficha se borrará en")
    ok("Cliente de Prueba Uno" in sec("A1") and pg.locator("section[data-asig='A1'] [data-accion='encontrado']").count() == 0,
       "la ficha sigue visible (para llamar) pero ya sin botones de resultado")
    ok("1 encontrado(s) · 3 pendiente(s)" in sec("A1"), "el resumen se actualiza")
    r = pg.evaluate("__HU_FAKE.S.resultados.A1.find(x => x.resultado === 'encontrado')")
    ok(r["cliente"] == "c01" and abs(r["lat"] - 14.8497) < 1e-6 and r["precision"] == 15, "el servidor guardo 'encontrado' con el GPS")
    neg = pg.evaluate("__HU_FAKE.leerPaquete('A1','c01').then(() => 'entregado', e => e.code)")
    ok(neg == "permission-denied", "el servidor ya NO entrega ese paquete (aunque la ficha siga en pantalla)")
    ok(not pg.locator("#b-tel").is_disabled(), "durante la gracia ya se puede buscar el siguiente")
    pg.screenshot(path=os.path.join(CAPTURAS, "4_gracia.png"), full_page=True)
    pg.evaluate("() => { const real = Date.now; window.__realNow = real; Date.now = () => real() + 5 * 60000 + 2000; }")
    esperar(lambda: "Cliente de Prueba Uno" not in pg.inner_text("body"), 10)
    ok(True, "a los 5 minutos la ficha se borra sola")
    pg.evaluate("() => { Date.now = window.__realNow; }")
    buscar("27850000", "ya fue marcado como encontrado")
    ok(True, "buscar de nuevo un cliente encontrado: avisa y no lo abre")

    print("\n8. Otros clientes")
    buscar("27851111", "María Peña Núñez")
    f = pg.locator("section[data-asig='A1'] .cliente.abierto")
    ok("Sin ubicación registrada" in f.inner_text() and f.locator("a.waze").count() == 0, "sin georreferencia: 'Sin ubicación registrada'")
    ok(f.locator("a.wa").count() == 0 and f.locator("a[href='tel:27851111']").count() == 1, "linea fija: Llamar si, WhatsApp no")
    pg.click("section[data-asig='A1'] [data-accion='no-encontrado']"); pg.select_option("#m-motivo", "mas_tarde")
    pg.click("#m-ok"); pg.wait_for_selector("text=Intento registrado.")
    ok(pg.evaluate("__HU_FAKE.S.resultados.A1.at(-1).motivo") == "mas_tarde", "motivo 'Lo atenderé más tarde'")
    buscar("27852222", "Pedro")
    ok(pg.evaluate("window.__xss") is None and "<img" in pg.inner_text("section[data-asig='A1'] .cliente h3"),
       "un nombre con codigo malicioso se muestra como texto y NO se ejecuta")
    pg.click("section[data-asig='A1'] [data-accion='no-encontrado']"); pg.click("#m-ok"); pg.wait_for_selector("text=Intento registrado.")
    buscar("27853333", "no tiene una firma válida")
    ok("Cliente Alterado" not in pg.inner_text("#app") and pg.locator("text=Cerrar este cliente").count() == 1,
       "paquete alterado: rechazado, y ofrece cerrarlo para poder seguir")
    pg.click("text=Cerrar este cliente"); pg.click("#m-ok"); pg.wait_for_selector("text=Intento registrado.")
    ok(not pg.locator("#b-tel").is_disabled(), "despues de cerrarlo, el tecnico puede seguir buscando")
    buscar("27854444", "Cliente Corto Plazo")
    ok("Armario" in sec("A2") and "2101" in sec("A2") and "Reparación" in sec("A2"),
       "un cliente del area tecnica muestra armario y caja terminal")

    pg.click("section[data-asig='A2'] [data-accion='no-encontrado']"); pg.click("#m-ok"); pg.wait_for_selector("text=Intento registrado.")

    print("\n9. Recuperar el cliente abierto al volver a abrir la app")
    buscar("27851111", "María Peña Núñez")
    pg.evaluate("""() => { const real = window.__realNow || Date.now; window.__realNow = real; Date.now = () => real() + 6 * 60000;
        Object.defineProperty(document, 'hidden', { value: true, configurable: true });
        document.dispatchEvent(new Event('visibilitychange')); }""")
    pg.evaluate("""() => { const real = window.__realNow; Date.now = () => real() + 12 * 60000;
        Object.defineProperty(document, 'hidden', { value: false, configurable: true });
        document.dispatchEvent(new Event('visibilitychange')); }""")
    esperar(lambda: "María Peña Núñez" in pg.inner_text("body"), 20)
    ok(pg.evaluate("__HU_FAKE.S.bitacora.filter(b => b.asignacionId === 'A1' && !b.tipo).length") >= 2,
       "tras 5 minutos en segundo plano borra la pantalla y lo vuelve a pedir; el cliente abierto se retoma solo")
    pg.evaluate("() => { Date.now = window.__realNow; }")
    pg.click("section[data-asig='A1'] [data-accion='no-encontrado']"); pg.click("#m-ok"); pg.wait_for_selector("text=Intento registrado.")

    print("\n10. Cierre automatico a la hora de fin")
    while int(time.time() * 1000) < A2["fin"] + 17_000:
        time.sleep(1)
    ok(pg.locator("section[data-asig='A2']").count() == 0 and "Cliente Corto Plazo" not in pg.inner_text("body"),
       "al llegar la hora de cierre, los datos desaparecen solos")

    print("\n11. Extension de horario")
    import re
    ext = gen["asignaciones"]["A1"]["extensiones"]
    hora_de = lambda: re.search(r"a las (.+?) \(", pg.inner_text("section[data-asig='A1'] .cierre")).group(1)
    def aplicar(fin, numero, firma):
        antes = pg.evaluate("__HU_FAKE.S.bitacora.length")
        pg.evaluate("([f, n, s]) => __HU_FAKE.extender('A1', f, n, s)", [fin, numero, firma])
        esperar(lambda: pg.evaluate("__HU_FAKE.S.bitacora.length") > antes, 20)
        pg.wait_for_selector("section[data-asig='A1'] .conteo", timeout=20000)
    inicial = hora_de()
    aplicar(ext["falsa"]["fin"], 1, ext["falsa"]["firma"])
    ok("no trae una firma válida" in sec("A1") and hora_de() == inicial,
       "extension con firma FALSA: avisa y respeta el horario original (" + inicial + ")")
    aplicar(ext["valida"]["fin"] + 60000, 1, ext["valida"]["firma"])
    ok("no trae una firma válida" in sec("A1") and hora_de() == inicial, "firma valida pero hora alterada en el servidor: rechazada")
    aplicar(ext["valida"]["fin"], 1, ext["valida"]["firma"])
    ok("no trae una firma" not in sec("A1") and hora_de() != inicial and "extendida" in pg.inner_text("section[data-asig='A1'] .cierre"),
       "extension FIRMADA por el Divisor: acepta la nueva hora de cierre (" + hora_de() + ")")

    print("\n12. Revocacion")
    buscar("27851111", "María Peña Núñez")
    pg.evaluate("__HU_FAKE.revocar('A1')")
    pg.wait_for_selector("text=No tienes clientes autorizados en este momento", timeout=20000)
    ok("María" not in pg.inner_text("body"), "al revocar, la ficha abierta desaparece al instante")
    ok("Próxima asignación" in pg.inner_text("#app") and "1 cliente(s)" in pg.inner_text("#app"),
       "muestra la proxima asignacion programada (sin datos de clientes)")
    pg.screenshot(path=os.path.join(CAPTURAS, "5_sin_visitas.png"))

    print("\n13. Mi codigo y diagnostico del tecnico")
    pg.click("[data-pestana='codigo']"); pg.wait_for_selector("#qr svg")
    ok(True, "pestaña 'Mi código' con QR")
    pg.click("[data-pestana='diagnostico']"); pg.wait_for_selector(".diag")
    d = pg.inner_text(".diag")
    ok("Técnico" in d and "Sí, el código coincide" in d and "Configurada (1)" in d and "3.0.0" in d,
       "diagnostico: rol tecnico, telefono registrado, llave del Divisor, version 3.0.0")
    pg.screenshot(path=os.path.join(CAPTURAS, "6_diagnostico.png"), full_page=True)
    pg.click("[data-pestana='visitas']")

    print("\n14. Tecnico desactivado")
    pg.evaluate("__HU_FAKE.desactivar('tecCata')")
    pg.wait_for_selector("text=Tu usuario fue desactivado", timeout=20000)
    ok(True, "desactivar al tecnico corta su acceso de inmediato")

    print("\n15. Cerrar sesion: no queda nada en el telefono")
    salir()
    almacen = pg.evaluate("""async () => ({ ls: localStorage.length, ss: sessionStorage.length,
        claves: await new Promise(ok => { const r = indexedDB.open('hondutel-ubica', 1); r.onsuccess = () => {
          const g = r.result.transaction('llaves').objectStore('llaves').getAllKeys(); g.onsuccess = () => ok(g.result); }; }),
        caches: (await caches.keys()).length })""")
    ok(almacen["ls"] == 0 and almacen["ss"] == 0 and almacen["claves"] == ["tecnico"] and almacen["caches"] == 0,
       "no hay datos de clientes en el almacenamiento del navegador (solo la llave del telefono)")
    ok("Cliente" not in pg.inner_text("body"), "la pantalla ya no muestra clientes")

    print("\n16. Administrador en la app")
    entrar("admin@prueba.hn"); pg.wait_for_selector("text=Esta app muestra visitas solo a técnicos")
    ok(True, "un administrador entra y la app le indica que es para tecnicos")
    salir()

    print("\n17. Telefono no registrado")
    entrar("otro@prueba.hn"); pg.wait_for_selector("text=Este teléfono no está registrado", timeout=20000)
    ok("Cliente Otro" not in pg.inner_text("body"), "si el codigo del telefono no coincide, no muestra nada")
    salir()

    print("\n18. Sin llave del Divisor")
    pg.evaluate("globalThis.__HU_DIVISOR_KEY = []")
    entrar("sindiv@prueba.hn"); pg.wait_for_selector("text=no tiene configurada la llave del Divisor", timeout=20000)
    ok("Cliente Sin Divisor" not in pg.inner_text("body"), "sin la llave del Divisor, la app no muestra clientes (falla cerrada)")
    salir()

    ok(not errores_consola, "sin errores en la consola del navegador" + ("" if not errores_consola else ": " + "; ".join(errores_consola[:3])))
    nav.close()
srv.shutdown()

fallos = [t for c, t in resultados if not c]
print(f"\nRESULTADO: {len(resultados) - len(fallos)} de {len(resultados)} pruebas correctas")
sys.exit(1 if fallos else 0)
