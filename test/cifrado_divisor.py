"""
HONDUTEL UBICA - Formato de cifrado (lado del Divisor, Python) - v2

Contrato que usaran el Divisor (fase 4) y la app del tecnico (fase 2):

  1. UN paquete por cliente, identificado solo por posicion: c01, c02, ... c20.
     Contenido en claro (JSON UTF-8):
       {"v":1,"asignacionId":...,"cliente":"c01",
        "tipo":"Mora"|"Reparacion","nombre":...,"telefono":...,"contacto":...,
        "lat":num|null,"lon":num|null}

  2. Cifrado hibrido:
     - llave AES-256 aleatoria, AES-GCM con IV de 12 bytes
     - la llave AES se cifra con RSA-OAEP (SHA-256) usando la llave PUBLICA del tecnico
     - cifrado = base64( JSON {"v":1,"k":b64,"iv":b64,"ct":b64} )

  3. Firma del paquete (RSA-PSS, SHA-256, sal 32 bytes) sobre:
       "HU1|<asignacionId>|<tecnicoUid>|<cliente>|<inicioMs>|<finOriginalMs>|<cifrado>"
     Amarra cada paquete a SU asignacion, SU tecnico, SU posicion y SU horario original.

  4. Firma de una extension de horario (solo la emite el admin desde el Divisor):
       "HU1-EXT|<asignacionId>|<tecnicoUid>|<inicioMs>|<nuevoFinMs>|<numeroExtension>"
     La app solo acepta una hora de cierre mayor a finOriginal si trae esta firma valida.

Uso para la prueba:  python3 cifrado_divisor.py <carpeta_de_trabajo>
"""
import base64, json, os, sys
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa, padding
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

b64 = lambda b: base64.b64encode(b).decode("ascii")
PSS = padding.PSS(mgf=padding.MGF1(hashes.SHA256()), salt_length=32)
OAEP = padding.OAEP(mgf=padding.MGF1(hashes.SHA256()), algorithm=hashes.SHA256(), label=None)


def texto_paquete(asig_id, tec_uid, cliente, inicio_ms, fin_original_ms, cifrado):
    return f"HU1|{asig_id}|{tec_uid}|{cliente}|{inicio_ms}|{fin_original_ms}|{cifrado}".encode("utf-8")


def texto_extension(asig_id, tec_uid, inicio_ms, nuevo_fin_ms, numero):
    return f"HU1-EXT|{asig_id}|{tec_uid}|{inicio_ms}|{nuevo_fin_ms}|{numero}".encode("utf-8")


def crear_paquete_cliente(datos_cliente, cliente, asig_id, tec_uid, inicio_ms, fin_original_ms,
                          llave_publica_tecnico, llave_privada_divisor):
    claro = json.dumps({"v": 1, "asignacionId": asig_id, "cliente": cliente, **datos_cliente},
                       ensure_ascii=False).encode("utf-8")
    llave_aes = AESGCM.generate_key(bit_length=256)
    iv = os.urandom(12)
    ct = AESGCM(llave_aes).encrypt(iv, claro, None)
    k = llave_publica_tecnico.encrypt(llave_aes, OAEP)
    cifrado = b64(json.dumps({"v": 1, "k": b64(k), "iv": b64(iv), "ct": b64(ct)}).encode("utf-8"))
    firma = llave_privada_divisor.sign(
        texto_paquete(asig_id, tec_uid, cliente, inicio_ms, fin_original_ms, cifrado), PSS, hashes.SHA256())
    return {"version": 1, "cifrado": cifrado, "firma": b64(firma)}


def crear_paquetes(clientes, asig_id, tec_uid, inicio_ms, fin_ms, pub_tecnico, priv_divisor):
    """Devuelve {"c01": paquete, "c02": paquete, ...} en el orden recibido."""
    if not 1 <= len(clientes) <= 20:
        raise ValueError("Una asignacion lleva de 1 a 20 clientes")
    return {f"c{i:02d}": crear_paquete_cliente(c, f"c{i:02d}", asig_id, tec_uid, inicio_ms, fin_ms,
                                               pub_tecnico, priv_divisor)
            for i, c in enumerate(clientes, start=1)}


def firmar_extension(asig_id, tec_uid, inicio_ms, nuevo_fin_ms, numero, priv_divisor):
    return b64(priv_divisor.sign(texto_extension(asig_id, tec_uid, inicio_ms, nuevo_fin_ms, numero),
                                 PSS, hashes.SHA256()))


if __name__ == "__main__":
    carpeta = sys.argv[1]
    # La llave del tecnico la genera SU TELEFONO (simulado por Node en la prueba).
    with open(os.path.join(carpeta, "tecnico_publica.spki.b64")) as f:
        pub_tec = serialization.load_der_public_key(base64.b64decode(f.read().strip()))

    # Llave de firma del Divisor (en produccion se reutiliza la RSA ya existente).
    priv_div = rsa.generate_private_key(public_exponent=65537, key_size=3072)
    with open(os.path.join(carpeta, "divisor_publica.spki.b64"), "w") as f:
        f.write(b64(priv_div.public_key().public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo)))

    clientes = [
        {"tipo": "Mora", "nombre": "Cliente de Prueba Uno", "telefono": "27850000",
         "contacto": "99990000", "lat": 14.8497, "lon": -85.8943},
        {"tipo": "Reparacion", "nombre": "Cliente de Prueba Dos (Niño Pérez)", "telefono": "27851111",
         "contacto": "", "lat": None, "lon": None},
        {"tipo": "Mora", "nombre": "Cliente de Prueba Tres", "telefono": "27852222",
         "contacto": "98887777", "lat": 14.6667, "lon": -86.2167},
    ]
    meta = {"asignacionId": "asig123", "tecnicoUid": "tecCata",
            "inicioMs": 1790000000000, "finOriginalMs": 1790028800000}
    paquetes = crear_paquetes(clientes, meta["asignacionId"], meta["tecnicoUid"],
                              meta["inicioMs"], meta["finOriginalMs"], pub_tec, priv_div)
    # Extension de 2 horas firmada por el admin (1.a extension)
    nuevo_fin = meta["finOriginalMs"] + 2 * 3600 * 1000
    extension = {"finMs": nuevo_fin, "numero": 1,
                 "firma": firmar_extension(meta["asignacionId"], meta["tecnicoUid"],
                                           meta["inicioMs"], nuevo_fin, 1, priv_div)}
    with open(os.path.join(carpeta, "paquetes.json"), "w", encoding="utf-8") as f:
        json.dump({"meta": meta, "paquetes": paquetes, "extension": extension, "esperado": clientes},
                  f, ensure_ascii=False)
    print(f"Python: {len(paquetes)} paquetes cifrados (uno por cliente) y 1 extension firmada")
