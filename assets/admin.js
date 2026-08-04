window.PDP_ADMIN_VERSION = "16.3";
console.info("Podprosečské produkty – admin.js V16.4");

let products = [];
let orders = [];
let eggSettings = null;
let eggAvailability = null;
let businessSettings = {};
let token = sessionStorage.getItem("pdp-admin-token") || "";
let requestTimer = null;
let activePost = null;
let postCooldown = false;
const postQueue = [];

const $ = selector => document.querySelector(selector);
const money = value => `${Number(value || 0)} Kč`;
const esc = value => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");

function url() {
  return window.PDP_CONFIG && String(window.PDP_CONFIG.APPS_SCRIPT_URL || "").trim();
}

function dataSelector(name, value) {
  return `[data-${name}="${CSS.escape(String(value))}"]`;
}

function localDate(value) {
  if (!value) return "Bez termínu";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("cs-CZ");
}

function showLogin(message = "") {
  $("#adminLogin").classList.remove("hidden");
  $("#adminApp").classList.add("hidden");
  $("#loginMessage").textContent = message;
  const button = $("#loginButton");
  button.disabled = false;
  button.textContent = "Přihlásit";
}

function showApp() {
  $("#adminLogin").classList.add("hidden");
  $("#adminApp").classList.remove("hidden");
}

function post(action, payload, callback) {
  postQueue.push({ action, payload: payload || {}, callback });
  processPostQueue();
}

function processPostQueue() {
  if (activePost || postCooldown || !postQueue.length) return;

  const job = postQueue.shift();
  const endpoint = url();
  if (!endpoint || !endpoint.endsWith("/exec")) {
    job.callback({ ok: false, message: "Administrace není správně propojená s Apps Scriptem." });
    processPostQueue();
    return;
  }

  activePost = job;
  const form = $("#adminBackendForm");
  form.action = endpoint;
  $("#adminAction").value = job.action;
  $("#adminToken").value = token;
  $("#adminPayload").value = JSON.stringify(job.payload);

  clearTimeout(requestTimer);
  requestTimer = setTimeout(() => {
    if (activePost !== job) return;
    activePost = null;
    job.callback({
      ok: false,
      message: "Server nevrátil odpověď. Zkontrolujte nové nasazení Apps Scriptu a nastavení přístupu Kdokoli."
    });
    postCooldown = true;
    setTimeout(() => {
      postCooldown = false;
      processPostQueue();
    }, 650);
  }, 20000);

  form.submit();
}

function isTrustedAppsScriptOrigin(origin) {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" && (
      parsed.hostname === "script.google.com" ||
      parsed.hostname.endsWith(".googleusercontent.com")
    );
  } catch (_) {
    return false;
  }
}

window.addEventListener("message", event => {
  const data = event.data;
  if (!data || data.type !== "PDP_BACKEND_RESULT" || !activePost) return;

  // Apps Script zobrazuje HtmlService odpověď uvnitř vlastního vnořeného iframe.
  // Zdroj zprávy proto nemusí být přímo adminSubmitFrame.contentWindow.
  const frame = $("#adminSubmitFrame");
  const directFrameMessage = Boolean(frame && event.source === frame.contentWindow);
  if (!directFrameMessage && !isTrustedAppsScriptOrigin(event.origin)) return;

  clearTimeout(requestTimer);
  const job = activePost;
  activePost = null;
  postCooldown = true;
  job.callback(data);
  setTimeout(() => {
    postCooldown = false;
    processPostQueue();
  }, 650);
});

function login() {
  const password = $("#adminPassword").value;
  if (!password) return showLogin("Zadejte heslo.");

  const button = $("#loginButton");
  button.disabled = true;
  button.textContent = "Přihlašuji…";
  $("#loginMessage").textContent = "Ověřuji heslo…";

  post("login", { password }, data => {
    button.disabled = false;
    button.textContent = "Přihlásit";
    if (!data.ok) return showLogin(data.message);

    token = data.token;
    sessionStorage.setItem("pdp-admin-token", token);
    $("#adminPassword").value = "";
    loadData();
  });
}

