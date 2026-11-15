"use strict";
/*
 * Administracion diaria de Cursedon desde el celular: reemplaza a PaseAdminWindow sin Unity.
 *
 * No hay ningun secreto aca: el ID del proyecto es publico y el permiso lo decide el servidor
 * (Moderacion.js, Pase.js y Buzon.js solo atienden a los Player ID de "buzon_admins"). La contraseña no
 * se guarda, y los tokens viven en sessionStorage: se van al cerrar la pestaña o al salir.
 *
 * Todo lo que viene del servidor o de un jugador se pinta como texto (ver el()), nunca como
 * HTML: una denuncia armada a proposito no puede correr codigo con el token del administrador.
 */

const PROYECTO = "f007246c-d0d4-42f3-8668-11a06f996478";
const ENTORNO = "production";
const AUTH = "https://player-auth.services.api.unity.com";
const CLOUD = "https://cloud-code.services.api.unity.com";
const MODERACION = "Moderacion";
const PASE = "Pase";
const BUZON = "Buzon";
const PERFILES = "Perfiles";

const CLAVE_SESION = "cursedon_admin_sesion";
// Igual que CloudCall.cs: cuanto esperar a una respuesta y entre repeticiones.
const TOPE_MS = 25000;
const ESPERAS_MS = [1000, 3000];
const ESPERA_LIMITE_MS = 5000;
// Cloud Save devuelve de a 20 y los scripts no piden la pagina siguiente.
const PAGINA = 20;
// Un script tiene 15 s de tope y escribe los codigos de a uno: los lotes grandes van en partes.
const CODIGOS_POR_PEDIDO = 50;
const CODIGOS_MAX = 500;
// Despues de pintar una foto, un momento sin botones: un doble toque no decide la siguiente.
const GUARDA_MS = 350;
const MOTIVO_POR_DEFECTO = "Contenido no permitido";
const MOTIVOS = [MOTIVO_POR_DEFECTO, "Contenido sexual", "Violencia u odio", "Datos personales"];
const VETO_DIAS = [7, 30, 90, 365];

const MENSAJES = {
  sin_conexion: "Sin respuesta del servidor. Si era una decisión, puede haberse aplicado: actualizá antes de repetirla.",
  sin_sesion: "La sesión venció. Entrá de nuevo.",
  limite: "Demasiados pedidos seguidos. Esperá unos segundos y probá de nuevo.",
  caido: "El servidor no responde ahora. Probá de nuevo en un rato.",
  script_error: "El script falló en el servidor. Probá de nuevo.",
  servidor: "El script falló en el servidor. Probá de nuevo.",
  sin_script: "Ese script no está publicado en Cloud Code.",
  accion_invalida: "El script publicado no reconoce esta acción: puede estar desactualizado o sin parámetros.",
  no_autorizado: "Esta cuenta no está en buzon_admins.",
  sin_pendiente: "Ese jugador ya no tiene una foto pendiente.",
  cantidad_invalida: "La cantidad tiene que ser de 1 a 500.",
  tipo_invalido: "El tipo de recompensa no es válido.",
  recompensa_invalida: "Falta el id del cosmético, o es demasiado largo.",
  codigo_invalido: "Ese código no existe o no tiene un formato válido.",
  no_existe: "No hay ningún jugador con ese nombre o Player ID.",
  es_admin: "Esa cuenta es de administrador: no se puede vetar.",
  cuenta_error: "Unity no pudo reactivar la cuenta, así que sigue vetado. Probá de nuevo más tarde.",
  no_admin: "Esta cuenta no está en buzon_admins.",
  sin_titulo: "Falta el título.",
  muchos_objetos: "Como mucho 10 objetos por carta.",
  rareza_invalida: "Hay una rareza que no existe.",
  buzon_lleno: "El buzón de ese jugador está lleno: tiene 50 cartas sin recibir.",
};

const $ = (id) => document.getElementById(id);

/** Crea un elemento. Los hijos de texto siempre quedan como texto, nunca como HTML. */
function el(etiqueta, atributos, ...hijos) {
  const nodo = document.createElement(etiqueta);
  for (const [clave, valor] of Object.entries(atributos || {})) {
    if (valor === undefined || valor === null || valor === false) continue;
    if (clave.startsWith("on")) nodo.addEventListener(clave.substring(2), valor);
    else if (clave === "value") nodo.value = valor;
    else if (valor === true) nodo.setAttribute(clave, "");
    else nodo.setAttribute(clave, valor);
  }
  nodo.append(...hijos.filter((h) => h !== undefined && h !== null));
  return nodo;
}

const dormir = (ms) => new Promise((resolver) => setTimeout(resolver, ms));

class Fallo extends Error {
  constructor(codigo, detalle) {
    super(codigo);
    this.codigo = codigo;
    this.detalle = detalle;
  }
}

const mensajeDe = (fallo) => MENSAJES[fallo.codigo] || "El servidor contestó: " + fallo.codigo;

// ---------------------------------------------------------------- avisos

let relojAviso = 0;
function avisar(texto, tono) {
  const aviso = $("aviso");
  aviso.textContent = texto;
  aviso.className = "aviso " + (tono || "");
  aviso.hidden = false;
  clearTimeout(relojAviso);
  relojAviso = setTimeout(() => { aviso.hidden = true; }, tono === "mal" ? 6000 : 2200);
}

// Moderacion y Pase dicen no_autorizado; Buzon, no_admin. Las dos llevan a la misma pantalla.
const sinPermiso = (codigo) => codigo === "no_autorizado" || codigo === "no_admin";

const avisarFallo = (fallo) => {
  // Esas ya cambiaron de pantalla, y la pantalla lo explica mejor.
  if (!sinPermiso(fallo.codigo) && fallo.codigo !== "sin_sesion") avisar(mensajeDe(fallo), "mal");
};

async function copiar(texto, aviso) {
  let ok = false;
  try {
    await navigator.clipboard.writeText(texto);
    ok = true;
  } catch (err) {
    const campo = el("textarea", { readonly: true }, texto);
    document.body.append(campo);
    campo.select();
    try { ok = document.execCommand("copy"); } catch (err2) { ok = false; }
    campo.remove();
  }
  avisar(ok ? aviso : "No se pudo copiar: seleccioná el texto a mano.", ok ? "bien" : "mal");
  return ok;
}

const corto = (id) => String(id || "").substring(0, 8) + "…";

// ---------------------------------------------------------------- red

/** Un pedido con tope de tiempo, incluida la lectura de la respuesta. */
async function pedirJson(url, opciones) {
  const control = new AbortController();
  const reloj = setTimeout(() => control.abort(), TOPE_MS);
  try {
    const res = await fetch(url, { ...opciones, signal: control.signal, credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer" });
    let json = null;
    try { json = await res.json(); } catch (err) { json = null; }
    return { status: res.status, ok: res.ok, json };
  } finally {
    clearTimeout(reloj);
  }
}

async function pedirAuth(ruta, cuerpo) {
  let r;
  try {
    r = await pedirJson(AUTH + ruta, {
      method: "POST",
      headers: { "Content-Type": "application/json", ProjectId: PROYECTO, UnityEnvironment: ENTORNO },
      body: JSON.stringify(cuerpo),
    });
  } catch (err) {
    throw new Fallo("sin_conexion");
  }
  if (r.ok && r.json && r.json.idToken) return r.json;
  throw new Fallo("auth", { status: r.status, title: (r.json && r.json.title) || "", detail: (r.json && r.json.detail) || "" });
}

// ---------------------------------------------------------------- sesion

const sesion = { id: "", token: "", renovar: "" };

function recordarSesion(respuesta) {
  sesion.id = respuesta.userId || (respuesta.user && respuesta.user.id) || sesion.id;
  sesion.token = respuesta.idToken;
  // Siempre el ultimo: el servidor entrega uno nuevo en cada renovacion.
  sesion.renovar = respuesta.sessionToken || sesion.renovar;
  try { sessionStorage.setItem(CLAVE_SESION, JSON.stringify(sesion)); } catch (err) { /* queda en memoria */ }
}

function restaurarSesion() {
  try {
    const guardada = JSON.parse(sessionStorage.getItem(CLAVE_SESION) || "null");
    if (guardada && guardada.token) Object.assign(sesion, guardada);
  } catch (err) { /* se entra de nuevo */ }
  return !!sesion.token;
}

function olvidarSesion() {
  sesion.id = sesion.token = sesion.renovar = "";
  try { sessionStorage.removeItem(CLAVE_SESION); } catch (err) { /* nada que borrar */ }
}

let renovando = null;
function renovarSesion() {
  if (!renovando) {
    renovando = pedirAuth("/v1/authentication/session-token", { sessionToken: sesion.renovar })
      .then(recordarSesion)
      .finally(() => { renovando = null; });
  }
  return renovando;
}

/** Sin red se conserva la sesion. Con el token rechazado, hay que volver a entrar. */
async function renovarOSalir() {
  try {
    await renovarSesion();
  } catch (fallo) {
    if (fallo.codigo === "sin_conexion") throw fallo;
    cerrarSesion("La sesión venció. Entrá de nuevo.");
    throw new Fallo("sin_sesion");
  }
}

/**
 * Una accion de un script. Hace lo mismo que CloudCall.cs: con 401 renueva y repite (el script no
 * corrio), con 429 espera y repite (tampoco), y con red o servidor caidos repite solo si la accion
 * se puede repetir sin efecto doble.
 */
async function llamar(script, accion, datos, repetible) {
  const params = { accion };
  if (datos) params.datos = JSON.stringify(datos);
  let reintentos = 0;
  let renovada = false;
  for (;;) {
    let codigo = null;
    let espera = -1;
    let r = null;
    try {
      r = await pedirJson(CLOUD + "/v1/projects/" + PROYECTO + "/scripts/" + script, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + sesion.token },
        body: JSON.stringify({ params }),
      });
    } catch (err) {
      codigo = "sin_conexion";
    }
    if (r) {
      if (r.ok) {
        const salida = r.json && r.json.output;
        if (!salida) throw new Fallo("caido");
        if (salida.ok === false) {
          if (sinPermiso(salida.error)) mostrarSinPermiso();
          throw new Fallo(salida.error || "servidor");
        }
        return salida;
      }
      switch (r.status) {
        case 401:
          if (renovada) {
            cerrarSesion("La sesión venció. Entrá de nuevo.");
            throw new Fallo("sin_sesion");
          }
          renovada = true;
          await renovarOSalir();
          continue;
        case 400: throw new Fallo("accion_invalida");
        case 404: throw new Fallo("sin_script");
        case 422: codigo = "script_error"; break;
        case 429: codigo = "limite"; espera = ESPERA_LIMITE_MS; break;
        default: codigo = "caido";
      }
    }
    if (reintentos >= ESPERAS_MS.length) throw new Fallo(codigo);
    if (espera >= 0) {
      reintentos++;
      await dormir(espera);
      continue;
    }
    if (!repetible) throw new Fallo(codigo);
    await dormir(ESPERAS_MS[reintentos++]);
  }
}

