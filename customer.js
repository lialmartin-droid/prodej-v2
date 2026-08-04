window.PDP_CUSTOMER_VERSION = "16";
console.info("Podprosečské produkty – customer.js V16");

// Produkty se nikdy nevykreslují z ukázkových hodnot.
// Stránka čeká na aktuální data z Google Tabulky, aby zákazník neviděl starou cenu.
let products = [];
let productsLoaded = false;
let productsLoadFailed = false;
let eggAvailability = null;
let availabilityBlocked = false;
let businessSettings = {};
const cart = {};

const productsEl = document.getElementById("products");
const summaryEl = document.getElementById("summary");
const totalEl = document.getElementById("totalPrice");
const countEl = document.getElementById("itemCount");
const feedbackEl = document.getElementById("feedback");
const pickupInput = document.getElementById("pickupDate");
const availabilityEl = document.getElementById("pickupAvailability");
const submitButton = document.getElementById("submitOrder");

let submissionPending = false;
let submissionFinished = false;
let submitTimeout = null;
let watchPending = null;

function backendUrl() {
  return window.PDP_CONFIG && String(window.PDP_CONFIG.APPS_SCRIPT_URL || "").trim();
}

function showProductsLoading() {
  productsLoadFailed = false;
  countEl.textContent = "Načítám…";
  productsEl.innerHTML = `
    <div class="products-loading" role="status">
      <span class="loading-spinner" aria-hidden="true"></span>
      <span>Načítám aktuální nabídku…</span>
    </div>`;
  summaryEl.className = "muted";
  summaryEl.textContent = "Nejdřív načítáme aktuální nabídku.";
  totalEl.textContent = "0 Kč";
  availabilityEl.textContent = "";
  availabilityEl.classList.add("hidden");
  submitButton.disabled = true;
}

function showProductsLoadError(message) {
  productsLoaded = false;
  productsLoadFailed = true;
  products = [];
  eggAvailability = null;
  Object.keys(cart).forEach(id => delete cart[id]);

  countEl.textContent = "Nedostupné";
  productsEl.innerHTML = "";

  const box = document.createElement("div");
  box.className = "products-load-error";
  const text = document.createElement("p");
  text.textContent = message || "Aktuální nabídku se nepodařilo načíst.";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "secondary-button";
  button.textContent = "Načíst znovu";
  button.addEventListener("click", loadProducts);
  box.append(text, button);
  productsEl.appendChild(box);

  summaryEl.className = "muted";
  summaryEl.textContent = "Objednávku lze vytvořit až po načtení aktuální nabídky.";
  totalEl.textContent = "0 Kč";
  submitButton.disabled = true;
}

function money(value) {
  return `${Number(value || 0)} Kč`;
}

