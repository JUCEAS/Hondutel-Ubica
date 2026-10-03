// =====================================================================
//  HONDUTEL UBICA - Configuracion de la app del tecnico
// =====================================================================

export const APP_VERSION = '3.0.0';

// Configuracion publica de Firebase (no es una contrasena; la seguridad esta en las reglas).
export const firebaseConfig = {
  apiKey: 'AIzaSyAYdMGqDYCVFrxq-LHuywQGfi_n83hn7Aw',
  authDomain: 'hondutel-ubica.firebaseapp.com',
  projectId: 'hondutel-ubica',
  storageBucket: 'hondutel-ubica.firebasestorage.app',
  messagingSenderId: '924694035355',
  appId: '1:924694035355:web:662b265592051aadd4bf3e',
};

// Llaves PUBLICAS de firma del Divisor de Municipios (SPKI en base64), una por
// computadora autorizada para asignar visitas. La app solo acepta paquetes
// firmados por alguna de ellas. Vacia = la app NO muestra clientes (falla cerrada).
export const DIVISOR_PUBLIC_KEYS = [];

// Tiempo que la ficha sigue visible despues de "Cliente encontrado" si el
// servidor no indica otro (config/general.graciaMinutos).
export const GRACIA_MINUTOS_POR_DEFECTO = 5;

// Si la app pasa este tiempo en segundo plano, borra los datos de la pantalla.
export const MINUTOS_OCULTA_PARA_BORRAR = 5;

// Codigo de pais para WhatsApp (Honduras).
export const PREFIJO_PAIS = '504';

export const MOTIVOS_NO_ENCONTRADO = [
  ['nadie_lo_conoce', 'Nadie lo conoce'],
  ['se_mudo', 'Se mudó'],
  ['se_fue_del_pais', 'Se fue del país'],
  ['fallecio', 'Falleció'],
  ['vivienda_cerrada', 'Vivienda cerrada'],
  ['direccion_incorrecta', 'Dirección incorrecta'],
  ['mas_tarde', 'Lo atenderé más tarde'],
  ['otro', 'Otro'],
];