// ---------------------------------------------------------------- entrar

let creandoCuenta = false;

function mostrarSolo(pantalla) {
  for (const id of ["entrar", "sin-permiso", "app"]) $(id).hidden = id !== pantalla;
}

function mostrarEntrar(mensaje) {
  mostrarSolo("entrar");
  $("clave").value = "";
  $("clave").type = "password";
  $("ver-clave").textContent = "Ver";
  const error = $("error-entrar");
  error.textContent = mensaje || "";
  error.hidden = !mensaje;
}

function mostrarSinPermiso() {
  $("sp-id").textContent = sesion.id;
  mostrarSolo("sin-permiso");
}

function cambiarModo() {
  creandoCuenta = !creandoCuenta;
  $("entrar-titulo").textContent = creandoCuenta ? "Crear cuenta" : "Cursedon Admin";
  $("btn-entrar").textContent = creandoCuenta ? "Crear cuenta" : "Entrar";
  $("cambiar-modo").textContent = creandoCuenta ? "Ya tengo cuenta: entrar" : "Primera vez: crear la cuenta de administrador";
  $("reglas-cuenta").hidden = !creandoCuenta;
  $("clave").autocomplete = creandoCuenta ? "new-password" : "current-password";
  $("error-entrar").hidden = true;
}

function mensajeEntrar(fallo) {
  if (fallo.codigo !== "auth") return mensajeDe(fallo);
  const { status, title, detail } = fallo.detalle;
  const crudo = [title, detail].filter(Boolean).join(": ") || "HTTP " + status;
  const todo = title + " " + detail;
  let texto;
  if (/ENTITY_EXISTS/i.test(todo)) texto = "Ese usuario ya existe.";
  else if (/BANNED/i.test(todo)) texto = "Esta cuenta está suspendida.";
  else if (status === 429) texto = "Demasiados intentos. Esperá un rato.";
  else if (status === 401 || status === 403 || /WRONG_USERNAME_PASSWORD|PERMISSION_DENIED/i.test(todo)) texto = "Usuario o contraseña incorrectos.";
  else texto = creandoCuenta ? "No se pudo crear la cuenta." : "No se pudo entrar.";
  return texto + " (" + crudo + ")";
}

async function enviarEntrar(evento) {
  evento.preventDefault();
  const username = $("usuario").value.trim();
  const password = $("clave").value;
  if (!username || !password) {
    mostrarEntrar("Completá el usuario y la contraseña.");
    return;
  }
  const boton = $("btn-entrar");
  boton.disabled = true;
  $("error-entrar").hidden = true;
  try {
    const ruta = "/v1/authentication/usernamepassword/" + (creandoCuenta ? "sign-up" : "sign-in");
    recordarSesion(await pedirAuth(ruta, { username, password }));
    $("clave").value = "";
    if (creandoCuenta) cambiarModo();
    entrarAlPanel();
  } catch (fallo) {
    mostrarEntrar(mensajeEntrar(fallo));
  } finally {
    boton.disabled = false;
  }
}

function entrarAlPanel() {
  $("mi-id").textContent = corto(sesion.id);
  mostrarSolo("app");
  irA("fotos");
  cargarCola();
}

function cerrarSesion(mensaje) {
  olvidarSesion();
  cerrarHoja();
  rev.vista++;
  rev.cola = [];
  rev.actual = null;
  rev.datos = null;
  rev.pendienteVisible = false;
  rev.origen = "cola";
  rev.masQuePagina = false;
  rev.fotos.clear();
  rev.ocupado = false;
  cargadas.clear();
  lotes.length = 0;
  // Nada de lo que se vio queda en la pagina despues de salir.
  bloquearDecisiones();
  $("revision").hidden = true;
  $("foto-grande").removeAttribute("src");
  $("foto-chica").removeAttribute("src");
  $("rev-id").textContent = "";
  $("rev-apelacion").textContent = "";
  $("insignia").hidden = true;
  for (const id of ["c-lotes", "c-resultado", "den-lista", "t-estado", "err-lista"]) $(id).replaceChildren();
  $("c-codigo").value = "";
  olvidarBuzon();
  mostrarEntrar(mensaje);
}

function pedirSalir() {
  if (!lotes.some((lote) => !lote.guardado)) {
    cerrarSesion();
    return;
  }
  abrirHoja(
    el("h2", null, "Hay códigos sin guardar"),
    el("p", null, "Si salís, esos códigos no se pueden volver a ver."),
    el("button", { type: "button", class: "btn peligro grande", onclick: () => cerrarSesion() }, "Salir igual"),
    el("button", { type: "button", class: "btn", autofocus: true, onclick: cerrarHoja }, "Cancelar"),
  );
}

// ---------------------------------------------------------------- pestañas

const cargadas = new Set();
let pestana = "fotos";

function irA(tab) {
  pestana = tab;
  for (const boton of document.querySelectorAll(".pestana")) {
    if (boton.dataset.tab === tab) {
      boton.setAttribute("aria-current", "page");
      // En un teléfono angosto la fila se desplaza: la pestaña elegida queda a la vista.
      boton.scrollIntoView({ block: "nearest", inline: "nearest" });
    } else boton.removeAttribute("aria-current");
  }
  for (const nombre of ["fotos", "denuncias", "jugadores", "buzon", "codigos", "temporada"]) $("tab-" + nombre).hidden = nombre !== tab;
  if (cargadas.has(tab)) return;
  cargadas.add(tab);
  if (tab === "denuncias") cargarDenuncias();
  if (tab === "jugadores") cargarVetos();
  if (tab === "buzon") { cargarGlobales(); cargarHistorial(); }
  if (tab === "temporada") { cargarEstado(); cargarErrores(); }
}

// ---------------------------------------------------------------- hoja de abajo

let hojaAbiertaEn = 0;

function abrirHoja(...nodos) {
  const hoja = $("hoja");
  // Lo que no va (null) no se pinta: replaceChildren lo escribiria como texto.
  hoja.replaceChildren(...nodos.filter((nodo) => nodo !== null && nodo !== undefined && nodo !== false));
  hojaAbiertaEn = Date.now();
  if (!hoja.open) hoja.showModal();
}

function cerrarHoja() {
  const hoja = $("hoja");
  if (hoja.open) hoja.close();
}

// ---------------------------------------------------------------- fotos

/* item: { id, t, apelacion }. origen "denuncia": se abrio desde una denuncia y no sigue la cola. */
const rev = {
  cola: [], i: 0, masQuePagina: false, cargando: false,
  actual: null, datos: null, pendienteVisible: false, vista: 0, ocupado: false, origen: "cola",
  fotos: new Map(),
};

function hace(t) {
  if (!t) return "";
  const minutos = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (minutos < 1) return "recién";
  if (minutos < 60) return "hace " + minutos + " min";
  const horas = Math.round(minutos / 60);
  if (horas < 48) return "hace " + horas + " h";
  return "hace " + Math.round(horas / 24) + " días";
}

const fechaHora = (t) => (t ? new Date(t).toLocaleString("es", { dateStyle: "short", timeStyle: "short" }) : "—");
const dataUrl = (b64) => "data:image/jpeg;base64," + b64;

function verFotos(id) {
  let promesa = rev.fotos.get(id);
  if (!promesa) {
    promesa = llamar(MODERACION, "adminVer", { id }, true);
    rev.fotos.set(id, promesa);
    promesa.catch(() => rev.fotos.delete(id));
  }
  return promesa;
}

function pintarInsignia() {
  const insignia = $("insignia");
  const n = rev.cola.length;
  insignia.textContent = n + (rev.masQuePagina ? "+" : "");
  insignia.hidden = n === 0;
}

function bloquearDecisiones() {
  for (const id of ["b-aprobar", "b-rechazar", "b-retirar", "b-vetar", "b-saltar"]) $(id).disabled = true;
}

function habilitarDecisiones() {
  const item = rev.actual;
  const datos = rev.datos;
  // Solo se aprueba lo que se esta viendo.
  $("b-aprobar").disabled = !rev.pendienteVisible;
  // Rechazar es lo unico que cierra una apelacion, que no trae foto.
  $("b-rechazar").disabled = !((datos && datos.pendiente) || item.apelacion);
  $("b-retirar").disabled = !(datos && datos.aprobada);
  $("b-vetar").disabled = false;
  $("b-saltar").disabled = rev.origen !== "cola" || rev.cola.length < 2;
}

async function cargarCola() {
  if (rev.cargando) return;
  rev.cargando = true;
  rev.origen = "cola";
  const vista = ++rev.vista;
  bloquearDecisiones();
  $("revision").hidden = true;
  $("fotos-vacio").hidden = false;
  $("fotos-vacio-texto").textContent = "Cargando la cola…";
  $("fotos-recargar").hidden = true;
  try {
    const respuesta = await llamar(MODERACION, "adminCola", null, true);
    if (vista !== rev.vista) return;
    rev.cola = respuesta.cola || [];
    rev.masQuePagina = rev.cola.length >= PAGINA;
    rev.i = 0;
    rev.fotos.clear();
    mostrarActual();
  } catch (fallo) {
    if (vista !== rev.vista) return;
    $("fotos-vacio-texto").textContent = mensajeDe(fallo);
    $("fotos-recargar").hidden = false;
  } finally {
    rev.cargando = false;
    pintarInsignia();
  }
}

