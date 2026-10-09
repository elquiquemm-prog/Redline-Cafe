"use strict";

const DB_NAME = "redlineCafeDB";
const DB_VERSION = 1;
const SHEETS_URL = "https://script.google.com/macros/s/AKfycbxUV06wUihi0Yt6IiMGnbMMbDxD5mjCPaTWcxcJEIRKvZ4FPnZUUScqN1qaH0Lir-q7/exec";
const STORE = {
  users: "users",
  cart: "cart",
  orders: "orders",
  results: "results"
};

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const currency = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD"
});
const modalReturnFocus = new WeakMap();

let database;
let users = [];
let currentUser = null;
let cart = [];
let mutationQueue = Promise.resolve();
let toastTimer;

function requestSheets(params) {
  return new Promise((resolve, reject) => {
    const callbackName = `redlineSheets_${makeId().replaceAll("-", "_")}`;
    const script = document.createElement("script");
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("Google Sheets no respondio a tiempo."));
    }, 15000);
    const cleanup = () => {
      clearTimeout(timeout);
      delete window[callbackName];
      script.remove();
    };

    window[callbackName] = response => {
      cleanup();
      if (!response || response.ok !== true) {
        reject(new Error(response?.error || "Google Sheets rechazo la solicitud."));
        return;
      }
      resolve(response);
    };
    script.onerror = () => {
      cleanup();
      reject(new Error("No se pudo conectar con Google Sheets."));
    };
    const query = new URLSearchParams({
      ...params,
      callback: callbackName
    });
    script.src = `${SHEETS_URL}?${query.toString()}`;
    document.head.append(script);
  });
}

function saveToSheets(action, record) {
  return requestSheets({
    action: "save",
    payload: JSON.stringify({ action, [action]: record })
  });
}

function showToast(message) {
  const toast = $("#toast");
  if (!toast) return;
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.classList.add("show");
  toastTimer = setTimeout(() => toast.classList.remove("show"), 3200);
}

function runMutation(action, message, button = null) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  const operation = mutationQueue.then(action);
  mutationQueue = operation.catch(() => {});
  return operation
    .catch(error => {
      console.error(error);
      showToast(`${message} ${error.message || "Revisa la conexión e inténtalo de nuevo."}`);
    })
    .finally(() => {
      if (button?.isConnected) button.disabled = false;
    });
}

function openModal(modal) {
  if (!modal || modal.classList.contains("open")) return;
  modalReturnFocus.set(modal, document.activeElement);
  modal.classList.add("open");
  document.body.classList.add("modal-open");
  $(".modal-close", modal)?.focus();
}

function closeModal(modal) {
  if (!modal?.classList.contains("open")) return;
  modal.classList.remove("open");
  if (!$(".modal.open")) document.body.classList.remove("modal-open");
  const previous = modalReturnFocus.get(modal);
  if (previous?.isConnected) previous.focus();
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE.users)) {
        db.createObjectStore(STORE.users, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE.cart)) {
        db.createObjectStore(STORE.cart, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE.orders)) {
        const store = db.createObjectStore(STORE.orders, { keyPath: "id" });
        store.createIndex("userId", "userId");
      }
      if (!db.objectStoreNames.contains(STORE.results)) {
        const store = db.createObjectStore(STORE.results, { keyPath: "id" });
        store.createIndex("userId", "userId");
        store.createIndex("challenge", "challenge");
      }
    };
    request.onsuccess = () => {
      database = request.result;
      database.onversionchange = () => {
        database.close();
        database = null;
        showToast("La base de datos cambio en otra pestana. Recarga la pagina.");
      };
      resolve(database);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error("La base de datos esta abierta en otra pestana."));
  });
}

function storeRequest(storeName, mode, createRequest) {
  return new Promise((resolve, reject) => {
    if (!database) {
      reject(new Error("La base de datos local no esta disponible."));
      return;
    }
    const transaction = database.transaction(storeName, mode);
    const request = createRequest(transaction.objectStore(storeName));
    let result;
    request.onsuccess = () => { result = request.result; };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Operacion cancelada."));
  });
}

