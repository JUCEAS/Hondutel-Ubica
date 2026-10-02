# Hondutel Ubica – Fase 2: App del técnico

App web instalable (PWA) para Android. El técnico ve **solo** sus clientes autorizados, **solo** en el horario del servidor, y nada queda guardado en el teléfono.

## Qué contiene

| Carpeta / archivo | Para qué |
| --- | --- |
| `dist/` | **La app lista para publicar** (GitHub Pages). Es lo único que se sube. |
| `src/` | Código fuente (configuración, cifrado, acceso a Firebase, pantallas). |
| `public/` | HTML, estilos, iconos, manifiesto y service worker. |
| `test/` | Prueba de punta a punta (47 casos) con servidor simulado y cifrado real del Divisor. |
| `capturas/` | Pantallas de la app tomadas durante la prueba. |
| `build.mjs` | Construye `dist/` (`node build.mjs`). |

## Pantallas

- **Iniciar sesión** + **código QR del teléfono** (el administrador lo registra una vez).
- **Mis visitas**: clientes del día con Waze, Google Maps, llamar y WhatsApp; hora de cierre y tiempo restante; botones **Cliente encontrado** (con GPS opcional) y **No encontrado** (con motivo).
- **Mi código**: QR, huella corta, copiar y compartir.
- **Diagnóstico**: confirma sesión, que el servidor reconoce el rol, que el teléfono está registrado y que la llave del Divisor está configurada.

## Seguridad aplicada en la app

- La llave privada del teléfono se crea **no exportable** y nunca sale del navegador.
- Los clientes se descifran **solo en memoria**; Firestore usa caché en memoria; el service worker solo guarda la "cáscara" de la app.
- Verifica la **firma del Divisor** en cada paquete y en cada extensión de horario.
- Se borra todo: a la hora de cierre, al revocar, al desactivar al técnico, al cerrar sesión y si la app pasa **más de 5 minutos** en segundo plano.
- Política de seguridad de contenido (CSP) estricta y textos escapados (un nombre con código malicioso se muestra como texto).
- **Falla cerrada**: sin la llave del Divisor (fase 4) o con un teléfono no registrado, no muestra clientes.

## Pendiente para usarla en campo

1. **Publicarla** en GitHub Pages (`dist/`).
2. **Fase 3–4 (Divisor)**: crear técnicos, registrar su QR, asignar visitas y poner la llave pública del Divisor en `src/config.js` (`DIVISOR_PUBLIC_KEY_B64`) y reconstruir.
3. Restringir la clave web de Firebase para que solo funcione desde la dirección publicada.

## Volver a probar

```
npm install
node build.mjs --prueba
python3 test/prueba_app.py
```