function loadData() {
  if (!token) return showLogin();
  const endpoint = url();
  if (!endpoint || !endpoint.endsWith("/exec")) {
    return showLogin("Administrace není správně propojená s Apps Scriptem.");
  }

  const previous = document.getElementById("admin-data-jsonp");
  if (previous) previous.remove();

  const script = document.createElement("script");
  script.id = "admin-data-jsonp";

  window.PDP_ADMIN_DATA = data => {
    script.remove();
    if (!data || !data.ok) {
      sessionStorage.removeItem("pdp-admin-token");
      token = "";
      return showLogin(data?.message || "Přihlaste se znovu.");
    }

    products = data.products || [];
    orders = data.orders || [];
    eggSettings = data.eggSettings || null;
    eggAvailability = data.eggAvailability || null;
    businessSettings = data.businessSettings || {};
    showApp();
    renderAll();
  };

  script.src = `${endpoint}?action=adminData&token=${encodeURIComponent(token)}&callback=PDP_ADMIN_DATA&t=${Date.now()}`;
  script.onerror = () => {
    script.remove();
    showLogin("Nepodařilo se načíst administraci.");
  };
  document.head.appendChild(script);
}

function archived(order) {
  return ["Vyzvednuto", "Zrušeno"].includes(order.status);
}

function activeReservation(order) {
  return !archived(order);
}

function eggQty(order) {
  return (order.items || [])
    .filter(item => String(item.productId) === "2")
    .reduce((sum, item) => sum + Number(item.qty || 0), 0);
}

function renderStats() {
  $("#statNew").textContent = orders.filter(order => order.status === "Nová").length;
  $("#statRevenue").textContent = money(
    orders.filter(order => order.status !== "Zrušeno").reduce((sum, order) => sum + Number(order.total || 0), 0)
  );
  $("#statEggs").textContent = orders
    .filter(order => order.status !== "Zrušeno")
    .reduce((sum, order) => sum + eggQty(order), 0);
  $("#statHoney").textContent = orders
    .filter(order => order.status !== "Zrušeno")
    .flatMap(order => order.items || [])
    .filter(item => String(item.productId) === "1")
    .reduce((sum, item) => sum + Number(item.qty || 0), 0);
  $("#statEggStock").textContent = eggSettings ? eggSettings.currentStock : "—";
  $("#statEggDaily").textContent = eggSettings ? `${eggSettings.dailyProduction} / den` : "—";
  const month = new Date().toISOString().slice(0, 7);
  const monthOrders = orders.filter(order => (order.created || "").slice(0, 7) === month && order.status !== "Zrušeno");
  $("#statMonthRevenue").textContent = money(monthOrders.reduce((sum, order) => sum + Number(order.total || 0), 0));
  $("#statMonthOrders").textContent = monthOrders.length;
  $("#statPreorders").textContent = orders.filter(order => activeReservation(order) && (order.items || []).some(item => products.find(p => String(p.id) === String(item.productId))?.preorder)).length;
  $("#statCustomers").textContent = new Set(orders.filter(order => order.status !== "Zrušeno").map(order => (order.email || order.phone || order.name).toLowerCase())).size;
}

function filteredOrders() {
  const query = $("#searchOrders").value.toLowerCase();
  const status = $("#statusFilter").value;
  const archive = $("#archiveFilter").value;

  return orders.filter(order =>
    (!query || order.name.toLowerCase().includes(query) || (order.phone || "").toLowerCase().includes(query)) &&
    (!status || order.status === status) &&
    (archive === "all" || (archive === "archive" ? archived(order) : !archived(order)))
  );
}

function itemHtml(order) {
  if (order.items?.length) return order.items.map(item => `${item.qty}× ${esc(item.name)}`).join("<br>");
  return esc(order.itemsText || "");
}

function statusOptions(selected) {
  return ["Nová", "Připravuji", "Připraveno", "Vyzvednuto", "Zrušeno"]
    .map(status => `<option ${status === selected ? "selected" : ""}>${status}</option>`)
    .join("");
}

function emailSubjectForOrder(order) {
  const subjects = [];
  (order.items || []).forEach(item => {
    const product = products.find(p => String(p.id) === String(item.productId));
    const group = item.emailGroup || product?.emailGroup || (/vejce/i.test(item.name || "") ? "SLEPICKY" : /med|včel|propolis|vosk/i.test(item.name || "") ? "VCELICKY" : "FARMARI");
    const subject = group === "SLEPICKY" ? "naše slepičky" : group === "VCELICKY" ? "naše včeličky" : group === "VLASTNI" ? (item.emailText || product?.emailText || "podprosečští farmáři") : "podprosečští farmáři";
    if (subject && !subjects.includes(subject)) subjects.push(subject);
  });
  if (!subjects.length) return "podprosečští farmáři";
  if (subjects.length === 1) return subjects[0];
  if (subjects.length === 2) return subjects.join(" a ");
  return subjects.slice(0, -1).join(", ") + " a " + subjects[subjects.length - 1];
}