function esc(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function localDate(value) {
  if (!value) return "";
  const date = new Date(`${value}T12:00:00`);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString("cs-CZ");
}

function todayKey() {
  const date = new Date();
  date.setHours(12, 0, 0, 0);
  return date.toISOString().slice(0, 10);
}

function addDaysKey(value, days) {
  const date = new Date(`${value}T12:00:00`);
  date.setDate(date.getDate() + Number(days || 0));
  return date.toISOString().slice(0, 10);
}

function activeProducts() {
  return products.filter(product => product.visible);
}

function isEggProduct(product) {
  if (String(product && product.id) === "2") return true;

  const text = `${product?.emoji || ""} ${product?.name || ""} ${product?.short || ""} ${product?.detail || ""}`
    .toLocaleLowerCase("cs-CZ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  return text.includes("🥚") || text.includes("vejce") || text.includes("vajick");
}

function normalizeQuickButtons(value) {
  const source = Array.isArray(value) ? value : String(value || "").split(",");
  return [...new Set(source
    .map(item => Number(String(item).trim()))
    .filter(item => Number.isFinite(item) && item > 0)
    .map(item => Math.floor(item))
  )];
}

function quickButtonsForProduct(product) {
  if (isEggProduct(product)) return [6, 10, 30];
  return normalizeQuickButtons(product && product.quick);
}

function normalizeProducts(input) {
  return input.map(product => ({
    ...product,
    id: String(product.id),
    price: Number(product.price || 0),
    leadDays: isEggProduct(product) ? 0 : Math.max(0, Number(product.leadDays || 0)),
    preorder: Boolean(product.preorder),
    restock: String(product.restock || ""),
    capacity: Math.max(0, Number(product.capacity || 0)),
    reserved: Math.max(0, Number(product.reserved || 0)),
    quick: quickButtonsForProduct(product)
  }));
}

function appendJsonp(url, callbackName, onError) {
  const previous = document.getElementById(`jsonp-${callbackName}`);
  if (previous) previous.remove();

  const script = document.createElement("script");
  script.id = `jsonp-${callbackName}`;
  script.src = url;
  script.onerror = () => {
    script.remove();
    if (onError) onError();
  };
  document.head.appendChild(script);
}

function loadProducts() {
  const url = backendUrl();
  const hadCurrentProducts = productsLoaded && products.length > 0;

  if (!hadCurrentProducts) showProductsLoading();

  if (!url || !url.endsWith("/exec")) {
    showProductsLoadError("Aktuální nabídku se nepodařilo načíst – chybí propojení se serverem.");
    return;
  }

  let finished = false;
  const timeout = setTimeout(() => {
    if (finished) return;
    finished = true;
    if (hadCurrentProducts) {
      feedbackEl.textContent = "Aktuální nabídku se nepodařilo obnovit. Zobrazená data zůstala beze změny.";
    } else {
      showProductsLoadError("Načtení aktuální nabídky trvá příliš dlouho. Zkuste to znovu.");
    }
  }, 20000);

  window.PDP_PRODUCTS_CALLBACK = data => {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);

    if (!data || !data.ok || !Array.isArray(data.products)) {
      if (hadCurrentProducts) {
        feedbackEl.textContent = "Aktuální nabídku se nepodařilo obnovit. Zobrazená data zůstala beze změny.";
      } else {
        showProductsLoadError("Server nevrátil aktuální nabídku. Zkuste načtení zopakovat.");
      }
      return;
    }

    products = normalizeProducts(data.products);
    eggAvailability = data.availability || null;
    businessSettings = data.settings || {};
    renderPublicBanner();
    productsLoaded = true;
    productsLoadFailed = false;

    Object.keys(cart).forEach(id => {
      const product = products.find(item => String(item.id) === String(id));
      if (!product || !product.visible || (product.soldOut && !product.preorder)) delete cart[id];
    });

    renderAll();
  };

  appendJsonp(
    `${url}?action=products&callback=PDP_PRODUCTS_CALLBACK&t=${Date.now()}`,
    "PDP_PRODUCTS_CALLBACK",
    () => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (hadCurrentProducts) {
        feedbackEl.textContent = "Aktuální nabídku se nepodařilo obnovit. Zobrazená data zůstala beze změny.";
      } else {
        showProductsLoadError("Aktuální nabídku se nepodařilo načíst. Zkontrolujte připojení a zkuste to znovu.");
      }
    }
  );
}

function eggQuantity() {
  return Object.entries(cart).reduce((sum, [id, quantity]) => {
    const product = products.find(item => String(item.id) === String(id));
    return sum + (product && isEggProduct(product) ? Number(quantity || 0) : 0);
  }, 0);
}

function pickupBlockActive() {
  return Boolean(businessSettings.ordersPaused && businessSettings.pauseFrom && businessSettings.pauseTo);
}

function isPickupDateBlocked(dateKey) {
  if (!pickupBlockActive() || !dateKey) return false;
  return dateKey >= businessSettings.pauseFrom && dateKey <= businessSettings.pauseTo;
}

function nextPickupDateOutsideBlock(dateKey) {
  if (!isPickupDateBlocked(dateKey)) return dateKey;
  return addDaysKey(businessSettings.pauseTo, 1);
}

function vacationNoticeText() {
  if (!pickupBlockActive()) return "";
  const firstAfter = addDaysKey(businessSettings.pauseTo, 1);
  return businessSettings.pauseMessage || `V době od ${localDate(businessSettings.pauseFrom)} do ${localDate(businessSettings.pauseTo)} nebude možné objednávky vyzvednout. Nejbližší vyzvednutí po dovolené je ${localDate(firstAfter)}.`;
}

function remainingCapacity(product) {
  if (!product || !product.capacity) return 500;
  return Math.max(0, Math.floor(product.capacity - product.reserved));
}