function mostrarActual() {
  pintarInsignia();
  if (rev.cola.length === 0) {
    rev.vista++;
    rev.actual = null;
    $("revision").hidden = true;
    $("fotos-vacio").hidden = false;
    $("fotos-vacio-texto").textContent = "No hay fotos en espera.";
    $("fotos-recargar").hidden = false;
    return;
  }
  if (rev.i >= rev.cola.length) rev.i = 0;
  mostrarFoto(rev.cola[rev.i]);
}

function pintarContador() {
  if (rev.origen !== "cola") {
    $("rev-contador").textContent = "Jugador denunciado";
    return;
  }
  $("rev-contador").textContent = (rev.i + 1) + " de " + rev.cola.length + (rev.masQuePagina ? "+" : "");
}

async function mostrarFoto(item) {
  const vista = ++rev.vista;
  rev.actual = item;
  rev.datos = null;
  rev.pendienteVisible = false;
  bloquearDecisiones();
  $("fotos-vacio").hidden = true;
  $("revision").hidden = false;
  $("rev-volver").hidden = rev.origen === "cola";
  pintarContador();
  $("rev-id").textContent = corto(item.id);
  $("rev-hora").textContent = hace(item.t);
  const apelacion = $("rev-apelacion");
  apelacion.textContent = item.apelacion ? "Apelación: " + item.apelacion : "";
  apelacion.hidden = !item.apelacion;

  const grande = $("foto-grande");
  const mensaje = $("foto-mensaje");
  const etiqueta = $("foto-etiqueta");
  grande.hidden = true;
  grande.removeAttribute("src");
  etiqueta.hidden = true;
  $("foto-publicada").hidden = true;
  mensaje.hidden = false;
  mensaje.textContent = "Cargando la foto…";

  let datos;
  try {
    datos = await verFotos(item.id);
  } catch (fallo) {
    if (vista !== rev.vista) return;
    mensaje.textContent = mensajeDe(fallo);
    $("b-saltar").disabled = rev.origen !== "cola" || rev.cola.length < 2;
    return;
  }
  const pendienteVisible = await sePuedeVer(datos.pendiente);
  const aprobadaVisible = await sePuedeVer(datos.aprobada);
  if (vista !== rev.vista) return;
  rev.datos = datos;
  rev.pendienteVisible = pendienteVisible;

  if (pendienteVisible || aprobadaVisible) {
    grande.src = dataUrl(pendienteVisible ? datos.pendiente : datos.aprobada);
    grande.alt = pendienteVisible ? "Foto pendiente de revisión" : "Foto publicada ahora";
    grande.hidden = false;
    etiqueta.textContent = pendienteVisible ? "Pendiente" : datos.pendiente ? "Publicada" : "Publicada, sin pendiente";
    etiqueta.hidden = false;
  }
  if (datos.pendiente && !pendienteVisible) {
    // Lo que no se ve no se aprueba, pero tampoco puede quedar trabado en la cola.
    mensaje.textContent = "La foto pendiente no se puede mostrar. No se puede aprobar: rechazala para sacarla de la cola.";
    if (aprobadaVisible) etiqueta.textContent = "Publicada. La pendiente no se puede mostrar: no se puede aprobar.";
    mensaje.hidden = aprobadaVisible;
  } else if (!pendienteVisible && !aprobadaVisible) {
    mensaje.textContent = item.apelacion
      ? "Esta apelación no trae foto. Rechazar la cierra; el jugador puede volver a subir otra."
      : "Este jugador no tiene foto pendiente ni publicada.";
  } else {
    mensaje.hidden = true;
  }
  if (pendienteVisible && aprobadaVisible) {
    $("foto-chica").src = dataUrl(datos.aprobada);
    $("foto-publicada").hidden = false;
  }

  await dormir(GUARDA_MS);
  if (vista !== rev.vista || rev.ocupado) return;
  habilitarDecisiones();
  adelantarSiguiente();
}

async function sePuedeVer(b64) {
  if (!b64) return false;
  const imagen = new Image();
  imagen.src = dataUrl(b64);
  try {
    await imagen.decode();
    return true;
  } catch (err) {
    return false;
  }
}

/** Trae la foto que sigue antes de que haga falta: pasar de una a otra es lo que se repite. */
function adelantarSiguiente() {
  if (rev.origen !== "cola" || rev.cola.length < 2) return;
  const siguiente = rev.cola[(rev.i + 1) % rev.cola.length];
  verFotos(siguiente.id).catch(() => { /* se reintenta al mostrarla */ });
}

/** resuelve: la foto sale de la cola y se pasa a la siguiente. Sin eso, se queda en la misma. */
async function decidir(accion, datos, textoListo, resuelve) {
  if (rev.ocupado || !rev.actual) return;
  rev.ocupado = true;
  bloquearDecisiones();
  const item = rev.actual;
  try {
    await llamar(MODERACION, accion, datos);
    avisar(textoListo, "bien");
  } catch (fallo) {
    if (fallo.codigo === "sin_pendiente") {
      // Se resolvio en otro lado, o el pedido anterior llego aunque no volvio la respuesta.
      avisar(mensajeDe(fallo), "mal");
      rev.ocupado = false;
      rev.fotos.delete(item.id);
      if (rev.origen === "cola") cargarCola();
      else mostrarFoto(item);
      return;
    }
    avisarFallo(fallo);
    rev.ocupado = false;
    if (fallo.codigo !== "no_autorizado" && fallo.codigo !== "sin_sesion") {
      if (rev.datos) habilitarDecisiones();
      else mostrarFoto(item);
    }
    return;
  }
  rev.ocupado = false;
  rev.fotos.delete(item.id);
  if (!resuelve) {
    mostrarFoto(item);
    return;
  }
  const lugar = rev.cola.findIndex((otro) => otro.id === item.id);
  if (lugar >= 0) {
    rev.cola.splice(lugar, 1);
    if (rev.origen === "cola") rev.i = lugar;
  }
  pintarInsignia();
  if (rev.origen !== "cola") {
    // Abierta desde una denuncia: se sigue viendo al mismo jugador, ya sin la apelacion resuelta.
    mostrarFoto({ ...item, apelacion: "" });
  } else if (rev.cola.length === 0 && rev.masQuePagina) {
    // La cola en memoria se termino, pero el servidor pudo haber dejado mas de una pagina.
    cargarCola();
  } else {
    mostrarActual();
  }
}

function aprobar() {
  decidir("adminAprobar", { id: rev.actual.id }, "Foto aprobada.", true);
}

function pedirRechazo() {
  const id = rev.actual.id;
  const enviar = (motivo) => {
    cerrarHoja();
    decidir("adminRechazar", { id, motivo }, rev.actual.apelacion && !rev.datos.pendiente ? "Apelación cerrada." : "Foto rechazada.", true);
  };
  const otro = el("input", { type: "text", maxlength: "200", "aria-label": "Otro motivo", placeholder: "Otro motivo" });
  abrirHoja(
    el("h2", null, "¿Por qué se rechaza?"),
    el("p", { class: "suave" }, "El jugador ve este motivo."),
    ...MOTIVOS.map((motivo, n) => el("button", { type: "button", class: "btn", autofocus: n === 0, onclick: () => enviar(motivo) }, motivo)),
    el("label", { class: "campo" }, otro),
    el("button", { type: "button", class: "btn", onclick: () => { if (otro.value.trim()) enviar(otro.value.trim()); else otro.focus(); } }, "Rechazar con ese motivo"),
    el("button", { type: "button", class: "btn", onclick: cerrarHoja }, "Cancelar"),
  );
}

function pedirRetiro() {
  const id = rev.actual.id;
  const motivo = el("input", { type: "text", maxlength: "200", value: MOTIVO_POR_DEFECTO, "aria-label": "Motivo que ve el jugador" });
  abrirHoja(
    el("h2", null, "¿Retirar la foto publicada?"),
    el("img", { class: "hoja-foto", src: dataUrl(rev.datos.aprobada), alt: "Foto publicada ahora" }),
    el("p", null, "Se borra del servidor y deja de verse. El jugador " + corto(id) + " ve este motivo:"),
    el("label", { class: "campo" }, motivo),
    el("button", { type: "button", class: "btn peligro grande", onclick: () => {
      cerrarHoja();
      decidir("adminRetirar", { id, motivo: motivo.value.trim() || MOTIVO_POR_DEFECTO }, "Foto publicada retirada.", false);
    } }, "Sí, retirarla"),
    el("button", { type: "button", class: "btn", autofocus: true, onclick: cerrarHoja }, "Cancelar"),
  );
}

function pedirVeto() {
  const id = rev.actual.id;
  const dias = el("input", { type: "number", inputmode: "numeric", min: "0", max: "3650", value: "30", "aria-label": "Días de veto" });
  const confirmar = el("button", { type: "button", class: "btn peligro grande" });
  const leerDias = () => {
    const n = Number(dias.value);
    return dias.value !== "" && Number.isInteger(n) && n >= 0 && n <= 3650 ? n : null;
  };
  const pintar = () => {
    const n = leerDias();
    confirmar.disabled = n === null;
    confirmar.textContent = n === null ? "De 0 a 3650 días" : n === 0 ? "Sí, levantar el veto" : "Sí, vetar " + n + (n === 1 ? " día" : " días");
    for (const chip of chips) chip.setAttribute("aria-pressed", String(Number(chip.dataset.dias) === n));
  };
  const chips = VETO_DIAS.map((n) => el("button", { type: "button", class: "btn", "data-dias": String(n), onclick: () => { dias.value = String(n); pintar(); } }, n + " d"));
  dias.addEventListener("input", pintar);
  confirmar.addEventListener("click", () => {
    const n = leerDias();
    if (n === null) return;
    cerrarHoja();
    decidir("adminVetar", { id, dias: n }, n === 0 ? "Ya puede volver a subir fotos." : "Sin subir fotos por " + n + (n === 1 ? " día." : " días."), false);
  });
  abrirHoja(
    el("h2", null, "¿Vetar las fotos de " + corto(id) + "?"),
    el("p", null, "Solo le impide subir fotos nuevas: para sacarlo de todo lo online, usá la pestaña Jugadores. La publicada sigue puesta hasta que la retires, y la pendiente sigue en la cola. Con 0 días se levanta este veto."),
    el("div", { class: "chips" }, ...chips),
    el("label", { class: "campo" }, "Días", dias),
    confirmar,
    el("button", { type: "button", class: "btn", autofocus: true, onclick: cerrarHoja }, "Cancelar"),
  );
  pintar();
}