function renderOrders() {
  const list = filteredOrders();
  $("#ordersList").innerHTML = list.length ? list.map(order => `
    <article class="card">
      <div class="card-head">
        <div>
          <h3>${esc(order.name)} <span class="badge gray">${esc(order.orderNumber || order.id)}</span></h3>
          <div class="meta">${esc(order.created)} · ${order.contactMethod === "E-mail" ? "✉️ E-mail" : "📱 SMS"} · ${esc(order.phone || "bez telefonu")}${order.email ? ` · ${esc(order.email)}` : ""}</div>
          <div class="badges">
            <span class="badge blue">${esc(localDate(order.pickup))}</span>
            ${eggQty(order) ? `<span class="badge green">🥚 ${eggQty(order)} ks</span>` : ""}
            ${archived(order) ? '<span class="badge gray">Archiv</span>' : ""}
          </div>
        </div>
        <strong>${money(order.total)}</strong>
      </div>
      <div class="item-list">${itemHtml(order)}</div>
      ${order.note ? `<div class="meta">Poznámka zákazníka: ${esc(order.note)}</div>` : ""}${order.internalNote ? `<div class="meta"><strong>Interní poznámka:</strong> ${esc(order.internalNote)}</div>` : ""}
      ${order.splitOrder ? `<div class="split-parts"><div class="split-part"><strong>1. Dostupné produkty</strong><div class="meta">${esc(localDate(order.pickup))}</div><select class="status-select" data-regular-status="${esc(order.id)}">${statusOptions(order.regularStatus || order.status)}</select></div><div class="split-part"><strong>2. Předobjednané produkty</strong><div class="meta">${esc(localDate(order.preorderPickup))}</div><select class="status-select" data-preorder-status="${esc(order.id)}">${statusOptions(order.preorderStatus || "Nová")}</select></div></div>` : ""}
      <div class="card-bottom">
        ${order.splitOrder ? "" : `<select class="status-select" data-status="${esc(order.id)}">${statusOptions(order.status)}</select>`}
        <div class="actions">
          <button class="secondary-button" data-edit-order="${esc(order.id)}">Upravit</button>
          <button class="danger-button" data-delete-order="${esc(order.id)}">Smazat</button>
        </div>
      </div>
      <div id="oe${esc(order.id)}" class="editor">
        <div class="form-grid">
          <label><span>Jméno</span><input data-on="${esc(order.id)}" value="${esc(order.name)}"></label>
          <label><span>Telefon</span><input data-op="${esc(order.id)}" value="${esc(order.phone)}"></label>
          <label><span>E-mail</span><input data-oe="${esc(order.id)}" type="email" value="${esc(order.email || "")}"></label><label><span>Preferované upozornění</span><select data-oc="${esc(order.id)}"><option ${order.contactMethod !== "E-mail" ? "selected" : ""}>SMS</option><option ${order.contactMethod === "E-mail" ? "selected" : ""}>E-mail</option></select></label>
          <label><span>${order.splitOrder ? "Termín 1. části" : "Termín"}</span><input data-od="${esc(order.id)}" type="date" value="${esc(order.pickup)}"></label>
          ${order.splitOrder ? `<label><span>Stav 1. části</span><select data-ors="${esc(order.id)}">${statusOptions(order.regularStatus || order.status)}</select></label><label><span>Termín 2. části</span><input data-opd="${esc(order.id)}" type="date" value="${esc(order.preorderPickup || "")}"></label><label><span>Stav 2. části</span><select data-ops="${esc(order.id)}">${statusOptions(order.preorderStatus || "Nová")}</select></label>` : `<label><span>Stav</span><select data-os="${esc(order.id)}">${statusOptions(order.status)}</select></label>`}
          <div class="full">
            <span class="field-label">Položky</span>
            <div class="quantity-list">
              ${products.map(product => {
                const item = (order.items || []).find(entry => String(entry.productId) === String(product.id));
                return `<div class="quantity-row"><span>${esc(product.emoji)} ${esc(product.name)}</span><input data-oi="${esc(order.id)}-${esc(product.id)}" type="number" min="0" max="500" value="${item ? item.qty : 0}"></div>`;
              }).join("")}
            </div>
          </div>
          <label class="full"><span>Poznámka zákazníka</span><textarea data-ot="${esc(order.id)}">${esc(order.note)}</textarea></label><label class="full"><span>Interní poznámka (vidíš jen ty)</span><textarea data-oin="${esc(order.id)}">${esc(order.internalNote || "")}</textarea></label><div class="full"><span class="field-label">Komunikace</span><div class="meta">${(order.communication || []).length ? (order.communication || []).map(x => `✔ ${esc(x.text)} · ${esc(new Date(x.at).toLocaleString("cs-CZ"))}`).join("<br>") : "Zatím bez dalších zpráv."}</div></div><div class="full"><span class="field-label">Časová osa</span><div class="meta">${(order.timeline || []).length ? (order.timeline || []).map(x => `${esc(x.text)} · ${esc(new Date(x.at).toLocaleString("cs-CZ"))}`).join("<br>") : "Bez záznamu."}</div></div>
        </div>
        <div class="actions"><button class="primary-small" data-save-order="${esc(order.id)}">Uložit změny</button><button class="secondary-button" data-preview-ready="${esc(order.id)}">Náhled e-mailu</button><button class="secondary-button" data-resend-ready="${esc(order.id)}" data-part="regular">Odeslat znovu 1. část</button>${order.splitOrder ? `<button class="secondary-button" data-resend-ready="${esc(order.id)}" data-part="preorder">Odeslat znovu 2. část</button>` : ""}</div>
      </div>
    </article>`).join("") : '<div class="empty">Žádné objednávky.</div>';

  document.querySelectorAll("[data-status]").forEach(select => {
    select.onchange = () => {
      const order = orders.find(item => item.id === select.dataset.status);
      order.status = select.value;
      saveOrder(order);
    };
  });

  document.querySelectorAll("[data-regular-status]").forEach(select => {
    select.onchange = () => { const order = orders.find(item => item.id === select.dataset.regularStatus); order.regularStatus = select.value; saveOrder(order); };
  });
  document.querySelectorAll("[data-preorder-status]").forEach(select => {
    select.onchange = () => { const order = orders.find(item => item.id === select.dataset.preorderStatus); order.preorderStatus = select.value; saveOrder(order); };
  });

  document.querySelectorAll("[data-edit-order]").forEach(button => {
    button.onclick = () => document.getElementById("oe" + button.dataset.editOrder)?.classList.toggle("open");
  });

  document.querySelectorAll("[data-save-order]").forEach(button => {
    button.onclick = () => {
      const id = button.dataset.saveOrder;
      const order = orders.find(item => item.id === id);
      order.name = document.querySelector(dataSelector("on", id)).value;
      order.phone = document.querySelector(dataSelector("op", id)).value;
      order.email = document.querySelector(dataSelector("oe", id)).value;
      order.contactMethod = document.querySelector(dataSelector("oc", id)).value;
      order.pickup = document.querySelector(dataSelector("od", id)).value;
      if (order.splitOrder) {
        order.regularStatus = document.querySelector(dataSelector("ors", id)).value;
        order.preorderPickup = document.querySelector(dataSelector("opd", id)).value;
        order.preorderStatus = document.querySelector(dataSelector("ops", id)).value;
      } else {
        order.status = document.querySelector(dataSelector("os", id)).value;
      }
      order.note = document.querySelector(dataSelector("ot", id)).value;
      order.internalNote = document.querySelector(dataSelector("oin", id)).value;
      order.items = products.map(product => {
        const quantity = Number(document.querySelector(dataSelector("oi", `${id}-${product.id}`)).value) || 0;
        return { productId: String(product.id), name: product.name, qty: quantity, price: product.price };
      }).filter(item => item.qty > 0);
      saveOrder(order);
    };
  });

  document.querySelectorAll("[data-preview-ready]").forEach(button => {
    button.onclick = () => {
      const order = orders.find(item => item.id === button.dataset.previewReady);
      const subject = emailSubjectForOrder(order);
      const verb = /farmáři/i.test(subject) ? "dokončili" : "dokončily";
      alert(`Dobrý den, ${order.name.split(/\s+/)[0]},\n\n${subject} ${verb} práci.\n\nVaše objednávka je připravena k vyzvednutí.\n\nTermín: ${localDate(order.pickup)}\n\nPod Prosečí 102/2\nJablonec nad Nisou\n\nTelefon: +420 732 687 040\n\nČíslo objednávky: ${order.orderNumber || order.id}`);
    };
  });
  document.querySelectorAll("[data-resend-ready]").forEach(button => {
    button.onclick = () => {
      if (!confirm("Opravdu odeslat e-mail zákazníkovi znovu?")) return;
      post("resendReadyEmail", {id: button.dataset.resendReady, part: button.dataset.part}, data => data.ok ? (alert(data.message), loadData()) : alert(data.message));
    };
  });

  document.querySelectorAll("[data-delete-order]").forEach(button => {
    button.onclick = () => {
      if (!confirm("Opravdu smazat objednávku?")) return;
      post("deleteOrder", { id: button.dataset.deleteOrder }, data => data.ok ? loadData() : alert(data.message));
    };
  });
}