function nonEggLeadMinimum() {
  let minimum = todayKey();

  Object.entries(cart).forEach(([id, quantity]) => {
    if (!quantity) return;
    const product = products.find(item => String(item.id) === String(id));
    if (!product || isEggProduct(product)) return;

    const leadMinimum = addDaysKey(todayKey(), Number(product.leadDays || 0));
    if (leadMinimum > minimum) minimum = leadMinimum;
    if (product.preorder && selectedSplitMode() !== "split" && product.restock && product.restock > minimum) minimum = product.restock;
  });

  return nextPickupDateOutsideBlock(minimum);
}

function calculatePickupMinimum() {
  const leadMinimum = nonEggLeadMinimum();
  const eggs = eggQuantity();

  if (!eggs) {
    return { minimum: leadMinimum, blocked: false, message: "" };
  }

  if (!eggAvailability || !Array.isArray(eggAvailability.days)) {
    return {
      minimum: leadMinimum,
      blocked: false,
      message: "Dostupnost vajec se ověřuje při odeslání objednávky."
    };
  }

  const earliest = eggAvailability.days.find(day =>
    day.date >= leadMinimum && !isPickupDateBlocked(day.date) && Number(day.maxAdditional || 0) >= eggs
  );

  if (!earliest) {
    return {
      minimum: "",
      blocked: true,
      message: `Požadovaných ${eggs} vajec nelze při současné snášce zajistit během následujících ${eggAvailability.planningDays || 60} dní.`
    };
  }

  return {
    minimum: earliest.date,
    blocked: false,
    message: `Nejbližší možný termín vyzvednutí je ${localDate(earliest.date)}.`
  };
}

function updatePickupAvailability() {
  if (!productsLoaded) {
    availabilityBlocked = true;
    availabilityEl.textContent = "";
    availabilityEl.classList.add("hidden");
    submitButton.disabled = true;
    return;
  }

  const result = calculatePickupMinimum();
  availabilityBlocked = result.blocked;

  pickupInput.min = result.minimum || todayKey();
  const hasEggs = eggQuantity() > 0;
  if (hasEggs && eggAvailability && eggAvailability.horizonEnd) pickupInput.max = eggAvailability.horizonEnd;
  else pickupInput.removeAttribute("max");

  if (result.minimum && (!pickupInput.value || pickupInput.value < result.minimum)) {
    pickupInput.value = result.minimum;
  }

  const eggNotices = document.querySelectorAll("[data-egg-pickup-notice]");
  let productMessage = "Po zvolení počtu vajec se zobrazí nejbližší možný termín vyzvednutí.";

  if (hasEggs) {
    if (result.blocked) {
      productMessage = result.message;
    } else if (result.minimum) {
      productMessage = `Nejbližší možný termín vyzvednutí je ${localDate(result.minimum)}.`;
    } else {
      productMessage = "Nejbližší termín vyzvednutí se ověří při odeslání objednávky.";
    }
  }

  eggNotices.forEach(notice => {
    notice.textContent = productMessage;
    notice.classList.toggle("notice-error", Boolean(result.blocked));
  });

  if (result.blocked) {
    availabilityEl.textContent = result.message;
    availabilityEl.classList.remove("hidden");
    availabilityEl.classList.add("availability-error");
  } else {
    availabilityEl.textContent = "";
    availabilityEl.classList.add("hidden");
    availabilityEl.classList.remove("availability-error");
  }

  if (pickupBlockActive()) {
    const vacationText = vacationNoticeText();
    if (vacationText) {
      availabilityEl.textContent = vacationText;
      availabilityEl.classList.remove("hidden");
      availabilityEl.classList.remove("availability-error");
    }
  }
  submitButton.disabled = submissionPending || availabilityBlocked;
}

function formatRestock(value) {
  return localDate(value);
}


function preorderProductsInCart() {
  return Object.entries(cart).map(([id, qty]) => {
    const product = products.find(item => String(item.id) === String(id));
    return product && qty > 0 && product.preorder ? product : null;
  }).filter(Boolean);
}

function regularProductsInCart() {
  return Object.entries(cart).map(([id, qty]) => {
    const product = products.find(item => String(item.id) === String(id));
    return product && qty > 0 && !product.preorder ? product : null;
  }).filter(Boolean);
}

function selectedSplitMode() {
  return document.querySelector('input[name="splitOrder"]:checked')?.value || "together";
}

function selectedContactMethod() {
  return document.querySelector('input[name="contactMethod"]:checked')?.value || "SMS";
}

function latestPreorderDate() {
  const date = preorderProductsInCart().map(p => p.restock || p.preorderDate || "").filter(Boolean).sort().pop() || "";
  return nextPickupDateOutsideBlock(date);
}