function saltar() {
  if (rev.cola.length < 2) return;
  rev.i = (rev.i + 1) % rev.cola.length;
  mostrarActual();
}

function verJugadorDenunciado(id) {
  rev.origen = "denuncia";
  rev.fotos.delete(id);
  const enCola = rev.cola.find((item) => item.id === id);
  irA("fotos");
  mostrarFoto(enCola || { id, t: 0, apelacion: "" });
}

function volverADenuncias() {
  rev.origen = "cola";
  rev.vista++;
  irA("denuncias");
  // Lo que se decidio en la denuncia pudo cambiar la cola.
  cargarCola();
}

// ---------------------------------------------------------------- dias

const hoyUtc = () => new Date().toISOString().substring(0, 10);

/** El servidor agrupa por dia UTC y recibe milisegundos: el mediodia cae siempre en ese dia. */
function diaDe(campo) {
  // El selector nativo deja borrar la fecha.
  if (!campo.value) campo.value = hoyUtc();
  return Date.parse(campo.value + "T12:00:00Z");
}

function moverDia(campo, dias) {
  const fecha = new Date(diaDe(campo));
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  campo.value = fecha.toISOString().substring(0, 10);
}

const avisoPagina = (n) => (n >= PAGINA ? " El servidor devuelve como máximo " + PAGINA + " por día: puede haber más." : "");

// ---------------------------------------------------------------- denuncias

async function cargarDenuncias() {
  const lista = $("den-lista");
  const resumen = $("den-resumen");
  resumen.textContent = "Cargando…";
  lista.replaceChildren();
  try {
    const respuesta = await llamar(MODERACION, "adminDenuncias", { dia: diaDe($("den-dia")) }, true);
    const denuncias = respuesta.denuncias || [];
    resumen.textContent = (denuncias.length === 0 ? "No hay denuncias este día." : denuncias.length + (denuncias.length === 1 ? " denuncia." : " denuncias.")) + " Días en UTC." + avisoPagina(denuncias.length);
    lista.replaceChildren(...denuncias.slice().reverse().map(tarjetaDenuncia));
  } catch (fallo) {
    resumen.textContent = mensajeDe(fallo);
  }
}

function tarjetaDenuncia(d) {
  return el("article", { class: "tarjeta" },
    el("div", { class: "cabecera-tarjeta" },
      el("span", { class: "etiqueta" }, String(d.tipo || "")),
      el("strong", null, String(d.nombre || "Sin nombre")),
      el("span", { class: "suave" }, fechaHora(d.t))),
    d.detalle ? el("p", null, String(d.detalle)) : null,
    el("dl", { class: "datos" },
      el("dt", null, "Jugador"), el("dd", { class: "mono" }, String(d.jugador || "")),
      el("dt", null, "Denunció"), el("dd", { class: "mono" }, String(d.por || ""))),
    el("div", { class: "botones-tarjeta" },
      el("button", { type: "button", class: "btn", onclick: () => verJugadorDenunciado(String(d.jugador)) }, "Ver foto"),
      el("button", { type: "button", class: "btn", onclick: () => abrirJugador(String(d.jugador)) }, "Ver jugador"),
      el("button", { type: "button", class: "btn", onclick: () => copiar(String(d.jugador), "Player ID copiado.") }, "Copiar ID")));
}

// ---------------------------------------------------------------- jugadores

/* Un nombre de perfil tiene hasta 16 caracteres; un Player ID, bastantes mas. */
const NOMBRE_MAX = 16;
const datosDeJugador = (texto) => (texto.length > NOMBRE_MAX ? { id: texto } : { nombre: texto });
const miles = (n) => Number(n || 0).toLocaleString("es-AR");
let vistaJugador = 0;

function abrirJugador(id) {
  irA("jugadores");
  $("j-buscar").value = id;
  verJugador({ id });
}

function buscarJugador(evento) {
  evento.preventDefault();
  const texto = $("j-buscar").value.trim();
  if (texto) verJugador(datosDeJugador(texto));
}

async function verJugador(pedido) {
  const vista = ++vistaJugador;
  const resultado = $("j-resultado");
  resultado.replaceChildren(el("p", { class: "nota" }, "Buscando…"));
  try {
    const r = await llamar(MODERACION, "adminJugador", pedido, true);
    if (vista === vistaJugador) resultado.replaceChildren(tarjetaJugador(r));
  } catch (fallo) {
    if (vista === vistaJugador) resultado.replaceChildren(el("p", { class: "nota" }, mensajeDe(fallo)));
  }
}

function textoCuenta(cuenta) {
  switch (cuenta.estado) {
    case "ok": return (cuenta.suspendida ? "Suspendida" : "Activa") + (cuenta.vinculada ? ", vinculada a una plataforma" : ", sin vincular");
    case "sin_secreto": return "Sin datos: falta el secreto CUENTA_SERVICIO";
    case "no_existe": return "No existe en Unity";
    default: return "No se pudo consultar";
  }
}

function tarjetaJugador(r) {
  const p = r.perfil;
  const nombre = p ? p.nombre : "";
  const filas = [];
  const fila = (titulo, valor, clase) => filas.push(el("dt", null, titulo), el("dd", clase ? { class: clase } : null, String(valor)));
  if (p) {
    fila("Nivel", p.nivel);
    fila("Bajas", miles(p.kills));
    fila("Oro", miles(p.oro));
    if (p.kills > 0) fila("Oro por baja", miles(Math.round(p.oro / p.kills)));
    fila("Portales", miles(p.portales));
    fila("Muertes", miles(p.muertes));
    if (p.clan) fila("Clan", p.clan);
    if (p.bio) fila("Bio", p.bio);
  }
  fila("Cuenta", textoCuenta(r.cuenta));
  if (r.cuenta.ingreso) fila("Último ingreso", fechaHora(r.cuenta.ingreso * 1000));
  fila("Player ID", r.id, "mono");
  if (r.veto) {
    fila("Vetado", fechaHora(r.veto.t));
    fila("Motivo", r.veto.m || "Sin motivo");
  }
  const botones = [];
  if (r.admin) botones.push(el("span", { class: "etiqueta" }, "Administrador"));
  else if (r.veto) {
    botones.push(el("button", { type: "button", class: "btn", onclick: () => pedirLevantarVeto(r.id, nombre) }, "Levantar veto"));
    if (r.veto.cuenta !== "ok") botones.push(el("button", { type: "button", class: "btn peligro", onclick: () => pedirVetoCuenta(r.id, nombre, r.veto.m) }, "Repetir veto"));
  } else {
    botones.push(el("button", { type: "button", class: "btn peligro", onclick: () => pedirVetoCuenta(r.id, nombre, "") }, "Vetar"));
  }
  botones.push(el("button", { type: "button", class: "btn", onclick: () => mandarCartaA({ id: r.id, nombre, nivel: p ? p.nivel : 0, sinPerfil: !p }) }, "Mandar carta"));
  botones.push(el("button", { type: "button", class: "btn", onclick: () => copiar(r.id, "Player ID copiado.") }, "Copiar ID"));
  return el("article", { class: "tarjeta" },
    el("div", { class: "cabecera-tarjeta" },
      el("strong", null, nombre || "Sin perfil"),
      r.veto ? el("span", { class: "etiqueta mal" }, "Vetado") : null),
    el("dl", { class: "datos" }, ...filas),
    el("div", { class: "botones-tarjeta" }, ...botones));
}

function pedirVetoCuenta(id, nombre, motivoAnterior) {
  const motivo = el("input", { type: "text", maxlength: "200", value: motivoAnterior || "", "aria-label": "Motivo del veto" });
  abrirHoja(
    el("h2", null, "¿Vetar a " + (nombre || corto(id)) + "?"),
    el("p", null, "Se queda sin chat, mercado, amigos, clanes ni tops, y sus publicaciones dejan de verse. Puede seguir jugando su partida, solo. Se puede levantar cuando quieras."),
    el("label", { class: "campo" }, "Motivo (solo lo ves vos)", motivo),
    el("button", { type: "button", class: "btn peligro grande", onclick: () => { cerrarHoja(); vetarCuenta(id, nombre, motivo.value.trim()); } }, "Sí, vetar"),
    el("button", { type: "button", class: "btn", autofocus: true, onclick: cerrarHoja }, "Cancelar"),
  );
}

async function vetarCuenta(id, nombre, motivo) {
  const quien = nombre || corto(id);
  try {
    const r = await llamar(MODERACION, "adminVetarCuenta", { id, motivo, nombre }, false);
    if (r.cuenta === "ok") avisar(quien + " quedó vetado.", "bien");
    else if (r.cuenta === "sin_secreto") avisar(quien + " quedó vetado, pero falta el secreto CUENTA_SERVICIO: con las versiones viejas del juego todavía puede chatear. Mirá la guía.", "mal");
    else avisar(quien + " quedó vetado, pero Unity no suspendió la cuenta" + (r.http ? " (HTTP " + r.http + ")" : "") + ". Repetí el veto más tarde.", "mal");
  } catch (fallo) {
    avisarFallo(fallo);
  }
  verJugador({ id });
  cargarVetos();
}

function pedirLevantarVeto(id, nombre) {
  abrirHoja(
    el("h2", null, "¿Levantar el veto de " + (nombre || corto(id)) + "?"),
    el("p", null, "Vuelve a tener todo lo online, y sus publicaciones se ven de nuevo. Vuelve a los tops la próxima vez que sincronice."),
    el("button", { type: "button", class: "btn primario grande", onclick: () => { cerrarHoja(); levantarVeto(id, nombre); } }, "Sí, levantar"),
    el("button", { type: "button", class: "btn", autofocus: true, onclick: cerrarHoja }, "Cancelar"),
  );
}