function saveOrder(order) {
  post("saveOrder", { order }, data => data.ok ? loadData() : alert(data.message));
}

function renderCalendar() {
  const groups = {};
  orders.filter(order => order.status !== "Zrušeno").forEach(order => {
    const key = order.pickup || "without";
    (groups[key] ??= []).push(order);
  });

  const keys = Object.keys(groups).sort((a, b) => a === "without" ? 1 : b === "without" ? -1 : a.localeCompare(b));
  $("#calendarList").innerHTML = keys.map(key => {
    const groupEggs = groups[key].reduce((sum, order) => sum + eggQty(order), 0);
    return `<article class="card">
      <div class="card-head">
        <h3>${key === "without" ? "Bez termínu" : localDate(key)}</h3>
        <div class="badges"><span class="badge blue">${groups[key].length} objednávek</span>${groupEggs ? `<span class="badge green">🥚 ${groupEggs} ks</span>` : ""}</div>
      </div>
      ${groups[key].map(order => `<div class="calendar-entry"><div><strong>${esc(order.name)}</strong><div class="meta">${itemHtml(order)}</div></div><div><strong>${money(order.total)}</strong><div class="meta">${esc(order.status)}</div></div></div>`).join("")}
    </article>`;
  }).join("") || '<div class="empty">Kalendář je prázdný.</div>';
}