function getAll(storeName) {
  return storeRequest(storeName, "readonly", store => store.getAll());
}

function getById(storeName, id) {
  return storeRequest(storeName, "readonly", store => store.get(id));
}

function put(storeName, value) {
  return storeRequest(storeName, "readwrite", store => store.put(value));
}

function replaceStore(storeName, items) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readwrite");
    const store = transaction.objectStore(storeName);
    const request = store.getAll();
    request.onsuccess = () => {
      const keep = new Set(items.map(item => item.id));
      for (const item of request.result) {
        if (!keep.has(item.id)) store.delete(item.id);
      }
      for (const item of items) store.put(item);
    };
    request.onerror = () => reject(request.error);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Operacion cancelada."));
  });
}

function makeId() {
  return window.crypto?.randomUUID?.() ||
    `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function setProfile(user) {
  currentUser = user || null;
  const name = currentUser?.name || "";
  const profileName = $("#profileName");
  if (profileName) profileName.textContent = name ? `Perfil activo: ${name}` : "Perfil activo";
  $("#profileDescription")?.replaceChildren(
    document.createTextNode(name
      ? "Tu perfil esta listo para participar."
      : "Tu perfil esta listo para participar.")
  );
  $("#profileCard")?.classList.toggle("show", Boolean(name));
  const gameProfile = $("#gameProfile");
  if (gameProfile) {
    gameProfile.textContent = name
      ? `Perfil activo: ${name}.`
      : "Elige un participante registrado o crea un perfil.";
  }
  const userSelect = $("#resultUser");
  if (userSelect) {
    userSelect.innerHTML = users.length
      ? users.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name)}</option>`).join("")
      : '<option value="">Crea un perfil para registrar resultados</option>';
    userSelect.disabled = users.length === 0;
    if (currentUser && users.some(item => item.id === currentUser.id)) {
      userSelect.value = currentUser.id;
    }
  }
}

async function registerUser(name) {
  const cleanName = String(name || "").trim().replace(/\s+/g, " ");
  if (cleanName.length < 2 || cleanName.length > 80) {
    showToast("Escribe un nombre de entre 2 y 80 caracteres.");
    return;
  }
  users = await getAll(STORE.users);
  let user = users.find(item => item.name.toLocaleLowerCase() === cleanName.toLocaleLowerCase());
  const isSwitching = !currentUser || currentUser.id !== user?.id;
  if (!user) {
    user = { id: makeId(), name: cleanName, active: true, createdAt: Date.now() };
  }
  const nextUsers = users.map(item => ({
    ...item,
    active: item.id === user.id,
    ...(item.id === user.id ? { name: cleanName } : {})
  }));
  if (!nextUsers.some(item => item.id === user.id)) nextUsers.push(user);

  await saveToSheets("profile", { id: user.id, name: cleanName });
  await new Promise((resolve, reject) => {
    const transaction = database.transaction(
      isSwitching ? [STORE.users, STORE.cart] : [STORE.users],
      "readwrite"
    );
    const store = transaction.objectStore(STORE.users);
    for (const item of nextUsers) store.put(item);
    if (isSwitching) transaction.objectStore(STORE.cart).clear();
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error || new Error("Operacion cancelada."));
  });

  users = nextUsers;
  if (isSwitching) cart = [];
  setProfile(user);
  renderCart();
  renderInvoice();
  updateCartCount();
  $("#registrationModal")?.classList.remove("open");
  if (!$(".modal.open")) document.body.classList.remove("modal-open");
  $("#registrationForm")?.reset();
  $("#registrationFormModal")?.reset();
  showToast(`Perfil listo: ${user.name}.`);
}

function getLineTotal(item) {
  return Math.round(item.price * 100) * item.quantity / 100;
}

