"""Genera, con el MISMO codigo del Divisor (ubica_cripto.py de la v48), los
paquetes cifrados y firmados, el indice ciego y las extensiones que usa la
prueba de la app. Entrada y salida en JSON por stdin/stdout."""
import json, os, sys
sys.path.insert(0, os.environ.get("DIVISOR_DIR", os.path.join(os.path.dirname(__file__), "..", "..", "divisor_v48")))
import ubica_cripto as uc

e = json.load(sys.stdin)
priv_div = uc.nueva_llave_firma()
otro_div = uc.nueva_llave_firma()   # falsificador
salida = {"divisorPublica": uc.publica_b64(priv_div), "asignaciones": {}}
for a in e["asignaciones"]:
    extra, paq = uc.armar_asignacion(a["clientes"], a["id"], a["tecnicoUid"], e["tecnicoPublica"],
                                     a["inicio"], a["fin"], a.get("area", "mora"), priv_div)
    r = {"paquetes": paq, "indice": extra["indice"], "llaveBusqueda": extra["llaveBusqueda"], "extensiones": {}}
    for x in a.get("extensiones", []):
        llave = otro_div if x.get("falsa") else priv_div
        r["extensiones"][x["nombre"]] = {"fin": x["fin"], "numero": x["numero"],
            "firma": uc.firmar_extension(a["id"], a["tecnicoUid"], a["inicio"], x["fin"], x["numero"], llave)}
    salida["asignaciones"][a["id"]] = r
json.dump(salida, sys.stdout, ensure_ascii=False)
