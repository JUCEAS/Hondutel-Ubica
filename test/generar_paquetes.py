"""Genera, con el MISMO codigo del Divisor (cifrado_divisor.py), los paquetes
cifrados y firmados que usa la prueba de la app. Entrada y salida en JSON por stdin/stdout."""
import base64, json, sys
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cifrado_divisor import crear_paquetes, firmar_extension, b64

e = json.load(sys.stdin)
pub_tec = serialization.load_der_public_key(base64.b64decode(e["tecnicoPublica"]))
priv_div = rsa.generate_private_key(public_exponent=65537, key_size=3072)
otro_div = rsa.generate_private_key(public_exponent=65537, key_size=2048)   # falsificador
salida = {"divisorPublica": b64(priv_div.public_key().public_bytes(
    serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)), "asignaciones": {}}
for a in e["asignaciones"]:
    paq = crear_paquetes(a["clientes"], a["id"], a["tecnicoUid"], a["inicio"], a["fin"], pub_tec, priv_div)
    r = {"paquetes": paq, "extensiones": {}}
    for x in a.get("extensiones", []):
        llave = otro_div if x.get("falsa") else priv_div
        r["extensiones"][x["nombre"]] = {"fin": x["fin"], "numero": x["numero"],
            "firma": firmar_extension(a["id"], a["tecnicoUid"], a["inicio"], x["fin"], x["numero"], llave)}
    salida["asignaciones"][a["id"]] = r
json.dump(salida, sys.stdout, ensure_ascii=False)