function productBadges(product) {
  if (!product.visible) return '<span class="badge gray">Skryto</span>';
  if (product.preorder) return '<span class="badge blue">Předobjednávka</span>';
  if (product.soldOut) return '<span class="badge orange">Vyprodáno</span>';
  return '<span class="badge green">V prodeji</span>';
}

function renderProducts() {
  $("#productsList").innerHTML = products.map(product => `
    <article class="card">
      <div class="card-head">
        <div style="display:flex;gap:12px">
          <div style="font-size:36px">${esc(product.emoji)}</div>
          <div><h3>${esc(product.name)}</h3><div class="meta">${esc(product.short)}</div><div class="badges">${productBadges(product)}</div></div>
        </div>
        <button class="secondary-button" data-ep="${esc(product.id)}">Upravit</button>
      </div>
      <div id="pe${esc(product.id)}" class="editor">
        <div class="form-grid">
          <label><span>Název</span><input data-pn="${esc(product.id)}" value="${esc(product.name)}"></label>
          <label><span>Emoji</span><input data-pem="${esc(product.id)}" value="${esc(product.emoji)}"></label>
          <label><span>Cena</span><input data-pp="${esc(product.id)}" type="number" value="${product.price}"></label>
          <label><span>Jednotka</span><input data-pu="${esc(product.id)}" value="${esc(product.unit)}"></label>
          <label class="full"><span>Krátký popis</span><input data-ps="${esc(product.id)}" value="${esc(product.short)}"></label>
          <label class="full"><span>Podrobnosti</span><textarea data-pd="${esc(product.id)}">${esc(product.detail)}</textarea></label>
          <label class="full"><span>Fotografie produktu</span><input data-pimg="${esc(product.id)}" value="${esc(product.image || "")}" placeholder="assets/images/products/med.jpg nebo https://…"><small>Fotografii nahrajte do složky assets/images/products a vložte její cestu.</small></label>
          <label><span>Předpokládané naskladnění</span><input data-pr="${esc(product.id)}" type="date" value="${esc(product.restock || "")}"></label>
          <label><span>Předstih dní</span><input data-pl="${esc(product.id)}" type="number" value="${product.leadDays}"></label>
          <label class="full"><span>Rychlá tlačítka</span><input data-pq="${esc(product.id)}" value="${(product.quick || []).join(", ")}"></label>
          <label><span>Plánované množství / kapacita</span><input data-pcap="${esc(product.id)}" type="number" min="0" value="${Number(product.capacity || 0)}"></label>
          <label><span>Text v potvrzovacím e-mailu</span><select data-peg="${esc(product.id)}"><option value="SLEPICKY" ${product.emailGroup === "SLEPICKY" ? "selected" : ""}>🐔 Naše slepičky</option><option value="VCELICKY" ${product.emailGroup === "VCELICKY" ? "selected" : ""}>🐝 Naše včeličky</option><option value="FARMARI" ${product.emailGroup === "FARMARI" ? "selected" : ""}>🌿 Podprosečští farmáři</option><option value="VLASTNI" ${product.emailGroup === "VLASTNI" ? "selected" : ""}>✍️ Vlastní označení</option></select></label>
          <label class="full"><span>Vlastní označení</span><input data-pet="${esc(product.id)}" maxlength="120" value="${esc(product.emailText || "")}" placeholder="např. naše levandulová zahrada"><small>Použije se jen při volbě Vlastní označení.</small></label>
          <div><span class="field-label">Rezervováno</span><strong>${Number(product.reserved || 0)}${product.capacity ? ` / ${product.capacity}` : ""}</strong></div>
        </div>
        <div class="actions">
          <label><input data-pv="${esc(product.id)}" type="checkbox" ${product.visible ? "checked" : ""}> Zobrazovat</label>
          <label><input data-po="${esc(product.id)}" type="checkbox" ${product.soldOut ? "checked" : ""}> Vyprodáno</label>
          <label><input data-ppre="${esc(product.id)}" type="checkbox" ${product.preorder ? "checked" : ""}> Povolit předobjednávky</label>
          <button class="danger-button" data-dp="${esc(product.id)}">Smazat</button>
          <button class="primary-small" data-sp="${esc(product.id)}">Uložit</button>
        </div>
      </div>
    </article>`).join("");

  document.querySelectorAll("[data-ep]").forEach(button => {
    button.onclick = () => document.getElementById("pe" + button.dataset.ep)?.classList.toggle("open");
  });

  document.querySelectorAll("[data-sp]").forEach(button => {
    button.onclick = () => {
      const id = button.dataset.sp;
      const product = products.find(item => String(item.id) === id);
      const name = document.querySelector(dataSelector("pn", id)).value.trim();
      if (!name) return alert("Vyplňte název produktu.");
      product.name = name;
      product.emoji = document.querySelector(dataSelector("pem", id)).value;
      product.price = Number(document.querySelector(dataSelector("pp", id)).value) || 0;
      product.unit = document.querySelector(dataSelector("pu", id)).value;
      product.short = document.querySelector(dataSelector("ps", id)).value;
      product.detail = document.querySelector(dataSelector("pd", id)).value;
      product.image = document.querySelector(dataSelector("pimg", id)).value.trim();
      product.restock = document.querySelector(dataSelector("pr", id)).value;
      product.leadDays = Number(document.querySelector(dataSelector("pl", id)).value) || 0;
      product.quick = document.querySelector(dataSelector("pq", id)).value.split(",").map(value => Number(value.trim())).filter(Boolean);
      product.capacity = Number(document.querySelector(dataSelector("pcap", id)).value) || 0;
      product.emailGroup = document.querySelector(dataSelector("peg", id)).value;
      product.emailText = document.querySelector(dataSelector("pet", id)).value.trim();
      if (product.emailGroup === "VLASTNI" && !product.emailText) return alert("U vlastního textu vyplňte vlastní označení.");
      product.visible = document.querySelector(dataSelector("pv", id)).checked;
      product.soldOut = document.querySelector(dataSelector("po", id)).checked;
      product.preorder = document.querySelector(dataSelector("ppre", id)).checked;
      if (product.preorder && !product.restock) return alert("U předobjednávky vyplňte předpokládané datum naskladnění.");
      post("saveProduct", { product }, data => data.ok ? loadData() : alert(data.message));
    };
  });

  document.querySelectorAll("[data-dp]").forEach(button => {
    button.onclick = () => {
      if (!confirm("Opravdu smazat produkt?")) return;
      post("deleteProduct", { id: button.dataset.dp }, data => data.ok ? loadData() : alert(data.message));
    };
  });
}