function getCartTotal() {
  return cart.reduce((sum, item) => sum + Math.round(item.price * 100) * item.quantity, 0) / 100;
}

function updateCartCount() {
  const count = cart.reduce((sum, item) => sum + item.quantity, 0);
  const badge = $("#cartCount");
  if (badge) badge.textContent = count;
  $("#openCartButton")?.setAttribute("aria-label", `Abrir carrito; ${count} productos`);
  const savedButton = $("#emitInvoiceButton");
  if (savedButton) {
    savedButton.disabled = false;
    savedButton.textContent = "Guardar pedido";
  }
}

function renderCart() {
  const container = $("#cartContent");
  if (!container) return;
  if (!cart.length) {
    container.innerHTML = '<p class="invoice-empty">Tu carrito esta vacio.</p>';
    return;
  }
  container.innerHTML = cart.map(item => `
    <article class="menu-card cart-item">
      <div class="menu-info">
        <div class="menu-title-row"><h3>${escapeHtml(item.product)}</h3><span class="menu-price">${currency.format(item.price)}</span></div>
        <div class="menu-footer">
          <span class="menu-category">Subtotal: ${currency.format(getLineTotal(item))}</span>
          <div class="cart-quantity-controls" aria-label="Cantidad">
            <button class="add-button" type="button" data-cart-change="-1" data-id="${escapeHtml(item.id)}" aria-label="Quitar una unidad de ${escapeHtml(item.product)}">−</button>
            <strong aria-live="polite">${item.quantity}</strong>
            <button class="add-button" type="button" data-cart-change="1" data-id="${escapeHtml(item.id)}" aria-label="Agregar una unidad de ${escapeHtml(item.product)}">+</button>
          </div>
        </div>
      </div>
    </article>`).join("");
  $$("[data-cart-change]", container).forEach(button => button.addEventListener("click", () => {
    runMutation(async () => {
      const item = cart.find(row => row.id === button.dataset.id);
      if (!item) return;
      const next = cart.map(row => ({ ...row }));
      const changed = next.find(row => row.id === item.id);
      changed.quantity += Number(button.dataset.cartChange);
      await replaceStore(STORE.cart, next.filter(row => row.quantity > 0));
      cart = next.filter(row => row.quantity > 0);
      renderCart();
      renderInvoice();
      updateCartCount();
    }, "No se pudo actualizar la cantidad.", button);
  }));
}

function renderInvoice() {
  const rows = $("#invoiceItems");
  if (!rows) return;
  const total = $("#invoiceTotal");
  const client = $("#invoiceClient");
  const date = $("#invoiceDate");
  if (client) client.textContent = `Perfil: ${currentUser?.name || "Invitado"}`;
  if (date) date.textContent = `Fecha: ${new Date().toLocaleDateString("es-EC", { day: "2-digit", month: "long", year: "numeric" })}`;
  rows.innerHTML = cart.length
    ? cart.map(item => `<tr><td>${escapeHtml(item.product)}</td><td>${item.quantity}</td><td>${currency.format(item.price)}</td><td>${currency.format(getLineTotal(item))}</td></tr>`).join("")
    : '<tr><td colspan="4" class="invoice-empty">Tu carrito esta vacio.</td></tr>';
  if (total) total.textContent = currency.format(getCartTotal());
}

async function saveOrder() {
  if (!cart.length) {
    showToast("Agrega productos antes de guardar el pedido.");
    return;
  }
  if (!currentUser) {
    showToast("Crea un perfil antes de guardar el pedido.");
    openModal($("#registrationModal"));
    return;
  }
  const signature = JSON.stringify({
    userId: currentUser.id,
    items: cart.map(({ product, price, quantity }) => ({ product, price, quantity }))
      .sort((a, b) => a.product.localeCompare(b.product))
  });
  const orders = await getAll(STORE.orders);
  if (orders.some(order => order.cartSignature === signature)) {
    showToast("Este pedido ya esta guardado.");
    return;
  }
  const order = {
    id: makeId(),
    userId: currentUser.id,
    customerName: currentUser.name,
    items: cart.map(({ product, price, quantity }) => ({ product, price, quantity })),
    total: getCartTotal(),
    createdAt: Date.now(),
    cartSignature: signature
  };
  await saveToSheets("order", order);
  await put(STORE.orders, order);
  const button = $("#emitInvoiceButton");
  if (button) {
    button.disabled = true;
    button.textContent = "Pedido guardado";
  }
  showToast("Pedido guardado.");
}