async function levantarVeto(id, nombre) {
  try {
    await llamar(MODERACION, "adminLevantarVeto", { id }, false);
    avisar("Veto levantado: " + (nombre || corto(id)) + ".", "bien");
  } catch (fallo) {
    avisarFallo(fallo);
  }
  verJugador({ id });
  cargarVetos();
}

async function cargarVetos() {
  const lista = $("j-vetos");
  const resumen = $("j-resumen");
  resumen.textContent = "Cargando…";
  try {
    const { vetos } = await llamar(MODERACION, "adminVetos", null, true);
    resumen.textContent = vetos.length === 0 ? "No hay nadie vetado." : vetos.length + (vetos.length === 1 ? " vetado." : " vetados.");
    lista.replaceChildren(...vetos.map(tarjetaVeto));
  } catch (fallo) {
    resumen.textContent = mensajeDe(fallo);
  }
}

function tarjetaVeto(v) {
  const id = String(v.id);
  const nombre = String(v.n || "");
  return el("article", { class: "tarjeta" },
    el("div", { class: "cabecera-tarjeta" },
      el("strong", null, nombre || "Sin perfil"),
      v.cuenta === "ok" ? null : el("span", { class: "etiqueta mal" }, "Sin suspender en Unity"),
      el("span", { class: "suave" }, fechaHora(v.t))),
    v.m ? el("p", null, String(v.m)) : null,
    el("div", { class: "botones-tarjeta" },
      el("button", { type: "button", class: "btn", onclick: () => abrirJugador(id) }, "Ver"),
      el("button", { type: "button", class: "btn", onclick: () => pedirLevantarVeto(id, nombre) }, "Levantar veto")));
}

// ---------------------------------------------------------------- buzon

/*
 * Lo mismo que BuzonAdminWindow, contra el script Buzon. Los objetos salen del catalogo de
 * admin-objetos.js (Tools/generar_catalogo_panel.py) y no se escriben a mano: una carta con un
 * nombre que el juego no conoce queda esperando una actualizacion que nunca llega.
 */
const CARTA_OBJETOS_MAX = 10;
const CARTA_CANTIDAD_MAX = 9999;
const CARTA_NUMERO_MAX = 10000000;
const CARTA_DIAS_MAX = 365;
// Primera version de Buzon.js que guarda la rareza: con una anterior, el jugador recibiria la pieza comun.
const BUZON_CON_RAREZA = 2;
// Una carta con rareza la entrega el juego desde esta version; el servidor la pide igual.
const RAREZA_VERSION = "0.5.0";
const RAREZAS = ["Common", "Rare", "Epic", "Legendary"];
const RAREZAS_ES = ["Común", "Raro", "Épico", "Legendario"];
const VERSION_RE = /^\d+(\.\d+){0,3}$/;
const PLAYER_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;

const catalogo = typeof CATALOGO_OBJETOS !== "undefined" && CATALOGO_OBJETOS && Array.isArray(CATALOGO_OBJETOS.objetos) ? CATALOGO_OBJETOS : null;
const objetoPorNombre = new Map(catalogo ? catalogo.objetos.map((o) => [o.n, o]) : []);

/* objetos: { n, cant, r }, con r = "" (la rareza del objeto) o una de RAREZAS. */
const buzon = { para: "uno", elegido: null, objetos: [], version: 0, vista: 0, enviando: false };

const nota = (texto) => el("p", { class: "nota" }, texto);
const sinTildes = (texto) => texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
const nombreRareza = (r) => (RAREZAS.indexOf(r) >= 0 ? RAREZAS_ES[RAREZAS.indexOf(r)] : String(r));

async function llamarBuzon(accion, datos, repetible) {
  const r = await llamar(BUZON, accion, datos, repetible);
  if (r.version) buzon.version = r.version;
  return r;
}

function compararVersiones(a, b) {
  const pa = String(a || "0").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b || "0").split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** La version desde la que se recibe, como la calcula Buzon.js. */
function versionFinal(pedida, conRareza) {
  if (conRareza && (!pedida || compararVersiones(pedida, RAREZA_VERSION) < 0)) return RAREZA_VERSION;
  return pedida || "";
}

function regaloDe(carta) {
  const partes = (carta.objetos || []).map((o) => (o.n > 1 ? o.n + "× " : "") + String(o.id) + (o.r ? " (" + nombreRareza(o.r) + ")" : ""));
  if (carta.oro > 0) partes.push(miles(carta.oro) + " de oro");
  if (carta.xp > 0) partes.push(miles(carta.xp) + " de experiencia");
  return partes.length ? partes.join(", ") : "Solo el mensaje";
}

function ponerPara(para) {
  buzon.para = para;
  $("bz-para-uno").setAttribute("aria-pressed", String(para === "uno"));
  $("bz-para-todos").setAttribute("aria-pressed", String(para === "todos"));
  $("bz-zona-uno").hidden = para !== "uno";
  $("bz-zona-todos").hidden = para !== "todos";
  $("bz-pendientes").hidden = para !== "uno";
}

// ---- a quien

async function buscarDestino() {
  const texto = $("bz-buscar").value.trim();
  if (!texto) {
    $("bz-buscar").focus();
    return;
  }
  const vista = ++buzon.vista;
  buzon.elegido = null;
  $("bz-pendientes").replaceChildren();
  const zona = $("bz-resultados");
  zona.replaceChildren(nota("Buscando…"));
  try {
    if (texto.length > NOMBRE_MAX) {
      if (!PLAYER_ID_RE.test(texto)) throw new Fallo("no_existe");
      let perfil = null;
      try {
        perfil = (await llamar(PERFILES, "ver", { id: texto }, true)).perfil;
      } catch (fallo) {
        if (fallo.codigo !== "no_existe") throw fallo;
      }
      if (vista !== buzon.vista) return;
      elegirDestino(perfil ? { id: texto, nombre: String(perfil.nombre || ""), nivel: perfil.nivel || 0 } : { id: texto, nombre: "", nivel: 0, sinPerfil: true });
      return;
    }
    const { perfiles } = await llamar(PERFILES, "buscar", { texto }, true);
    if (vista !== buzon.vista) return;
    zona.replaceChildren(...(perfiles && perfiles.length
      ? perfiles.map(tarjetaPerfil)
      : [nota("Nadie tiene un nombre que empiece con «" + texto + "». A un jugador sin perfil se le escribe con su Player ID.")]));
  } catch (fallo) {
    if (vista === buzon.vista) zona.replaceChildren(nota(mensajeDe(fallo)));
  }
}

function tarjetaPerfil(p) {
  const destino = { id: String(p.id), nombre: String(p.nombre || ""), nivel: p.nivel || 0 };
  return el("article", { class: "tarjeta" },
    el("div", { class: "cabecera-tarjeta" },
      el("strong", null, destino.nombre),
      el("span", { class: "suave" }, "Nivel " + destino.nivel),
      p.clan ? el("span", { class: "etiqueta" }, String(p.clan)) : null),
    el("div", { class: "botones-tarjeta" },
      el("button", { type: "button", class: "btn", onclick: () => elegirDestino(destino) }, "Elegir")));
}

function elegirDestino(destino) {
  buzon.vista++;
  buzon.elegido = destino;
  $("bz-resultados").replaceChildren(el("article", { class: "tarjeta" },
    el("div", { class: "cabecera-tarjeta" },
      el("span", { class: "etiqueta bien" }, "Para"),
      el("strong", null, destino.nombre || "Sin perfil"),
      destino.nivel ? el("span", { class: "suave" }, "Nivel " + destino.nivel) : null),
    destino.sinPerfil ? nota("No tiene perfil: la carta va igual a este Player ID.") : null,
    el("p", { class: "mono" }, destino.id),
    el("div", { class: "botones-tarjeta" },
      el("button", { type: "button", class: "btn", onclick: cambiarDestino }, "Cambiar"))));
  cargarPendientes();
}

function cambiarDestino() {
  buzon.vista++;
  buzon.elegido = null;
  $("bz-resultados").replaceChildren();
  $("bz-pendientes").replaceChildren();
  $("bz-buscar").focus();
}

/** Desde la pestaña Jugadores. */
function mandarCartaA(destino) {
  irA("buzon");
  ponerPara("uno");
  $("bz-buscar").value = destino.nombre || destino.id;
  elegirDestino(destino);
  document.querySelector("main").scrollTop = 0;
}

// ---- lo que todavia no recibio

async function cargarPendientes() {
  const destino = buzon.elegido;
  const zona = $("bz-pendientes");
  if (!destino) {
    zona.replaceChildren();
    return;
  }
  const vista = buzon.vista;
  zona.replaceChildren(nota("Buscando sus cartas…"));
  try {
    const r = await llamarBuzon("pendientesDe", { para: destino.id }, true);
    if (vista !== buzon.vista) return;
    const cartas = r.cartas || [];
    zona.replaceChildren(
      el("h2", null, "Buzón de " + (destino.nombre || corto(destino.id))),
      nota(cartas.length === 0 ? "No tiene cartas sin recibir." : cartas.length + (cartas.length === 1 ? " carta sin recibir." : " cartas sin recibir.")),
      ...cartas.map((c) => tarjetaCarta(c, [], [el("button", { type: "button", class: "btn peligro", onclick: () => pedirCancelar(destino, c) }, "Cancelar")])));
  } catch (fallo) {
    if (vista === buzon.vista) zona.replaceChildren(nota(mensajeDe(fallo)));
  }
}

function tarjetaCarta(c, etiquetas, botones) {
  return el("article", { class: "tarjeta" },
    el("div", { class: "cabecera-tarjeta" },
      el("strong", null, String(c.titulo || "Sin título")),
      el("span", { class: "suave" }, fechaHora(c.fecha)),
      ...etiquetas),
    c.mensaje ? el("p", null, String(c.mensaje)) : null,
    el("p", { class: "suave" }, "Regalo: " + regaloDe(c)),
    c.minVersion ? el("p", { class: "suave" }, "Se recibe desde la versión " + String(c.minVersion)) : null,
    botones.length ? el("div", { class: "botones-tarjeta" }, ...botones) : null);
}