function renderSplitOptions(forceNearest = false) {
  const mixed = preorderProductsInCart().length > 0 && regularProductsInCart().length > 0;
  const box = document.getElementById("splitOrderBox");
  if (box) box.classList.toggle("hidden", !mixed);
  if (!mixed) {
    const together = document.querySelector('input[name="splitOrder"][value="together"]');
    if (together) together.checked = true;
  }
  const isSplit = mixed && selectedSplitMode() === "split";
  const label = document.getElementById("pickupDateLabel");
  if (label) label.textContent = isSplit ? "Termín prvního vyzvednutí" : "Termín vyzvednutí";
  const summary = document.getElementById("splitPickupSummary");
  if (summary) {
    summary.classList.toggle("hidden", !isSplit);
    if (isSplit) {
      const rules = calculatePickupMinimum();
      const second = latestPreorderDate();
      summary.innerHTML = `<strong>Objednávka bude rozdělena:</strong><br>1. dostupné produkty: ${rules.minimum ? esc(localDate(rules.minimum)) : "nejbližší možný termín"}<br>2. předobjednané produkty: ${second ? esc(localDate(second)) : "po naskladnění"}`;
      if (forceNearest && rules.minimum) {
        pickupInput.value = rules.minimum;
        feedbackEl.textContent = `První vyzvednutí bylo automaticky nastaveno na nejbližší možný termín ${localDate(rules.minimum)}.`;
      }
    }
  }
}

function renderPublicBanner() {
  const el = document.getElementById("publicBanner");
  if (!el) return;
  const today = todayKey();
  const activeByDate = (!businessSettings.bannerFrom || today >= businessSettings.bannerFrom) &&
    (!businessSettings.bannerTo || today <= businessSettings.bannerTo);
  if (businessSettings.bannerEnabled && activeByDate && (businessSettings.bannerTitle || businessSettings.bannerText)) {
    el.className = `public-banner ${businessSettings.bannerStyle || "yellow"}`;
    el.innerHTML = `${businessSettings.bannerTitle ? `<strong>${esc(businessSettings.bannerTitle)}</strong>` : ""}${businessSettings.bannerText ? `<p>${esc(businessSettings.bannerText)}</p>` : ""}`;
  } else {
    el.className = "public-banner hidden";
    el.innerHTML = "";
  }
}

function ordersArePaused() {
  return false;
}

function subscribeStockWatch(product, article) {
  const input = article.querySelector("[data-watch-email]");
  const feedback = article.querySelector("[data-watch-feedback]");
  const email = String(input?.value || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    feedback.textContent = "Zadejte platnou e-mailovou adresu.";
    input?.focus();
    return;
  }
  const form = document.getElementById("backendOrderForm");
  form.action = backendUrl();
  form.querySelector('[name="action"]').value = "subscribeStock";
  document.getElementById("backendPayload").value = JSON.stringify({ productId: String(product.id), email });
  feedback.textContent = "Ukládám hlídání…";
  watchPending = { feedback, input };
  form.submit();
  setTimeout(() => {
    if (watchPending && watchPending.feedback === feedback) {
      feedback.textContent = "Potvrzení trvá déle. Zkuste hlídání případně odeslat znovu.";
      watchPending = null;
    }
  }, 20000);
}