function renderManualOrderProducts() {
  $("#manualProducts").innerHTML = products.map(product => `
    <div class="quantity-row">
      <span>${esc(product.emoji)} ${esc(product.name)} · ${money(product.price)}</span>
      <input data-mp="${esc(product.id)}" type="number" min="0" max="500" value="0">
    </div>`).join("");
}

function renderEggSettings() {
  if (!eggSettings) {
    $("#eggForecast").innerHTML = '<div class="empty">Nastavení vajec se nepodařilo načíst.</div>';
    return;
  }

  $("#eggCurrentStock").value = eggSettings.currentStock;
  $("#eggDailyProduction").value = eggSettings.dailyProduction;
  $("#eggSafetyReserve").value = eggSettings.safetyReserve;
  $("#eggPlanningDays").value = eggSettings.planningDays;
  $("#eggStockDate").textContent = localDate(eggSettings.stockDate);
  const accrual = $("#eggAccrualInfo");
  if (accrual) {
    accrual.textContent = eggSettings.elapsedDays > 0
      ? `Od posledního fyzického stavu (${localDate(eggSettings.baseDate)}) automaticky připočteno ${eggSettings.accruedEggs} vajec za ${eggSettings.elapsedDays} ${eggSettings.elapsedDays === 1 ? "den" : "dny"}.`
      : `Fyzický stav byl naposledy potvrzen dnes (${localDate(eggSettings.baseDate)}).`;
  }

  const days = eggAvailability?.days || [];
  $("#eggForecast").innerHTML = days.slice(0, 21).map(day => `
    <div class="forecast-row ${day.projectedStock < eggSettings.safetyReserve ? "forecast-warning" : ""}">
      <div><strong>${localDate(day.date)}</strong><div class="meta">Rezervováno na tento den: ${day.reserved} ks</div></div>
      <div class="forecast-values">
        <span>Stav po rezervacích <strong>${day.projectedStock}</strong></span>
        <span>Další volná kapacita <strong>${day.maxAdditional}</strong></span>
      </div>
    </div>`).join("") || '<div class="empty">Předpověď je prázdná.</div>';
}


