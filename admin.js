"use strict";
/*
 * Administracion diaria de Cursedon desde el celular: reemplaza a PaseAdminWindow sin Unity.
 *
 * No hay ningun secreto aca: el ID del proyecto es publico y el permiso lo decide el servidor
 * (Moderacion.js y Pase.js solo atienden a los Player ID de "buzon_admins"). La contraseña no
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

const avisarFallo = (fallo) => {
  // Esas dos ya cambiaron de pantalla, y la pantalla lo explica mejor.
  if (fallo.codigo !== "no_autorizado" && fallo.codigo !== "sin_sesion") avisar(mensajeDe(fallo), "mal");
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
          if (salida.error === "no_autorizado") mostrarSinPermiso();
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
    if (boton.dataset.tab === tab) boton.setAttribute("aria-current", "page");
    else boton.removeAttribute("aria-current");
  }
  for (const nombre of ["fotos", "denuncias", "jugadores", "codigos", "temporada"]) $("tab-" + nombre).hidden = nombre !== tab;
  if (cargadas.has(tab)) return;
  cargadas.add(tab);
  if (tab === "denuncias") cargarDenuncias();
  if (tab === "jugadores") cargarVetos();
  if (tab === "temporada") { cargarEstado(); cargarErrores(); }
}

// ---------------------------------------------------------------- hoja de abajo

let hojaAbiertaEn = 0;

function abrirHoja(...nodos) {
  const hoja = $("hoja");
  hoja.replaceChildren(...nodos);
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