function renderProducts() {
  if (!productsLoaded) {
    if (!productsLoadFailed) showProductsLoading();
    return;
  }

  productsEl.innerHTML = "";

  const visibleProducts = activeProducts();
  if (!visibleProducts.length) {
    productsEl.innerHTML = '<div class="empty">Momentálně nejsou k dispozici žádné produkty.</div>';
  }

  visibleProducts.forEach(product => {
    const article = document.createElement("article");
    article.className = "product";
    article.dataset.productId = String(product.id);
    const imageSrc = product.image || "assets/images/products/placeholder.jpg";
    article.innerHTML = `
      <div class="product-row">
        <div class="product-media"><img src="${esc(imageSrc)}" alt="${esc(product.name)}" loading="lazy" onerror="this.src='assets/images/products/placeholder.jpg'"></div>
        <div class="product-body">
          <h3>${esc(product.name)}</h3>
          <p class="lead">${esc(product.short)}</p>
          <div class="story">${esc(product.detail)}</div>
          <div class="price">${money(product.price)} <small>/ ${esc(product.unit)}</small></div>
          ${isEggProduct(product) ? `<div class="notice" data-egg-pickup-notice>Po zvolení počtu vajec se zobrazí nejbližší možný termín vyzvednutí.</div>` : ""}
          ${!isEggProduct(product) && product.leadDays ? `<div class="notice">Tento produkt je potřeba objednat minimálně ${Math.max(0, Math.floor(Number(product.leadDays) || 0))} dní předem.</div>` : ""}
          ${product.preorder ? `<div class="notice"><strong>Předobjednávka.</strong> Předpokládané naskladnění: ${product.restock ? esc(formatRestock(nextPickupDateOutsideBlock(product.restock))) : "termín bude upřesněn"}.${product.capacity ? ` K rezervaci zbývá <strong>${Math.max(0, product.capacity - product.reserved)} z ${product.capacity} ${esc(product.unit)}</strong>.` : ""}</div>` : (product.soldOut ? `<div class="notice">Momentálně vyprodáno${product.restock ? `. Předpokládané doplnění: ${esc(formatRestock(product.restock))}.` : "."}</div><div class="stock-watch"><strong>Hlídací pes</strong><p class="field-help">Pošleme vám jednorázový e-mail, až bude produkt znovu skladem.</p><div class="watch-row"><input type="email" data-watch-email placeholder="vas@email.cz"><button type="button" data-watch-button>Hlídat naskladnění</button></div><div class="field-help" data-watch-feedback></div></div>` : "")}
          <div class="product-controls"></div>
        </div>
      </div>`;

    productsEl.appendChild(article);

    const watchButton = article.querySelector("[data-watch-button]");
    if (watchButton) {
      watchButton.addEventListener("click", () => subscribeStockWatch(product, article));
    }
    const controls = article.querySelector(".product-controls");
    if (product.soldOut && !product.preorder) return;

    const quickAmounts = quickButtonsForProduct(product);
    if (quickAmounts.length) {
      const label = document.createElement("div");
      label.className = "muted";
      label.style.marginTop = "18px";
      label.textContent = "Rychlé přidání";
      controls.appendChild(label);

      const quickGrid = document.createElement("div");
      quickGrid.className = "quick-grid";

      quickAmounts.forEach(amount => {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = `+ ${amount} ks`;
        button.addEventListener("click", () => changeQty(product.id, amount));
        quickGrid.appendChild(button);
      });

      controls.appendChild(quickGrid);
    }

    const row = document.createElement("div");
    row.className = "qty-row";
    const quantityLabel = document.createElement("span");
    quantityLabel.className = "muted";
    quantityLabel.textContent = product.unit === "kus" ? "Celkový počet kusů" : "Množství";
    row.appendChild(quantityLabel);

    const stepper = document.createElement("div");
    stepper.className = "stepper";

    const minus = document.createElement("button");
    minus.className = "round-button";
    minus.type = "button";
    minus.textContent = "−";
    minus.addEventListener("click", () => changeQty(product.id, -1));

    const input = document.createElement("input");
    input.className = "qty-input";
    input.type = "number";
    input.min = "0";
    input.max = String(remainingCapacity(product));
    input.step = "1";
    input.inputMode = "numeric";
    input.dataset.qtyId = String(product.id);
    input.value = cart[product.id] || 0;
    input.addEventListener("input", () => setQty(product.id, input.value));
    input.addEventListener("blur", () => { input.value = cart[product.id] || 0; });

    const plus = document.createElement("button");
    plus.className = "round-button";
    plus.type = "button";
    plus.textContent = "+";
    plus.addEventListener("click", () => changeQty(product.id, 1));

    stepper.append(minus, input, plus);
    row.appendChild(stepper);
    controls.appendChild(row);
  });
}

function updateQuantityInput(id) {
  const input = document.querySelector(`[data-qty-id="${CSS.escape(String(id))}"]`);
  if (input) input.value = cart[id] || 0;
}

function changeQty(id, amount) {
  const product = products.find(item => String(item.id) === String(id));
  const limit = remainingCapacity(product);
  const requested = Math.max(0, (cart[id] || 0) + amount);
  cart[id] = Math.min(limit, requested);
  if (requested > limit) feedbackEl.textContent = `U produktu ${product.name} lze nyní rezervovat nejvýše ${limit} ${product.unit}.`;
  if (!cart[id]) delete cart[id];
  updateQuantityInput(id);
  renderSummary();
}