function printSampleReceipt() {
  if (!cart.length) {
    showToast("Agrega productos antes de imprimir.");
    return;
  }
  const popup = window.open("", "_blank", "width=800,height=900");
  if (!popup) {
    showToast("Permite las ventanas emergentes para imprimir.");
    return;
  }
  const rows = cart.map(item => `<tr><td>${escapeHtml(item.product)}</td><td>${item.quantity}</td><td>${currency.format(item.price)}</td><td>${currency.format(getLineTotal(item))}</td></tr>`).join("");
  popup.document.write(`<!doctype html><html lang="es"><meta charset="utf-8"><title>Comprobante de pedido - Redline Cafe</title><style>body{max-width:760px;margin:35px auto;padding:0 20px;color:#211c18;font:14px Arial,sans-serif}h1{font-size:26px}.notice{padding:12px;background:#f7f1e8;border:1px solid #d9c7b4;line-height:1.5}table{width:100%;border-collapse:collapse;margin-top:24px}th,td{padding:10px 8px;border-bottom:1px solid #ddd5cc;text-align:left}th:last-child,td:last-child{text-align:right}.total{text-align:right;font-size:20px;margin-top:24px}@page{margin:18mm}</style><body><h1>Comprobante de pedido - Redline Cafe</h1><p class="notice">Este comprobante resume el pedido y no es una factura fiscal.</p><p>Perfil: ${escapeHtml(currentUser?.name || "Invitado")}</p><p>Fecha: ${new Date().toLocaleString("es-EC")}</p><table><thead><tr><th>Producto</th><th>Cantidad</th><th>Precio</th><th>Total</th></tr></thead><tbody>${rows}</tbody></table><p class="total">Total: <strong>${currency.format(getCartTotal())}</strong></p></body></html>`);
  popup.document.close();
  setTimeout(() => popup.print(), 350);
}

function parseTime(value) {
  const match = /^(\d{1,2}):([0-5]\d)\.(\d{2})$/.exec(String(value || "").trim());
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]) + Number(match[3]) / 100;
}

function formatTime(seconds) {
  const centiseconds = Math.round(seconds * 100);
  const minutes = Math.floor(centiseconds / 6000);
  const remaining = centiseconds % 6000;
  return `${String(minutes).padStart(2, "0")}:${String(Math.floor(remaining / 100)).padStart(2, "0")}.${String(remaining % 100).padStart(2, "0")}`;
}