function pedirCancelar(destino, carta) {
  abrirHoja(
    el("h2", null, "¿Cancelar esta carta?"),
    el("p", null, "«" + String(carta.titulo || "") + "», para " + (destino.nombre || corto(destino.id)) + ". Todavía no la recibió: deja de verla y no recibe lo que trae."),
    el("button", { type: "button", class: "btn peligro grande", onclick: async () => {
      cerrarHoja();
      try {
        // Con el nombre, el historial dice a quién se le canceló.
        await llamarBuzon("cancelar", { para: destino.id, nombre: destino.nombre || "", id: carta.id });
        avisar("Carta cancelada.", "bien");
      } catch (fallo) {
        if (fallo.codigo === "no_existe") avisar("Esa carta ya no está: la recibió o ya se canceló.", "mal");
        else avisarFallo(fallo);
      }
      cargarPendientes();
      if (sesion.token) cargarHistorial();
    } }, "Sí, cancelarla"),
    el("button", { type: "button", class: "btn", autofocus: true, onclick: cerrarHoja }, "No"),
  );
}

// ---- objetos

function pintarObjetos() {
  $("bz-objetos").replaceChildren(...buzon.objetos.map(filaObjeto));
  $("bz-cuenta-objetos").textContent = buzon.objetos.length ? buzon.objetos.length + " de " + CARTA_OBJETOS_MAX + " objetos" : "";
  $("bz-agregar").disabled = !catalogo || buzon.objetos.length >= CARTA_OBJETOS_MAX;
}

function filaObjeto(o) {
  const info = objetoPorNombre.get(o.n);
  // Como en la ventana del editor: solo el equipo (y lo que hereda de el) acepta otra rareza.
  const esEquipo = !!info && typeof info.r === "number";
  const cantidad = el("input", { type: "number", inputmode: "numeric", min: "1", max: String(CARTA_CANTIDAD_MAX), value: String(o.cant), "aria-label": "Cantidad de " + o.n });
  cantidad.addEventListener("input", () => { o.cant = cantidad.value === "" ? NaN : Number(cantidad.value); });
  let izquierda = el("span", { class: "solo" }, info ? info.g : "");
  if (esEquipo) {
    const rareza = el("select", { "aria-label": "Rareza de " + o.n },
      el("option", { value: "" }, "Normal (" + (RAREZAS_ES[info.r] || "?") + ")"),
      ...RAREZAS.map((r, i) => el("option", { value: r }, RAREZAS_ES[i])));
    rareza.value = o.r;
    rareza.addEventListener("change", () => { o.r = rareza.value; });
    izquierda = el("label", { class: "campo" }, "Rareza", rareza);
  }
  return el("article", { class: "tarjeta objeto" },
    el("div", { class: "cabecera-tarjeta" },
      el("strong", null, o.n),
      el("button", { type: "button", class: "btn chico", "aria-label": "Quitar " + o.n, onclick: () => {
        buzon.objetos.splice(buzon.objetos.indexOf(o), 1);
        pintarObjetos();
      } }, "✕")),
    el("div", { class: "dos-columnas" }, izquierda, el("label", { class: "campo" }, "Cantidad", cantidad)));
}

function pedirObjeto() {
  if (!catalogo || buzon.objetos.length >= CARTA_OBJETOS_MAX) return;
  const filtro = el("input", { type: "search", placeholder: "Buscar por nombre", "aria-label": "Buscar objeto", autocapitalize: "none", autocorrect: "off", spellcheck: "false" });
  const lista = el("div", { class: "elegir-lista" });
  const pintar = () => {
    const buscado = sinTildes(filtro.value.trim());
    const nodos = [];
    let grupo = "";
    for (const o of catalogo.objetos) {
      if (buscado && !sinTildes(o.n).includes(buscado)) continue;
      if (o.g !== grupo) {
        grupo = o.g;
        nodos.push(el("p", { class: "grupo-objetos" }, grupo));
      }
      nodos.push(el("button", { type: "button", class: "btn", onclick: () => agregarObjeto(o.n) },
        el("span", null, o.n),
        el("span", null, typeof o.r === "number" ? RAREZAS_ES[o.r] || "" : "")));
    }
    lista.replaceChildren(...(nodos.length ? nodos : [nota("Ningún objeto se llama así.")]));
  };
  filtro.addEventListener("input", pintar);
  pintar();
  abrirHoja(
    el("h2", null, "Agregar objeto"),
    el("label", { class: "campo" }, filtro),
    lista,
    el("button", { type: "button", class: "btn", onclick: cerrarHoja }, "Cancelar"),
  );
}

function agregarObjeto(nombre) {
  cerrarHoja();
  if (buzon.objetos.length >= CARTA_OBJETOS_MAX) return;
  buzon.objetos.push({ n: nombre, cant: 1, r: "" });
  pintarObjetos();
}

// ---- revisar y mandar

function leerNumero(id, max) {
  const texto = $(id).value.trim();
  const n = texto === "" ? 0 : Number(texto);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : null;
}

/** La carta del formulario, revisada como la revisaria el servidor: { carta, datos } o { error, campo }. */
function leerCarta() {
  const titulo = $("bz-titulo").value.trim();
  if (!titulo) return { error: "Falta el título.", campo: "bz-titulo" };
  const objetos = [];
  for (const o of buzon.objetos) {
    if (!objetoPorNombre.has(o.n)) return { error: "«" + o.n + "» no está en el catálogo." };
    if (!Number.isInteger(o.cant) || o.cant < 1 || o.cant > CARTA_CANTIDAD_MAX) return { error: "La cantidad de «" + o.n + "» va de 1 a " + CARTA_CANTIDAD_MAX + "." };
    objetos.push(o.r ? { id: o.n, n: o.cant, r: o.r } : { id: o.n, n: o.cant });
  }
  const oro = leerNumero("bz-oro", CARTA_NUMERO_MAX);
  if (oro === null) return { error: "El oro va de 0 a " + miles(CARTA_NUMERO_MAX) + ".", campo: "bz-oro" };
  const xp = leerNumero("bz-xp", CARTA_NUMERO_MAX);
  if (xp === null) return { error: "La experiencia va de 0 a " + miles(CARTA_NUMERO_MAX) + ".", campo: "bz-xp" };
  const carta = { titulo, mensaje: $("bz-mensaje").value.trim(), objetos, oro, xp };

  if (buzon.para === "uno") {
    if (!buzon.elegido) return { error: "Elegí a quién va: buscalo por nombre o pegá su Player ID.", campo: "bz-buscar" };
    return { carta, datos: { para: buzon.elegido.id, nombre: buzon.elegido.nombre || "", carta } };
  }
  const textoDias = $("bz-dias").value.trim();
  const dias = textoDias === "" ? 30 : Number(textoDias);
  if (!Number.isInteger(dias) || dias < 0 || dias > CARTA_DIAS_MAX) return { error: "Los días van de 0 a " + CARTA_DIAS_MAX + ".", campo: "bz-dias" };
  const minVersion = $("bz-version").value.trim();
  if (minVersion && !VERSION_RE.test(minVersion)) return { error: "La versión mínima va así: 0.5.2.", campo: "bz-version" };
  return { carta, dias, minVersion, datos: { carta, dias, minVersion } };
}

function revisarCarta(evento) {
  evento.preventDefault();
  const leida = leerCarta();
  if (leida.error) {
    avisar(leida.error, "mal");
    if (leida.campo) $(leida.campo).focus();
    return;
  }
  const { carta } = leida;
  const todos = buzon.para === "todos";
  const destino = buzon.elegido;
  const filas = [];
  const fila = (titulo, valor, clase) => filas.push(el("dt", null, titulo), el("dd", clase ? { class: clase } : null, valor));
  fila("Para", todos ? "TODOS los jugadores" : (destino.nombre || "Sin perfil") + " · " + corto(destino.id), todos ? "para-todos" : null);
  fila("Título", carta.titulo);
  if (carta.mensaje) fila("Mensaje", carta.mensaje, "cita");
  fila("Regalo", regaloDe(carta));
  if (todos) fila("Dura", leida.dias === 0 ? "No vence" : leida.dias + (leida.dias === 1 ? " día" : " días"));
  const desde = versionFinal(todos ? leida.minVersion : "", carta.objetos.some((o) => o.r));
  if (desde) fila("Se recibe", "Desde la versión " + desde);
  abrirHoja(
    el("h2", null, todos ? "¿Mandar esta carta a todos?" : "¿Mandar esta carta?"),
    el("dl", { class: "datos" }, ...filas),
    todos ? el("p", null, "La recibe cada jugador una vez, también los que entren mientras dure. Quitarla después no le saca nada a quien ya la recibió.") : null,
    el("button", { type: "button", class: "btn grande " + (todos ? "peligro" : "primario"), onclick: () => { cerrarHoja(); enviarCarta(leida, todos, destino); } },
      todos ? "Sí, mandarla a todos" : "Mandar a " + (destino.nombre || corto(destino.id))),
    el("button", { type: "button", class: "btn", autofocus: true, onclick: cerrarHoja }, "Cancelar"),
  );
}