function setQty(id, value) {
  const product = products.find(item => String(item.id) === String(id));
  const limit = remainingCapacity(product);
  const requested = Math.max(0, Math.floor(Number(value) || 0));
  const quantity = Math.min(limit, requested);
  if (requested > limit) feedbackEl.textContent = `U produktu ${product.name} lze nyní rezervovat nejvýše ${limit} ${product.unit}.`;
  if (quantity) cart[id] = quantity;
  else delete cart[id];
  renderSummary();
}

function renderSummary() {
  if (!productsLoaded) {
    countEl.textContent = productsLoadFailed ? "Nedostupné" : "Načítám…";
    summaryEl.className = "muted";
    summaryEl.textContent = productsLoadFailed
      ? "Objednávku lze vytvořit až po načtení aktuální nabídky."
      : "Nejdřív načítáme aktuální nabídku.";
    totalEl.textContent = "0 Kč";
    submitButton.disabled = true;
    return;
  }

  const entries = Object.entries(cart);
  const count = entries.reduce((sum, [, quantity]) => sum + quantity, 0);
  countEl.textContent = `${count} ${count === 1 ? "položka" : count > 1 && count < 5 ? "položky" : "položek"}`;

  if (!entries.length) {
    summaryEl.className = "muted";
    summaryEl.textContent = "Zatím nemáte nic vybráno.";
    totalEl.textContent = "0 Kč";
  } else {
    summaryEl.className = "";
    summaryEl.innerHTML = "";
    let total = 0;

    entries.forEach(([id, quantity]) => {
      const product = products.find(item => String(item.id) === String(id));
      if (!product) return;
      const rowTotal = product.price * quantity;
      total += rowTotal;
      const row = document.createElement("div");
      row.className = "summary-row";
      const label = document.createElement("span");
      const price = document.createElement("strong");
      label.textContent = `${quantity}× ${product.name}`;
      price.textContent = money(rowTotal);
      row.append(label, price);
      summaryEl.appendChild(row);
    });

    totalEl.textContent = money(total);
  }

  const mobileCartBar = document.getElementById("mobileCartBar");
  const mobileCartText = document.getElementById("mobileCartText");
  if (mobileCartBar && mobileCartText) {
    const total = entries.reduce((sum, [id, quantity]) => {
      const product = products.find(item => String(item.id) === String(id));
      return sum + (product ? product.price * quantity : 0);
    }, 0);
    mobileCartBar.classList.toggle("hidden", count <= 0);
    mobileCartText.textContent = `${count} ${count === 1 ? "položka" : count < 5 ? "položky" : "položek"} · ${money(total)}`;
  }

  renderSplitOptions();
  updatePickupAvailability();
}

function renderAll() {
  renderProducts();
  renderSummary();
}

function finish(success, message) {
  if (submissionFinished) return;

  submissionFinished = true;
  submissionPending = false;
  clearTimeout(submitTimeout);
  submitButton.textContent = "Odeslat objednávku";
  feedbackEl.textContent = message;

  if (success) {
    Object.keys(cart).forEach(key => delete cart[key]);
    ["customerName", "customerPhone", "customerEmail", "pickupDate", "customerNote"].forEach(id => {
      document.getElementById(id).value = "";
    });
    loadProducts();
  } else {
    submitButton.disabled = availabilityBlocked;
    loadProducts();
  }
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
  if ((!submissionPending && !watchPending) || !data || data.type !== "PDP_BACKEND_RESULT") return;

  // HtmlService vrací výsledek z vnořeného rámce Googlu. Zdroj proto
  // nemusí být přímo orderSubmitFrame.contentWindow.
  const frame = document.getElementById("orderSubmitFrame");
  const directFrameMessage = Boolean(frame && event.source === frame.contentWindow);
  if (!directFrameMessage && !isTrustedAppsScriptOrigin(event.origin)) return;

  if (watchPending) {
    watchPending.feedback.textContent = data.ok ? "Hlídací pes je zapnutý. Až bude produkt skladem, přijde vám jednorázový e-mail." : (data.message || "Hlídacího psa se nepodařilo zapnout.");
    if (data.ok) watchPending.input.value = "";
    watchPending = null;
    return;
  }
  finish(Boolean(data.ok), data.ok ? "Objednávka byla odeslána. Brzy se vám ozveme." : (data.message || "Objednávku se nepodařilo odeslat."));
});