function renderInsights() {
  const valid = orders.filter(order => order.status !== "Zrušeno");
  const productTotals = {};
  valid.forEach(order => (order.items || []).forEach(item => {
    const key = item.name || item.productId;
    productTotals[key] = (productTotals[key] || 0) + Number(item.qty || 0);
  }));
  const topProducts = Object.entries(productTotals).sort((a,b) => b[1]-a[1]).slice(0,10);
  $("#topProducts").innerHTML = topProducts.map(([name, qty], i) => `<div class="rank-row"><span>${i+1}. ${esc(name)}</span><strong>${qty}</strong></div>`).join("") || '<div class="empty">Zatím bez dat.</div>';

  const customers = {};
  valid.forEach(order => {
    const key = (order.email || order.phone || order.name).toLowerCase();
    const row = customers[key] || { name: order.name, count: 0, total: 0 };
    row.count += 1; row.total += Number(order.total || 0); customers[key] = row;
  });
  const topCustomers = Object.values(customers).sort((a,b) => b.total-a.total).slice(0,10);
  $("#topCustomers").innerHTML = topCustomers.map((c,i) => `<div class="rank-row"><span>${i+1}. ${esc(c.name)} <small>${c.count} obj.</small></span><strong>${money(c.total)}</strong></div>`).join("") || '<div class="empty">Zatím bez dat.</div>';

  const months = {};
  valid.forEach(order => {
    const key = (order.created || "").slice(0,7);
    if (key) months[key] = (months[key] || 0) + Number(order.total || 0);
  });
  const entries = Object.entries(months).sort().slice(-12);
  const max = Math.max(1, ...entries.map(x => x[1]));
  $("#monthlyRevenue").innerHTML = entries.map(([month,total]) => `<div class="bar-row"><span>${esc(month)}</span><div class="bar-track"><i style="width:${Math.round(total/max*100)}%"></i></div><strong>${money(total)}</strong></div>`).join("") || '<div class="empty">Zatím bez dat.</div>';
}

function renderBusinessSettings() {
  const s = businessSettings || {};
  $("#bannerEnabled").checked = Boolean(s.bannerEnabled);
  $("#bannerStyle").value = s.bannerStyle || "yellow";
  $("#bannerTitle").value = s.bannerTitle || "";
  $("#bannerText").value = s.bannerText || "";
  $("#bannerFrom").value = s.bannerFrom || "";
  $("#bannerTo").value = s.bannerTo || "";
  $("#ordersPaused").checked = Boolean(s.ordersPaused);
  $("#pauseFrom").value = s.pauseFrom || "";
  $("#pauseTo").value = s.pauseTo || "";
  $("#pauseMessage").value = s.pauseMessage || "";
  $("#dailyOrderLimit").value = Number(s.dailyOrderLimit || 0);
}

function renderAll() {
  renderStats();
  renderOrders();
  renderCalendar();
  renderProducts();
  renderManualOrderProducts();
  renderEggSettings();
  renderInsights();
  renderBusinessSettings();
}

document.querySelectorAll(".tab").forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll(".tab,.tab-panel").forEach(element => element.classList.remove("active"));
    tab.classList.add("active");
    $("#" + tab.dataset.tab).classList.add("active");
  };
});