async function renderResults() {
  const body = $("#leaderboardBody");
  if (!body) return;
  const localResults = await getAll(STORE.results);
  const localById = new Map(localResults.map(item => [item.id, item]));
  let sharedResultIds = new Set();
  let results = localResults;
  try {
    const shared = await requestSheets({ action: "ranking" });
    const sharedResults = [...(shared.ranking || []), ...(shared.bossResults || [])];
    sharedResultIds = new Set(sharedResults.map(item => item.id));
    const merged = new Map(localResults.map(item => [item.id, item]));
    for (const item of sharedResults) {
      merged.set(item.id, { ...merged.get(item.id), ...item, manual: true });
    }
    results = [...merged.values()];
  } catch (error) {
    console.error(error);
    showToast("No se pudo actualizar el ranking. Inténtalo de nuevo más tarde.");
  }
  const manualTimes = results
    .filter(item => item.challenge === "prueba-tiempo" && item.manual === true)
    .map(item => {
      const seconds = Number.isFinite(item.timeSeconds) ? item.timeSeconds : parseTime(item.result);
      return seconds === null ? null : { ...item, timeSeconds: seconds };
    })
    .filter(Boolean);
  const bestByUser = new Map();
  for (const result of manualTimes) {
    const existing = bestByUser.get(result.userId);
    if (!existing || result.timeSeconds < existing.timeSeconds) bestByUser.set(result.userId, result);
  }
  const ranking = [...bestByUser.values()].sort((a, b) => a.timeSeconds - b.timeSeconds).slice(0, 10);
  body.innerHTML = ranking.length
    ? ranking.map((item, index) => {
      const isLocal = localById.has(item.id);
      const actions = isLocal
        ? `<button class="add-button" type="button" data-edit-result="${escapeHtml(item.id)}">Editar</button>${sharedResultIds.has(item.id) ? "" : ` <button class="add-button" type="button" data-delete-result="${escapeHtml(item.id)}">Eliminar</button>`}`
        : "Compartido";
      return `<tr><td>#${index + 1}</td><td>${escapeHtml(item.userName)}</td><td><strong>${formatTime(item.timeSeconds)}</strong></td><td>${new Date(item.createdAt).toLocaleDateString("es-EC")}</td><td>${actions}</td></tr>`;
    }).join("")
    : '<tr><td class="invoice-empty" colspan="5">Aun no hay tiempos manuales.</td></tr>';
  const bossBody = $("#bossResultsBody");
  if (bossBody) {
    const bossResults = results
      .filter(item => item.challenge === "blacklist" && item.manual === true)
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 20);
    bossBody.innerHTML = bossResults.length
      ? bossResults.map(item => {
        const isLocal = localById.has(item.id);
        const actions = isLocal
          ? `<button class="add-button" type="button" data-edit-result="${escapeHtml(item.id)}">Editar</button>${sharedResultIds.has(item.id) ? "" : ` <button class="add-button" type="button" data-delete-result="${escapeHtml(item.id)}">Eliminar</button>`}`
          : "Compartido";
        return `<tr><td>${escapeHtml(item.userName)}</td><td>${escapeHtml(item.result)}</td><td>${new Date(item.createdAt).toLocaleDateString("es-EC")}</td><td>${actions}</td></tr>`;
      }).join("")
      : '<tr><td class="invoice-empty" colspan="4">Aun no hay resultados manuales.</td></tr>';
  }
  $$("[data-edit-result]").forEach(button => button.addEventListener("click", () => {
    runMutation(() => editResult(button.dataset.editResult), "No se pudo abrir el resultado para editar.", button);
  }));
  $$("[data-delete-result]").forEach(button => button.addEventListener("click", () => {
    if (!window.confirm("Eliminar este resultado guardado en este dispositivo?")) return;
    runMutation(async () => {
      const transaction = database.transaction(STORE.results, "readwrite");
      transaction.objectStore(STORE.results).delete(button.dataset.deleteResult);
      await new Promise((resolve, reject) => {
        transaction.oncomplete = resolve;
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      await renderResults();
      showToast("Resultado eliminado.");
    }, "No se pudo eliminar el resultado.", button);
  }));
}

async function editResult(id) {
  const item = await getById(STORE.results, id);
  if (!item || item.manual !== true) return;
  $("#editingResultId").value = item.id;
  $("#resultUser").value = item.userId;
  $("#resultChallenge").value = item.challenge;
  $("#resultTime").value = item.challenge === "prueba-tiempo"
    ? formatTime(Number.isFinite(item.timeSeconds) ? item.timeSeconds : parseTime(item.result))
    : "";
  $("#resultBoss").value = item.result;
  updateResultFields();
  $("#saveResultButton").textContent = "Guardar cambios";
  $("#cancelEditButton").hidden = false;
  $("#resultForm").scrollIntoView({ behavior: "smooth", block: "center" });
  $("#resultChallenge").focus();
}

function resetResultForm() {
  $("#resultForm")?.reset();
  $("#editingResultId").value = "";
  $("#saveResultButton").textContent = "Guardar resultado manual";
  $("#cancelEditButton").hidden = true;
  updateResultFields();
}

function updateResultFields() {
  const isTime = $("#resultChallenge")?.value === "prueba-tiempo";
  const timeField = $("#timeResultField");
  const bossField = $("#bossResultField");
  if (timeField) timeField.hidden = !isTime;
  if (bossField) bossField.hidden = isTime;
  $("#resultTime").required = isTime;
  $("#resultBoss").required = !isTime;
}

async function saveManualResult(event) {
  event.preventDefault();
  const id = $("#editingResultId").value;
  const userId = $("#resultUser").value;
  const challenge = $("#resultChallenge").value;
  const user = users.find(item => item.id === userId);
  if (!user) {
    showToast("Selecciona un perfil valido.");
    return;
  }
  let result;
  let timeSeconds;
  if (challenge === "prueba-tiempo") {
    const input = $("#resultTime").value.trim();
    timeSeconds = parseTime(input);
    if (timeSeconds === null) {
      showToast("Usa el formato MM:SS.xx, por ejemplo 01:24.82.");
      $("#resultTime").focus();
      return;
    }
    result = formatTime(timeSeconds);
  } else {
    result = $("#resultBoss").value;
  }
  const previous = id ? await getById(STORE.results, id) : null;
  const entry = {
    ...(previous || {}),
    id: id || makeId(),
    userId,
    userName: user.name,
    challenge,
    result,
    createdAt: id && previous ? previous.createdAt : Date.now(),
    updatedAt: id ? Date.now() : undefined,
    manual: true,
    simulated: false
  };
  if (challenge === "prueba-tiempo") entry.timeSeconds = timeSeconds;
  else delete entry.timeSeconds;
  await saveToSheets("result", entry);
  await put(STORE.results, entry);
  resetResultForm();
  await renderResults();
  showToast(id
    ? "Resultado corregido."
    : "Resultado guardado.");
}

function updateMobileMenu(open) {
  const nav = $("#navLinks");
  const button = $("#menuToggle");
  if (!nav || !button) return;
  nav.classList.toggle("open", open);
  button.setAttribute("aria-expanded", String(open));
  button.setAttribute("aria-label", open ? "Cerrar menu" : "Abrir menu");
  button.textContent = open ? "×" : "☰";
}

function bindSharedControls() {
  $("#year") && ($("#year").textContent = new Date().getFullYear());
  $("#menuToggle")?.addEventListener("click", () => updateMobileMenu(!$("#navLinks").classList.contains("open")));
  $$("#navLinks a").forEach(link => link.addEventListener("click", () => updateMobileMenu(false)));
  $("#openRegistrationButton")?.addEventListener("click", () => openModal($("#registrationModal")));
  $$("[data-close-modal]").forEach(button => button.addEventListener("click", () => closeModal(button.closest(".modal"))));
  $$(".modal").forEach(modal => modal.addEventListener("click", event => {
    if (event.target === modal) closeModal(modal);
  }));
  document.addEventListener("keydown", event => {
    const openModals = $$(".modal.open");
    const open = openModals[openModals.length - 1];
    if (event.key === "Escape") {
      if (open) closeModal(open);
      else if ($("#navLinks")?.classList.contains("open")) updateMobileMenu(false);
      return;
    }
    if (event.key !== "Tab" || !open) return;
    const controls = $$('a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),[tabindex]:not([tabindex="-1"])', open);
    if (!controls.length) return event.preventDefault();
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (!open.contains(document.activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  });
  document.addEventListener("click", event => {
    if ($("#navLinks")?.classList.contains("open") &&
        !$("#navLinks").contains(event.target) &&
        !$("#menuToggle").contains(event.target)) updateMobileMenu(false);
  });
  window.addEventListener("resize", () => {
    if (window.innerWidth > 820) updateMobileMenu(false);
  });
  window.addEventListener("scroll", () => $("#topbar")?.classList.toggle("scrolled", window.scrollY > 20), { passive: true });
  $$("img").forEach(image => image.addEventListener("error", () => {
    image.hidden = true;
    image.parentElement?.classList.add("image-fallback");
  }, { once: true }));
}

function bindProfileForms() {
  $("#registrationForm")?.addEventListener("submit", event => {
    event.preventDefault();
    runMutation(() => registerUser($("#userName").value), "No se pudo guardar el perfil.", event.currentTarget.querySelector('[type="submit"]'));
  });
  $("#registrationFormModal")?.addEventListener("submit", event => {
    event.preventDefault();
    runMutation(() => registerUser($("#modalUserName").value), "No se pudo guardar el perfil.", event.currentTarget.querySelector('[type="submit"]'));
  });
}

function bindMenu() {
  $$(".filter-button").forEach(button => button.addEventListener("click", () => {
    $$(".filter-button").forEach(filter => {
      filter.classList.toggle("active", filter === button);
      filter.setAttribute("aria-pressed", String(filter === button));
    });
    $$("#menuGrid .menu-card").forEach(card => card.classList.toggle("hidden", button.dataset.filter !== "all" && card.dataset.category !== button.dataset.filter));
  }));
  $$("[data-product][data-price]").forEach(button => button.addEventListener("click", () => runMutation(async () => {
    const product = button.dataset.product;
    const price = Number(button.dataset.price);
    if (!product || !Number.isFinite(price) || price <= 0) throw new Error("Invalid menu item.");
    const next = cart.map(item => ({ ...item }));
    const existing = next.find(item => item.product === product);
    if (existing) existing.quantity += 1;
    else next.push({ id: makeId(), product, price, quantity: 1 });
    await replaceStore(STORE.cart, next);
    cart = next;
    renderCart();
    renderInvoice();
    updateCartCount();
    showToast(`${product} agregado al carrito.`);
  }, "No se pudo agregar el producto.", button)));
  ["#openCartButton", "#openCartButtonMenu"].forEach(selector => $(selector)?.addEventListener("click", () => {
    renderCart();
    openModal($("#cartModal"));
  }));
  $("#checkoutButton")?.addEventListener("click", () => {
    closeModal($("#cartModal"));
    $("#factura")?.scrollIntoView({ behavior: "smooth" });
  });
  ["#clearCartButton", "#clearCartModalButton"].forEach(selector => {
    $(selector)?.addEventListener("click", event => runMutation(async () => {
      await replaceStore(STORE.cart, []);
      cart = [];
      renderCart();
      renderInvoice();
      updateCartCount();
      showToast("Carrito vacio.");
    }, "No se pudo vaciar el carrito.", event.currentTarget));
  });
  $("#emitInvoiceButton")?.addEventListener("click", event => runMutation(saveOrder, "No se pudo guardar el pedido.", event.currentTarget));
  $("#printInvoiceButton")?.addEventListener("click", printSampleReceipt);
}

function bindGaming() {
  if (!$("#resultForm")) return;
  $("#resultChallenge").addEventListener("change", updateResultFields);
  $("#resultForm").addEventListener("submit", event => runMutation(() => saveManualResult(event), "No se pudo guardar el resultado.", $("#saveResultButton")));
  $("#cancelEditButton").addEventListener("click", resetResultForm);
  updateResultFields();
}

async function initialize() {
  try {
    await openDatabase();
    users = await getAll(STORE.users);
    const active = users.find(user => user.active === true) || null;
    setProfile(active);
    cart = await getAll(STORE.cart);
    renderCart();
    renderInvoice();
    updateCartCount();
    await renderResults();
    bindSharedControls();
    bindProfileForms();
    bindMenu();
    bindGaming();
  } catch (error) {
    console.error(error);
    showToast("No se pudieron cargar los datos locales. Prueba la página con Live Server.");
  }
}

initialize();