submitButton.addEventListener("click", () => {
  if (!productsLoaded) {
    feedbackEl.textContent = "Počkejte na načtení aktuální nabídky.";
    return;
  }

  const items = Object.entries(cart)
    .map(([id, quantity]) => {
      const product = products.find(item => String(item.id) === String(id));
      return product
        ? { productId: String(product.id), name: product.name, qty: quantity, price: product.price }
        : null;
    })
    .filter(Boolean);

  const name = document.getElementById("customerName").value.trim();
  const phone = document.getElementById("customerPhone").value.trim();
  const emailInput = document.getElementById("customerEmail");
  const email = emailInput.value.trim().toLowerCase();
  const pickup = pickupInput.value;
  const note = document.getElementById("customerNote").value.trim();
  const pickupRules = calculatePickupMinimum();

  if (!items.length) return feedbackEl.textContent = "Nejprve vyberte alespoň jeden produkt.";
  if (!name) return feedbackEl.textContent = "Vyplňte jméno.";
  if (!phone) return feedbackEl.textContent = "Vyplňte telefon.";
  if (!email) return feedbackEl.textContent = "Vyplňte e-mail.";
  if (!emailInput.checkValidity() || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    emailInput.focus();
    return feedbackEl.textContent = "Zadejte platnou e-mailovou adresu.";
  }
  if (pickupRules.blocked) return feedbackEl.textContent = pickupRules.message;
  if (!pickup) return feedbackEl.textContent = "Vyberte termín vyzvednutí.";
  if (isPickupDateBlocked(pickup)) return feedbackEl.textContent = `V tomto termínu nebude možné objednávku vyzvednout. Zvolte nejdříve ${localDate(addDaysKey(businessSettings.pauseTo, 1))}.`;
  if (pickupRules.minimum && pickup < pickupRules.minimum) {
    return feedbackEl.textContent = `Nejbližší možný termín je ${localDate(pickupRules.minimum)}.`;
  }
  if (eggQuantity() > 0 && eggAvailability && eggAvailability.horizonEnd && pickup > eggAvailability.horizonEnd) {
    return feedbackEl.textContent = `Termín vajec lze zvolit nejvýše do ${localDate(eggAvailability.horizonEnd)}.`;
  }

  const url = backendUrl();
  if (!url || !url.endsWith("/exec")) {
    feedbackEl.textContent = "Odesílání není správně propojené.";
    return;
  }

  const form = document.getElementById("backendOrderForm");
  const payload = document.getElementById("backendPayload");

  form.action = url;
  form.querySelector('[name="action"]').value = "createOrder";
  const splitMode = selectedSplitMode();
  const preorderPickup = latestPreorderDate();
  const contactMethod = selectedContactMethod();
  payload.value = JSON.stringify({
    name, phone, email, pickup, note, source: "Web", items,
    contactMethod,
    splitOrder: splitMode === "split",
    preorderPickup: preorderPickup
  });

  submissionPending = true;
  submissionFinished = false;
  submitButton.disabled = true;
  submitButton.textContent = "Odesílám…";
  feedbackEl.textContent = "Odesílám objednávku a ověřuji dostupnost…";
  form.submit();

  clearTimeout(submitTimeout);
  submitTimeout = setTimeout(() => {
    if (submissionPending && !submissionFinished) {
      submissionPending = false;
      submitButton.disabled = availabilityBlocked;
      submitButton.textContent = "Odeslat objednávku";
      feedbackEl.textContent = "Nepodařilo se potvrdit odeslání. Před opakováním zkontrolujte e-mail nebo tabulku.";
    }
  }, 25000);
});

document.querySelectorAll('input[name="splitOrder"]').forEach(input => input.addEventListener("change", () => {
  renderSplitOptions(selectedSplitMode() === "split");
  updatePickupAvailability();
}));
pickupInput.addEventListener("change", () => {
  const rules = calculatePickupMinimum();
  if (isPickupDateBlocked(pickupInput.value)) {
    const next = addDaysKey(businessSettings.pauseTo, 1);
    pickupInput.value = next;
    feedbackEl.textContent = `Zvolený termín spadá do dovolené. Termín byl změněn na ${localDate(next)}.`;
  } else if (rules.minimum && pickupInput.value < rules.minimum) {
    feedbackEl.textContent = `Nejbližší možný termín je ${localDate(rules.minimum)}.`;
    pickupInput.value = rules.minimum;
  }
});

showProductsLoading();
loadProducts();