async function enviarCarta(leida, todos, destino) {
  if (buzon.enviando) return;
  buzon.enviando = true;
  const boton = $("bz-revisar");
  boton.disabled = true;
  boton.textContent = "Mandando…";
  try {
    // Un Buzon.js viejo guardaria la carta sin la rareza: primero se pregunta que version hay.
    if (leida.carta.objetos.some((o) => o.r) && buzon.version < BUZON_CON_RAREZA) {
      await llamarBuzon("soyAdmin", null, true);
      if (buzon.version < BUZON_CON_RAREZA) {
        avisar("El script Buzon publicado es viejo y no guarda la rareza: el jugador recibiría la pieza normal. Hay que publicar Buzon.js. No se mandó nada.", "mal");
        return;
      }
    }
    // No se repite sola: si la respuesta se pierde, la carta pudo haber llegado igual.
    const r = await llamarBuzon(todos ? "enviarTodos" : "enviar", leida.datos);
    const desde = r.minVersion ? " Se recibe desde la versión " + r.minVersion + "." : "";
    avisar((todos ? "Carta mandada a todos." : "Carta mandada a " + (r.nombre || destino.nombre || corto(destino.id)) + ".") + desde, "bien");
    limpiarCarta();
    if (todos) cargarGlobales();
    else if (buzon.elegido === destino) cargarPendientes();
  } catch (fallo) {
    if (["sin_conexion", "caido", "script_error", "servidor"].includes(fallo.codigo)) avisar(mensajeDe(fallo) + " Mirá el historial antes de mandarla de nuevo.", "mal");
    else avisarFallo(fallo);
  } finally {
    buzon.enviando = false;
    boton.disabled = false;
    boton.textContent = "Revisar y enviar";
    if (sesion.token) cargarHistorial();
  }
}

function limpiarCarta() {
  $("bz-titulo").value = "";
  $("bz-mensaje").value = "";
  $("bz-oro").value = "0";
  $("bz-xp").value = "0";
  buzon.objetos = [];
  pintarObjetos();
}

// ---- para todos e historial

async function cargarGlobales() {
  const zona = $("bz-globales");
  zona.replaceChildren(nota("Cargando…"));
  try {
    const r = await llamarBuzon("globales", null, true);
    const cartas = r.cartas || [];
    zona.replaceChildren(...(cartas.length ? cartas.map(tarjetaGlobal) : [nota("Ninguna.")]));
  } catch (fallo) {
    zona.replaceChildren(nota(mensajeDe(fallo)));
  }
}

function tarjetaGlobal(c) {
  const vence = !c.vence ? "No vence" : (c.vigente ? "Hasta " : "Venció ") + fechaHora(c.vence);
  return tarjetaCarta(c,
    [el("span", { class: "etiqueta " + (c.vigente ? "bien" : "mal") }, vence)],
    [el("button", { type: "button", class: "btn peligro", onclick: () => pedirQuitar(c) }, "Quitar")]);
}

function pedirQuitar(carta) {
  abrirHoja(
    el("h2", null, "¿Quitar esta carta para todos?"),
    el("p", null, "«" + String(carta.titulo || "") + "». Quien ya la recibió se queda con lo que traía; el resto deja de verla."),
    el("button", { type: "button", class: "btn peligro grande", onclick: async () => {
      cerrarHoja();
      try {
        await llamarBuzon("quitarGlobal", { id: carta.id });
        avisar("Carta quitada.", "bien");
      } catch (fallo) {
        avisarFallo(fallo);
      }
      cargarGlobales();
      if (sesion.token) cargarHistorial();
    } }, "Sí, quitarla"),
    el("button", { type: "button", class: "btn", autofocus: true, onclick: cerrarHoja }, "Cancelar"),
  );
}

async function cargarHistorial() {
  const zona = $("bz-historial");
  zona.replaceChildren(nota("Cargando…"));
  try {
    const r = await llamarBuzon("historial", null, true);
    const envios = (r.envios || []).slice(0, 40);
    zona.replaceChildren(envios.length ? el("div", { class: "historial" }, ...envios.map(lineaHistorial)) : nota("Todavía no se mandó nada."));
  } catch (fallo) {
    zona.replaceChildren(nota(mensajeDe(fallo)));
  }
}

function lineaHistorial(e) {
  const quien = String(e.nombre || "") || corto(e.para);
  const que = e.tipo === "g" ? "A todos"
    : e.tipo === "p" ? "A " + quien
    : e.tipo === "quitada" ? "Quitada para todos"
    : "Cancelada para " + quien;
  return el("p", null, el("span", { class: "suave" }, fechaHora(e.fecha) + " · "), que + (e.titulo ? ": " + String(e.titulo) : ""));
}

function olvidarBuzon() {
  buzon.vista++;
  buzon.elegido = null;
  buzon.version = 0;
  buzon.enviando = false;
  limpiarCarta();
  ponerPara("uno");
  $("bz-buscar").value = "";
  $("bz-dias").value = "30";
  $("bz-version").value = "";
  for (const id of ["bz-resultados", "bz-pendientes", "bz-globales", "bz-historial"]) $(id).replaceChildren();
}

// ---------------------------------------------------------------- codigos

const lotes = [];

const fechaLocal = (texto) => {
  if (!texto) return 0;
  const [a, m, d] = texto.split("-").map(Number);
  return new Date(a, m - 1, d).getTime();
};

function nombreArchivo(lote) {
  const dosCifras = (n) => String(n).padStart(2, "0");
  const f = lote.creado;
  const sello = "" + f.getFullYear() + dosCifras(f.getMonth() + 1) + dosCifras(f.getDate()) + "_" + dosCifras(f.getHours()) + dosCifras(f.getMinutes()) + dosCifras(f.getSeconds());
  return (lote.campana || "lote").replace(/[^A-Za-z0-9_-]+/g, "_") + "_" + sello + ".csv";
}

function descargarLote(lote) {
  const archivo = new Blob([lote.codigos.join("\n") + "\n"], { type: "text/csv" });
  const url = URL.createObjectURL(archivo);
  const enlace = el("a", { href: url, download: nombreArchivo(lote) });
  document.body.append(enlace);
  enlace.click();
  enlace.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  lote.guardado = true;
  pintarLote(lote);
}

function pintarLote(lote) {
  const contenido = [
    el("div", { class: "cabecera-tarjeta" },
      el("strong", null, lote.codigos.length + (lote.codigos.length === 1 ? " código" : " códigos")),
      el("span", { class: "suave" }, lote.campana || "Sin campaña")),
    lote.error ? el("p", { class: "error" }, lote.error) : null,
    el("p", { class: "aviso-lote" }, lote.guardado ? "Ya lo copiaste o descargaste." : "Guardalos ahora: el servidor solo guarda el hash y no se pueden volver a ver."),
    el("textarea", { readonly: true, rows: String(Math.min(8, Math.max(3, lote.codigos.length))), "aria-label": "Códigos generados", class: "mono", value: lote.codigos.join("\n") }),
    el("div", { class: "dos-botones" },
      el("button", { type: "button", class: "btn", disabled: lote.codigos.length === 0, onclick: async () => {
        if (await copiar(lote.codigos.join("\n"), "Códigos copiados.")) {
          lote.guardado = true;
          pintarLote(lote);
        }
      } }, "Copiar todos"),
      el("button", { type: "button", class: "btn", disabled: lote.codigos.length === 0, onclick: () => descargarLote(lote) }, "Descargar .csv")),
  ];
  lote.nodo.replaceChildren(...contenido.filter(Boolean));
}

async function generarCodigos(evento) {
  evento.preventDefault();
  const cantidad = Number($("c-cantidad").value);
  const usos = Number($("c-usos").value);
  const tipo = $("c-tipo").value;
  const recompensa = $("c-recompensa").value.trim();
  if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > CODIGOS_MAX) { avisar("La cantidad tiene que ser de 1 a " + CODIGOS_MAX + ".", "mal"); return; }
  if (!Number.isInteger(usos) || usos < 1) { avisar("Los usos por código tienen que ser 1 o más.", "mal"); return; }
  if (tipo === "cosmetico" && !recompensa) { avisar("Falta el id del cosmético.", "mal"); return; }

  const campana = $("c-campana").value.trim();
  const base = {
    usos_max: usos, tipo, recompensa: tipo === "cosmetico" ? recompensa : "",
    prefijo: $("c-prefijo").value.trim(), campana,
    temporada: tipo === "elite" ? $("c-temporada").value.trim() : "",
    desde: fechaLocal($("c-desde").value), hasta: fechaLocal($("c-hasta").value),
    por_cuenta: $("c-por-cuenta").checked,
  };
  const lote = { campana, codigos: [], creado: new Date(), guardado: false, error: "", nodo: el("article", { class: "tarjeta" }) };
  lotes.unshift(lote);
  $("c-lotes").prepend(lote.nodo);

  const boton = $("c-generar");
  boton.disabled = true;
  let faltan = cantidad;
  try {
    while (faltan > 0) {
      boton.textContent = "Generando " + (cantidad - faltan) + " de " + cantidad + "…";
      const parte = Math.min(faltan, CODIGOS_POR_PEDIDO);
      // No se repite solo: si la respuesta se perdio, esos codigos no los conoce nadie y no sirven.
      const respuesta = await llamar(PASE, "adminCrearCodigos", { ...base, cantidad: parte });
      lote.codigos.push(...respuesta.codigos);
      faltan -= parte;
      pintarLote(lote);
    }
    avisar(lote.codigos.length + " códigos listos. Guardalos ahora.", "bien");
  } catch (fallo) {
    lote.error = "Salieron " + lote.codigos.length + " de " + cantidad + ". " + mensajeDe(fallo);
    if (lote.codigos.length === 0) lote.guardado = true;
    pintarLote(lote);
    avisarFallo(fallo);
  } finally {
    boton.disabled = false;
    boton.textContent = "Generar";
    pintarLote(lote);
    lote.nodo.scrollIntoView({ block: "nearest" });
  }
}

const codigoEscrito = () => $("c-codigo").value.trim().toUpperCase();

async function consultarCodigo() {
  const codigo = codigoEscrito();
  if (!codigo) { avisar("Escribí un código.", "mal"); return; }
  const resultado = $("c-resultado");
  resultado.replaceChildren(el("p", { class: "nota" }, "Consultando…"));
  try {
    const r = await llamar(PASE, "adminConsultar", { codigo }, true);
    resultado.replaceChildren(tarjetaCodigo(codigo, r.codigo || {}, r.canjes || []));
  } catch (fallo) {
    resultado.replaceChildren(el("p", { class: "error" }, mensajeDe(fallo)));
  }
}