["searchOrders", "statusFilter", "archiveFilter"].forEach(id => {
  $("#" + id).addEventListener(id === "searchOrders" ? "input" : "change", renderOrders);
});

$("#loginButton").onclick = login;
$("#adminPassword").onkeydown = event => { if (event.key === "Enter") login(); };
$("#logoutButton").onclick = () => {
  sessionStorage.removeItem("pdp-admin-token");
  token = "";
  showLogin("Byli jste odhlášeni.");
};

$("#showManualOrder").onclick = () => $("#manualOrderForm").classList.remove("hidden");
$("#cancelManualOrder").onclick = () => $("#manualOrderForm").classList.add("hidden");
$("#saveManualOrder").onclick = () => {
  const items = products.map(product => ({
    productId: String(product.id),
    name: product.name,
    qty: Number(document.querySelector(`[data-mp="${esc(product.id)}"]`).value) || 0,
    price: product.price
  })).filter(item => item.qty > 0);

  post("manualOrder", {
    name: $("#manualName").value,
    phone: $("#manualPhone").value,
    email: $("#manualEmail").value,
    pickup: $("#manualPickup").value,
    status: $("#manualStatus").value,
    note: $("#manualNote").value,
    items
  }, data => data.ok ? loadData() : alert(data.message));
};

$("#showProductForm").onclick = () => $("#productForm").classList.remove("hidden");
$("#cancelProductForm").onclick = () => $("#productForm").classList.add("hidden");
$("#saveNewProduct").onclick = () => {
  const name = $("#newProductName").value.trim();
  if (!name) return alert("Vyplňte název produktu.");

  const product = {
    id: String(Date.now()),
    name,
    emoji: $("#newProductEmoji").value || "📦",
    price: Number($("#newProductPrice").value) || 0,
    unit: $("#newProductUnit").value || "kus",
    short: $("#newProductShort").value,
    detail: $("#newProductDetail").value,
    image: $("#newProductImage")?.value.trim() || "",
    leadDays: Number($("#newProductLead").value) || 0,
    quick: $("#newProductQuick").value.split(",").map(value => Number(value.trim())).filter(Boolean),
    capacity: Number($("#newProductCapacity").value) || 0,
    visible: true,
    soldOut: false,
    preorder: $("#newProductPreorder")?.checked || false,
    restock: $("#newProductRestock")?.value || "",
    emailGroup: $("#newProductEmailGroup")?.value || "FARMARI",
    emailText: $("#newProductEmailText")?.value.trim() || ""
  };
  if (product.emailGroup === "VLASTNI" && !product.emailText) return alert("U vlastního textu vyplňte vlastní označení.");
  post("saveProduct", { product }, data => data.ok ? loadData() : alert(data.message));
};

$("#saveEggSettings").onclick = () => {
  const button = $("#saveEggSettings");
  button.disabled = true;
  button.textContent = "Ukládám…";

  post("saveEggSettings", {
    settings: {
      currentStock: Number($("#eggCurrentStock").value),
      dailyProduction: Number($("#eggDailyProduction").value),
      safetyReserve: Number($("#eggSafetyReserve").value),
      planningDays: Number($("#eggPlanningDays").value)
    }
  }, data => {
    button.disabled = false;
    button.textContent = "Uložit nastavení";
    if (!data.ok) return alert(data.message);
    loadData();
  });
};


$("#saveBusinessSettings").onclick = () => {
  if ($("#ordersPaused").checked) {
    if (!$("#pauseFrom").value || !$("#pauseTo").value) return alert("Vyplňte začátek i konec blokace vyzvednutí.");
    if ($("#pauseFrom").value > $("#pauseTo").value) return alert("Konec blokace nesmí být před jejím začátkem.");
  }
  const settings = {
    bannerEnabled: $("#bannerEnabled").checked,
    bannerStyle: $("#bannerStyle").value,
    bannerTitle: $("#bannerTitle").value,
    bannerText: $("#bannerText").value,
    bannerFrom: $("#bannerFrom").value,
    bannerTo: $("#bannerTo").value,
    ordersPaused: $("#ordersPaused").checked,
    pauseFrom: $("#pauseFrom").value,
    pauseTo: $("#pauseTo").value,
    pauseMessage: $("#pauseMessage").value,
    dailyOrderLimit: Number($("#dailyOrderLimit").value) || 0
  };
  post("saveBusinessSettings", { settings }, data => {
    if (!data.ok) return alert(data.message);
    businessSettings = data.settings || settings;
    alert("Nastavení webu bylo uloženo.");
    renderBusinessSettings();
  });
};

if (token) loadData();
else showLogin();