function tarjetaCodigo(codigo, c, canjes) {
  const estado = c.activo === false
    ? el("span", { class: "etiqueta mal" }, "Revocado " + fechaHora(c.revocado))
    : el("span", { class: "etiqueta bien" }, "Activo");
  return el("article", { class: "tarjeta" },
    el("div", { class: "cabecera-tarjeta" }, el("strong", { class: "mono" }, codigo), estado),
    el("dl", { class: "datos" },
      el("dt", null, "Campaña"), el("dd", null, String(c.campana || "—")),
      el("dt", null, "Recompensa"), el("dd", null, c.tipo === "elite" ? "Pase Élite " + String(c.temporada || "") : String(c.rec || "—")),
      el("dt", null, "Usos"), el("dd", null, (c.usos || 0) + " de " + (c.usos_max || 0)),
      el("dt", null, "Por cuenta"), el("dd", null, c.por_cuenta === false ? "Sin límite" : "Una vez"),
      el("dt", null, "Desde"), el("dd", null, c.desde ? fechaHora(c.desde) : "—"),
      el("dt", null, "Vence"), el("dd", null, c.hasta ? fechaHora(c.hasta) : "—"),
      el("dt", null, "Creado"), el("dd", null, fechaHora(c.creado))),
    el("h2", null, "Canjes (" + canjes.length + ")"),
    canjes.length >= PAGINA ? el("p", { class: "nota" }, "El servidor muestra hasta " + PAGINA + " canjes: «Usos» tiene el total.") : null,
    ...canjes.map((canje) => el("p", { class: "mono" }, String(canje.jugador || "") + " · " + fechaHora(canje.t))));
}

function pedirRevocar() {
  const codigo = codigoEscrito();
  if (!codigo) { avisar("Escribí un código.", "mal"); return; }
  abrirHoja(
    el("h2", null, "¿Revocar este código?"),
    el("p", { class: "mono" }, codigo),
    el("p", null, "Deja de servir para siempre: no hay forma de volver a activarlo."),
    el("button", { type: "button", class: "btn peligro grande", onclick: async () => {
      cerrarHoja();
      try {
        await llamar(PASE, "adminRevocar", { codigo });
        avisar("Código revocado.", "bien");
        consultarCodigo();
      } catch (fallo) {
        avisarFallo(fallo);
      }
    } }, "Sí, revocarlo"),
    el("button", { type: "button", class: "btn", autofocus: true, onclick: cerrarHoja }, "Cancelar"),
  );
}

// ---------------------------------------------------------------- temporada

function etiquetaSecreto(existe, valido) {
  if (!existe) return el("span", { class: "etiqueta mal" }, "Falta");
  return valido ? el("span", { class: "etiqueta bien" }, "Bien") : el("span", { class: "etiqueta mal" }, "No es válido");
}

async function cargarEstado() {
  const zona = $("t-estado");
  zona.replaceChildren(el("p", { class: "nota" }, "Cargando…"));
  try {
    const r = await llamar(PASE, "adminEstado", null, true);
    const t = r.temporada;
    const partes = [];
    partes.push(t
      ? el("article", { class: "tarjeta" },
        el("div", { class: "cabecera-tarjeta" },
          el("strong", null, String(t.nombre || t.id)),
          el("span", { class: "etiqueta " + (t.fase === "activa" ? "bien" : "mal") }, String(t.fase))),
        el("dl", { class: "datos" },
          el("dt", null, "Id"), el("dd", { class: "mono" }, String(t.id)),
          el("dt", null, "Inicio"), el("dd", null, String(t.inicio || "—")),
          el("dt", null, "Fin"), el("dd", null, String(t.fin || "—")),
          el("dt", null, "Producto"), el("dd", { class: "mono" }, String(t.producto || "—")),
          el("dt", null, "Compras"), el("dd", null, t.compras ? "Abiertas" : "Cerradas"),
          el("dt", null, "Recompensas"), el("dd", null, String(t.recompensas))))
      : el("article", { class: "tarjeta" }, el("p", null, "No hay temporada configurada en Remote Config.")));
    if (t) {
      partes.push(el("article", { class: "tarjeta" },
        el("dl", { class: "datos" },
          el("dt", null, "Google Play"), el("dd", null, etiquetaSecreto(r.secreto, r.secretoValido)),
          el("dt", null, "App Store"), el("dd", null, etiquetaSecreto(r.secretoApple, r.secretoAppleValido)),
          el("dt", null, "Crypto"), el("dd", null, r.crypto ? "Disponible" : "Sin crypto"),
          el("dt", null, "Script Pase"), el("dd", null, "Versión " + String(r.version)))));
    }
    zona.replaceChildren(...partes);
  } catch (fallo) {
    zona.replaceChildren(el("p", { class: "error" }, mensajeDe(fallo)));
  }
}

async function cargarErrores() {
  const lista = $("err-lista");
  const resumen = $("err-resumen");
  resumen.textContent = "Cargando…";
  lista.replaceChildren();
  try {
    const r = await llamar(PASE, "adminErrores", { dia: diaDe($("err-dia")) }, true);
    const errores = r.errores || [];
    resumen.textContent = (errores.length === 0 ? "Sin errores este día." : errores.length + (errores.length === 1 ? " error." : " errores.")) + " Días en UTC." + avisoPagina(errores.length);
    lista.replaceChildren(...errores.slice().reverse().map((e) => el("article", { class: "tarjeta" },
      el("div", { class: "cabecera-tarjeta" },
        el("strong", { class: "mono" }, String(e.p || "Sin producto")),
        el("span", { class: "suave" }, fechaHora(e.t))),
      el("p", null, String(e.e || "")),
      el("p", { class: "mono" }, String(e.j || "")))));
  } catch (fallo) {
    resumen.textContent = mensajeDe(fallo);
  }
}

// ---------------------------------------------------------------- arranque

function conectar() {
  $("form-entrar").addEventListener("submit", enviarEntrar);
  $("cambiar-modo").addEventListener("click", cambiarModo);
  $("ver-clave").addEventListener("click", () => {
    const clave = $("clave");
    const ver = clave.type === "password";
    clave.type = ver ? "text" : "password";
    $("ver-clave").textContent = ver ? "Ocultar" : "Ver";
  });

  $("sp-copiar").addEventListener("click", () => copiar(sesion.id, "Player ID copiado."));
  $("sp-reintentar").addEventListener("click", entrarAlPanel);
  $("sp-salir").addEventListener("click", () => cerrarSesion());

  $("mi-id").addEventListener("click", () => copiar(sesion.id, "Tu Player ID quedó copiado."));
  $("salir").addEventListener("click", pedirSalir);
  for (const boton of document.querySelectorAll(".pestana")) {
    boton.addEventListener("click", () => irA(boton.dataset.tab));
  }

  $("b-aprobar").addEventListener("click", aprobar);
  $("b-rechazar").addEventListener("click", pedirRechazo);
  $("b-retirar").addEventListener("click", pedirRetiro);
  $("b-vetar").addEventListener("click", pedirVeto);
  $("b-saltar").addEventListener("click", saltar);
  $("rev-id").addEventListener("click", () => copiar(rev.actual.id, "Player ID copiado."));
  $("rev-actualizar").addEventListener("click", cargarCola);
  $("rev-volver").addEventListener("click", volverADenuncias);
  $("fotos-recargar").addEventListener("click", cargarCola);

  const hoy = hoyUtc();
  $("den-dia").value = hoy;
  $("err-dia").value = hoy;
  $("den-dia").addEventListener("change", cargarDenuncias);
  $("den-actualizar").addEventListener("click", cargarDenuncias);
  $("den-antes").addEventListener("click", () => { moverDia($("den-dia"), -1); cargarDenuncias(); });
  $("den-despues").addEventListener("click", () => { moverDia($("den-dia"), 1); cargarDenuncias(); });

  $("form-jugador").addEventListener("submit", buscarJugador);
  $("j-actualizar").addEventListener("click", cargarVetos);

  $("bz-para-uno").addEventListener("click", () => ponerPara("uno"));
  $("bz-para-todos").addEventListener("click", () => ponerPara("todos"));
  $("bz-buscar-ir").addEventListener("click", buscarDestino);
  // Enter en la busqueda busca; no abre la revision de la carta.
  $("bz-buscar").addEventListener("keydown", (evento) => {
    if (evento.key !== "Enter") return;
    evento.preventDefault();
    buscarDestino();
  });
  $("bz-agregar").addEventListener("click", pedirObjeto);
  $("form-carta").addEventListener("submit", revisarCarta);
  $("bz-globales-act").addEventListener("click", cargarGlobales);
  $("bz-historial-act").addEventListener("click", cargarHistorial);
  $("bz-sin-catalogo").hidden = !!catalogo;
  pintarObjetos();

  $("form-codigos").addEventListener("submit", generarCodigos);
  $("c-tipo").addEventListener("change", () => {
    const elite = $("c-tipo").value === "elite";
    $("c-recompensa-campo").hidden = elite;
    $("c-temporada-campo").hidden = !elite;
  });
  $("c-consultar").addEventListener("click", consultarCodigo);
  $("c-revocar").addEventListener("click", pedirRevocar);

  $("t-actualizar").addEventListener("click", cargarEstado);
  $("err-dia").addEventListener("change", cargarErrores);
  $("err-actualizar").addEventListener("click", cargarErrores);
  $("err-antes").addEventListener("click", () => { moverDia($("err-dia"), -1); cargarErrores(); });
  $("err-despues").addEventListener("click", () => { moverDia($("err-dia"), 1); cargarErrores(); });

  // El segundo toque de un doble toque no puede contestar la confirmacion que acaba de abrirse.
  $("hoja").addEventListener("click", (evento) => {
    if (Date.now() - hojaAbiertaEn < GUARDA_MS) {
      evento.stopPropagation();
      evento.preventDefault();
    }
  }, true);
  // Tocar afuera de la hoja la cierra sin hacer nada.
  $("hoja").addEventListener("click", (evento) => { if (evento.target === $("hoja")) cerrarHoja(); });

  window.addEventListener("beforeunload", (evento) => {
    if (lotes.some((lote) => !lote.guardado)) {
      evento.preventDefault();
      evento.returnValue = "";
    }
  });
}

conectar();
if (restaurarSesion()) entrarAlPanel();
else mostrarEntrar();
