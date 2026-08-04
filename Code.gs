/**
 * Podprosečské domácí produkty — sdílený backend V16
 * Produkty, objednávky a plánování dostupnosti vajec jsou uloženy v jedné Google Tabulce.
 */
const CONFIG = Object.freeze({
  NOTIFICATION_EMAIL: 'podprosecskeprodukty@gmail.com',
  ORDERS_SHEET: 'Objednávky',
  PRODUCTS_SHEET: 'Produkty',
  SETTINGS_SHEET: 'Nastavení',
  WATCHLIST_SHEET: 'Hlídací pes',
  BRAND_NAME: 'Podprosečské domácí produkty',
  TIME_ZONE: 'Europe/Prague',
  SESSION_SECONDS: 21600,
  MAX_ITEMS: 20,
  MAX_QUANTITY_PER_ITEM: 500,
  ORDER_STATUSES: Object.freeze(['Nová', 'Připravuji', 'Připraveno', 'Vyzvednuto', 'Zrušeno']),
  EGG_PRODUCT_ID: '2',
  DEFAULT_EGG_STOCK: 0,
  DEFAULT_EGG_DAILY_PRODUCTION: 10,
  DEFAULT_EGG_SAFETY_RESERVE: 0,
  DEFAULT_EGG_PLANNING_DAYS: 60
});

function setup() {
  const orders = getOrCreateSheet_(CONFIG.ORDERS_SHEET);
  const products = getOrCreateSheet_(CONFIG.PRODUCTS_SHEET);
  const settings = getOrCreateSheet_(CONFIG.SETTINGS_SHEET);
  const watchlist = getOrCreateSheet_(CONFIG.WATCHLIST_SHEET);

  formatOrdersSheet_(orders);
  ensureOrderNumbers_(orders);
  formatProductsSheet_(products);
  formatSettingsSheet_(settings);
  formatWatchlistSheet_(watchlist);
  seedProducts_(products);
  repairDefaultProductSettings_(products);
  seedEggSettings_(settings);
  normalizeEggStockDateSetting_(settings);

  const props = PropertiesService.getScriptProperties();
  let password = props.getProperty('ADMIN_PASSWORD');
  if (!password) {
    password = generatePassword_();
    props.setProperty('ADMIN_PASSWORD', password);
  }

  MailApp.sendEmail({
    to: CONFIG.NOTIFICATION_EMAIL,
    subject: 'Administrace připravena – ' + CONFIG.BRAND_NAME,
    body: [
      'Google Apps Script je připravený.',
      '',
      'Heslo do administrace:',
      password,
      '',
      'Heslo si bezpečně uložte. Změnit ho lze funkcí changeAdminPassword().',
      '',
      'V administraci nyní najdete také záložku Vejce, kde nastavíte aktuální sklad a denní snášku.'
    ].join('\n'),
    name: CONFIG.BRAND_NAME
  });
}

/** Před spuštěním změňte hodnotu uvnitř uvozovek. */
function changeAdminPassword() {
  const newPassword = 'SEM_NAPISTE_NOVE_HESLO';
  if (!newPassword || newPassword === 'SEM_NAPISTE_NOVE_HESLO' || newPassword.length < 8) {
    throw new Error('Zadejte nové heslo dlouhé alespoň 8 znaků.');
  }

  const props = PropertiesService.getScriptProperties();
  props.setProperty('ADMIN_PASSWORD', newPassword);
  props.setProperty('SESSION_VERSION', Utilities.getUuid());

  MailApp.sendEmail({
    to: CONFIG.NOTIFICATION_EMAIL,
    subject: 'Heslo administrace změněno',
    body: 'Nové heslo bylo úspěšně nastaveno. Všechna předchozí přihlášení byla odhlášena.',
    name: CONFIG.BRAND_NAME
  });
}

function doGet(e) {
  try {
    const action = cleanText_(e && e.parameter && e.parameter.action || 'health', 40);

    if (action === 'products') {
      return jsonpResponse_(e, {
        ok: true,
        products: readProducts_(),
        availability: publicEggAvailability_(),
        settings: publicBusinessSettings_()
      });
    }

    if (action === 'availability') {
      return jsonpResponse_(e, {
        ok: true,
        availability: publicEggAvailability_()
      });
    }

    if (action === 'adminData') {
      requireToken_(e.parameter.token || '');
      const availability = buildEggAvailability_('');
      return jsonpResponse_(e, {
        ok: true,
        products: readProducts_(),
        orders: readOrders_(),
        eggSettings: availability.settings,
        eggAvailability: availability,
        businessSettings: publicBusinessSettings_()
      });
    }

    return jsonpResponse_(e, {
      ok: true,
      service: CONFIG.BRAND_NAME,
      version: '16.3',
      time: new Date().toISOString()
    });
  } catch (error) {
    console.error(error);
    return jsonpResponse_(e, { ok: false, message: error.message || 'Chyba serveru.' });
  }
}

function doPost(e) {
  const lock = LockService.getScriptLock();

  try {
    lock.waitLock(15000);
    const action = cleanText_(e && e.parameter && e.parameter.action || 'createOrder', 40);
    const payload = JSON.parse(e && e.parameter && e.parameter.payload || '{}');

    if (action === 'login') return login_(payload);
    if (action === 'createOrder') return createOrder_(payload, false);
    if (action === 'subscribeStock') return subscribeStock_(payload);

    const token = cleanText_(e.parameter.token || payload.token || '', 100);
    requireToken_(token);

    if (action === 'saveProduct') return saveProduct_(payload);
    if (action === 'deleteProduct') return deleteProduct_(payload);
    if (action === 'saveOrder') return saveOrder_(payload);
    if (action === 'deleteOrder') return deleteOrder_(payload);
    if (action === 'manualOrder') return createOrder_(payload, true);
    if (action === 'saveEggSettings') return saveEggSettings_(payload);
    if (action === 'saveBusinessSettings') return saveBusinessSettings_(payload);
    if (action === 'resendReadyEmail') return resendReadyEmail_(payload);

    throw new Error('Neznámá operace.');
  } catch (error) {
    console.error(error);
    return htmlResponse_(false, error.message || 'Operaci se nepodařilo dokončit.', '', {});
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function login_(payload) {
  const password = cleanText_(payload.password, 200);
  const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSWORD');
  if (!expected) throw new Error('Nejdříve spusťte funkci setup().');
  if (password !== expected) throw new Error('Nesprávné heslo.');

  const token = Utilities.getUuid().replace(/-/g, '');
  const sessionVersion = getSessionVersion_();
  CacheService.getScriptCache().put('session:' + token, sessionVersion, CONFIG.SESSION_SECONDS);
  return htmlResponse_(true, 'Přihlášení bylo úspěšné.', '', { token: token });
}

function requireToken_(token) {
  const cachedVersion = token ? CacheService.getScriptCache().get('session:' + token) : '';
  if (!cachedVersion || cachedVersion !== getSessionVersion_()) {
    throw new Error('Přihlášení vypršelo. Přihlaste se znovu.');
  }
}

function getSessionVersion_() {
  const props = PropertiesService.getScriptProperties();
  let version = props.getProperty('SESSION_VERSION');
  if (!version) {
    version = Utilities.getUuid();
    props.setProperty('SESSION_VERSION', version);
  }
  return version;
}

function createOrder_(payload, manual) {
  const order = validateOrder_(payload, manual);
  validatePickupRules_(order, '');
  if (!manual) validateBusinessRules_(order);

  const fulfilledQty = isFulfilledStatus_(order.status) ? eggQtyFromItems_(order.items) : 0;
  if (fulfilledQty > 0) ensureEggStockCanBeReduced_(fulfilledQty);

  const sheet = getOrCreateSheet_(CONFIG.ORDERS_SHEET);
  formatOrdersSheet_(sheet);
  const id = Utilities.getUuid();
  const createdAt = new Date();
  const orderNumber = nextOrderNumber_(createdAt);
  const itemsText = order.items.map(i => `${i.qty}× ${i.name} (${i.qty * i.price} Kč)`).join(', ');
  let stockAdjusted = false;

  try {
    if (fulfilledQty > 0) {
      adjustEggStock_(-fulfilledQty);
      stockAdjusted = true;
    }

    sheet.appendRow([
      id, createdAt, order.status, safeSheetText_(order.name), safeSheetText_(order.phone), order.pickup,
      safeSheetText_(itemsText), order.total, safeSheetText_(order.note), manual ? 'Administrace' : 'Web', JSON.stringify(order.items), safeSheetText_(order.email),
      safeSheetText_(order.contactMethod), order.splitOrder, order.preorderPickup, order.regularStatus, order.preorderStatus,
      orderNumber, '', '', JSON.stringify([]), '', JSON.stringify([{type:'created', at:createdAt.toISOString(), text:'Objednávka vytvořena'}])
    ]);
  } catch (error) {
    if (stockAdjusted) adjustEggStock_(fulfilledQty);
    throw error;
  }

  let emailWarning = '';
  if (!manual) {
    try {
      MailApp.sendEmail({
        to: CONFIG.NOTIFICATION_EMAIL,
        subject: `Nová objednávka ${orderNumber} – ${order.name} – ${order.total} Kč`,
        body: buildTextEmail_(order, orderNumber, createdAt),
        htmlBody: buildHtmlEmail_(order, orderNumber, createdAt),
        name: CONFIG.BRAND_NAME,
        replyTo: order.email || CONFIG.NOTIFICATION_EMAIL
      });
    } catch (emailError) {
      console.error('Objednávka byla uložena, ale upozornění pro prodejce se nepodařilo odeslat.', emailError);
      emailWarning += ' Objednávka je uložená, ale upozorňovací e-mail se nepodařilo odeslat.';
    }

    try {
      MailApp.sendEmail({
        to: order.email,
        subject: `Potvrzení přijetí objednávky – ${CONFIG.BRAND_NAME}`,
        body: buildCustomerTextEmail_(order, orderNumber),
        htmlBody: buildCustomerHtmlEmail_(order, orderNumber),
        name: CONFIG.BRAND_NAME,
        replyTo: CONFIG.NOTIFICATION_EMAIL
      });
    } catch (customerEmailError) {
      console.error('Objednávka byla uložena, ale potvrzení zákazníkovi se nepodařilo odeslat.', customerEmailError);
      emailWarning += ' Potvrzovací e-mail zákazníkovi se nepodařilo odeslat.';
    }
  }

  return htmlResponse_(true, (manual ? 'Objednávka byla uložena.' : 'Objednávka byla přijata.') + emailWarning, id, { orderNumber: orderNumber });
}

function saveProduct_(payload) {
  const product = normalizeProduct_(payload.product || payload);
  const sheet = getOrCreateSheet_(CONFIG.PRODUCTS_SHEET);
  formatProductsSheet_(sheet);
  const values = sheet.getDataRange().getValues();
  let row = 0;
  let oldProduct = null;

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === String(product.id)) {
      row = i + 1;
      oldProduct = productFromSheetRow_(values[i]);
      break;
    }
  }

  const record = [[
    product.id, safeSheetText_(product.emoji), safeSheetText_(product.name), product.price, safeSheetText_(product.unit),
    safeSheetText_(product.short), safeSheetText_(product.detail), product.visible, product.soldOut,
    product.restock, product.leadDays, product.quick.join(', '), new Date(), product.preorder, product.preorderDate, product.capacity,
    product.emailGroup, safeSheetText_(product.emailText), safeSheetText_(product.image)
  ]];

  if (row) sheet.getRange(row, 1, 1, 19).setValues(record);
  else sheet.getRange(sheet.getLastRow() + 1, 1, 1, 19).setValues(record);

  const becameAvailable = product.visible && !product.soldOut && (!oldProduct || !oldProduct.visible || oldProduct.soldOut);
  if (becameAvailable) notifyStockWatchers_(product);

  return htmlResponse_(true, 'Produkt byl uložen.', String(product.id), { product: product });
}

function deleteProduct_(payload) {
  const id = cleanIdentifier_(payload.id, 'ID produktu');
  if (id === CONFIG.EGG_PRODUCT_ID) {
    throw new Error('Produkt Vejce nelze smazat, protože je navázaný na rezervační systém. Můžete ho pouze skrýt.');
  }
  const sheet = getOrCreateSheet_(CONFIG.PRODUCTS_SHEET);
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]) === id) sheet.deleteRow(i + 1);
  }
  return htmlResponse_(true, 'Produkt byl smazán.', id, {});
}

function saveOrder_(payload) {
  const submitted = payload.order || payload;
  const order = validateOrder_(submitted, true);
  const id = cleanIdentifier_(submitted.id, 'ID objednávky');

  const sheet = getOrCreateSheet_(CONFIG.ORDERS_SHEET);
  const values = sheet.getDataRange().getValues();
  let row = 0;

  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]) === id) {
      row = i + 1;
      break;
    }
  }

  if (!row) throw new Error('Objednávka nebyla nalezena.');

  const oldOrder = orderFromSheetRow_(values[row - 1]);
  const oldEggStatus = oldOrder.splitOrder ? oldOrder.regularStatus : oldOrder.status;
  const newEggStatus = order.splitOrder ? order.regularStatus : order.status;
  const oldFulfilled = isFulfilledStatus_(oldEggStatus) ? eggQtyFromItems_(oldOrder.items) : 0;
  const newFulfilled = isFulfilledStatus_(newEggStatus) ? eggQtyFromItems_(order.items) : 0;
  const fulfilledDelta = newFulfilled - oldFulfilled;

  const created = values[row - 1][1] || new Date();
  const source = values[row - 1][9] || 'Administrace';
  const itemsText = order.items.map(i => `${i.qty}× ${i.name} (${i.qty * i.price} Kč)`).join(', ');
  const orderNumber = oldOrder.orderNumber || nextOrderNumber_(created);
  let communication = Array.isArray(oldOrder.communication) ? oldOrder.communication.slice() : [];
  let timeline = Array.isArray(oldOrder.timeline) ? oldOrder.timeline.slice() : [];
  const regularBecameReady = (order.splitOrder ? order.regularStatus : order.status) === 'Připraveno' && (oldOrder.splitOrder ? oldOrder.regularStatus : oldOrder.status) !== 'Připraveno';
  const preorderBecameReady = order.splitOrder && order.preorderStatus === 'Připraveno' && oldOrder.preorderStatus !== 'Připraveno';
  if ((order.splitOrder ? order.regularStatus : order.status) !== (oldOrder.splitOrder ? oldOrder.regularStatus : oldOrder.status)) timeline.push({type:'status', at:new Date().toISOString(), text:'Stav dostupné části: ' + (order.splitOrder ? order.regularStatus : order.status)});
  if (order.splitOrder && order.preorderStatus !== oldOrder.preorderStatus) timeline.push({type:'status', at:new Date().toISOString(), text:'Stav předobjednané části: ' + order.preorderStatus});
  let regularEmailAt = oldOrder.readyEmailRegularAt || '';
  let preorderEmailAt = oldOrder.readyEmailPreorderAt || '';
  let appliedStockDelta = 0;

  try {
    // Pokud se vyzvednutá objednávka vrací mezi aktivní, nejprve vrátíme vejce do skladu,
    // aby se dostupnost nové rezervace počítala ze správného fyzického stavu.
    if (fulfilledDelta < 0) {
      appliedStockDelta = -fulfilledDelta;
      adjustEggStock_(appliedStockDelta);
    }

    validatePickupRules_(order, id);

    if (fulfilledDelta > 0) {
      ensureEggStockCanBeReduced_(fulfilledDelta);
      appliedStockDelta = -fulfilledDelta;
      adjustEggStock_(appliedStockDelta);
    }

    if (String(order.contactMethod || oldOrder.contactMethod || 'SMS') === 'E-mail') {
      if (regularBecameReady && !regularEmailAt) {
        sendReadyEmail_(Object.assign({}, order, {orderNumber:orderNumber}), 'regular');
        regularEmailAt = new Date().toISOString();
        communication.push({type:'ready-regular', at:regularEmailAt, text:'E-mail o připravené objednávce'});
      }
      if (preorderBecameReady && !preorderEmailAt) {
        sendReadyEmail_(Object.assign({}, order, {orderNumber:orderNumber}), 'preorder');
        preorderEmailAt = new Date().toISOString();
        communication.push({type:'ready-preorder', at:preorderEmailAt, text:'E-mail o připravené předobjednané části'});
      }
    }
    sheet.getRange(row, 1, 1, 23).setValues([[
      id, created, order.status, safeSheetText_(order.name), safeSheetText_(order.phone), order.pickup,
      safeSheetText_(itemsText), order.total, safeSheetText_(order.note), source, JSON.stringify(order.items), safeSheetText_(order.email),
      safeSheetText_(order.contactMethod || oldOrder.contactMethod || 'SMS'), order.splitOrder, order.preorderPickup,
      order.regularStatus, order.preorderStatus, orderNumber, regularEmailAt, preorderEmailAt,
      JSON.stringify(communication), safeSheetText_(submitted.internalNote || oldOrder.internalNote || ''), JSON.stringify(timeline)
    ]]);
  } catch (error) {
    if (appliedStockDelta) adjustEggStock_(-appliedStockDelta);
    throw error;
  }

  return htmlResponse_(true, 'Objednávka byla upravena.', id, {});
}

function deleteOrder_(payload) {
  const id = cleanIdentifier_(payload.id, 'ID objednávky');
  const sheet = getOrCreateSheet_(CONFIG.ORDERS_SHEET);
  const values = sheet.getDataRange().getValues();
  for (let i = values.length - 1; i >= 1; i--) {
    if (String(values[i][0]) === id) sheet.deleteRow(i + 1);
  }
  return htmlResponse_(true, 'Objednávka byla smazána.', id, {});
}

function saveEggSettings_(payload) {
  const source = payload.settings || payload;
  const currentStock = clampInteger_(source.currentStock, 0, 100000, 'Aktuální sklad');
  const dailyProduction = clampInteger_(source.dailyProduction, 0, 10000, 'Denní snáška');
  const safetyReserve = clampInteger_(source.safetyReserve, 0, 100000, 'Bezpečnostní rezerva');
  const planningDays = clampInteger_(source.planningDays, 7, 365, 'Délka plánování');

  writeEggSettings_({
    currentStock: currentStock,
    stockDate: todayKey_(),
    dailyProduction: dailyProduction,
    safetyReserve: safetyReserve,
    planningDays: planningDays
  });

  return htmlResponse_(true, 'Nastavení vajec bylo uloženo.', '', {
    eggSettings: readEggSettings_()
  });
}

function validatePickupRules_(order, excludeOrderId) {
  if (!isReservingStatus_(order.status)) return;

  const today = todayKey_();
  const regularActive = isReservingStatus_(order.splitOrder ? order.regularStatus : order.status);
  const preorderActive = isReservingStatus_(order.splitOrder ? order.preorderStatus : order.status);
  if (regularActive && order.pickup && order.pickup < today) {
    throw new Error('Termín prvního vyzvednutí nemůže být v minulosti.');
  }
  if (order.splitOrder && preorderActive && order.preorderPickup && order.preorderPickup < today) {
    throw new Error('Termín předobjednané části nemůže být v minulosti.');
  }

  const productMap = {};
  readProducts_().forEach(product => { productMap[String(product.id)] = product; });

  let minimum = today;
  order.items.forEach(item => {
    if (String(item.productId) === CONFIG.EGG_PRODUCT_ID) return;
    const product = productMap[String(item.productId)];
    if (!product) return;
    const leadMinimum = addDaysKey_(today, Number(product.leadDays || 0));
    if (leadMinimum > minimum) minimum = leadMinimum;
    const preorderDate = product.preorderDate || product.restock;
    if (product.preorder && order.splitOrder) {
      if (!preorderActive) return;
      if (!order.preorderPickup) throw new Error('Chybí termín předobjednané části.');
      if (preorderDate && order.preorderPickup < preorderDate) {
        throw new Error(`Předobjednanou část lze vyzvednout nejdříve ${formatDateForMessage_(preorderDate)}.`);
      }
      return;
    }
    if (!regularActive) return;
    if (product.preorder && preorderDate && preorderDate > minimum) minimum = preorderDate;
  });

  if (regularActive && minimum > today) {
    if (!order.pickup) throw new Error('Vyberte termín vyzvednutí.');
    if (order.pickup < minimum) {
      throw new Error(`Nejbližší možný termín vyzvednutí ostatních produktů je ${formatDateForMessage_(minimum)}.`);
    }
  }

  validateEggAvailability_(order, excludeOrderId);
}

function validateEggAvailability_(order, excludeOrderId) {
  const eggQty = eggQtyFromItems_(order.items);
  const eggStatus = order.splitOrder ? order.regularStatus : order.status;
  if (!eggQty || !isReservingStatus_(eggStatus)) return;
  if (!order.pickup) throw new Error('Vyberte termín vyzvednutí vajec.');

  const plan = buildEggAvailability_(excludeOrderId || '');
  const selected = plan.days.find(day => day.date === order.pickup);

  if (!selected) {
    throw new Error(`Vejce lze nyní rezervovat nejvýše do ${formatDateForMessage_(plan.horizonEnd)}.`);
  }

  if (selected.maxAdditional < eggQty) {
    const earliest = plan.days.find(day => day.date >= todayKey_() && day.maxAdditional >= eggQty);
    if (earliest) {
      throw new Error(`Pro ${eggQty} vajec je nejbližší možný termín ${formatDateForMessage_(earliest.date)}.`);
    }
    throw new Error(`Požadovaných ${eggQty} vajec nelze při současné snášce zajistit během následujících ${plan.settings.planningDays} dní.`);
  }
}

function publicEggAvailability_() {
  const plan = buildEggAvailability_('');
  return {
    eggProductId: CONFIG.EGG_PRODUCT_ID,
    horizonStart: plan.horizonStart,
    horizonEnd: plan.horizonEnd,
    planningDays: plan.settings.planningDays,
    days: plan.days.map(day => ({
      date: day.date,
      maxAdditional: day.maxAdditional
    }))
  };
}

function buildEggAvailability_(excludeOrderId) {
  const settings = readEggSettings_();
  const today = todayKey_();
  const horizonEnd = addDaysKey_(today, settings.planningDays);
  const reservations = {};
  let calculationEnd = horizonEnd;

  readOrdersForAvailability_().forEach(order => {
    if (excludeOrderId && String(order.id) === String(excludeOrderId)) return;
    if (!isReservingStatus_(order.status)) return;

    const qty = eggQtyFromItems_(order.items);
    if (!qty) return;

    let pickup = order.pickup || today;
    if (pickup < today) pickup = today;
    reservations[pickup] = (reservations[pickup] || 0) + qty;
    if (pickup > calculationEnd) calculationEnd = pickup;
  });

  const totalDays = Math.max(0, daysBetweenKeys_(today, calculationEnd));
  const rows = [];
  let projectedStock = settings.currentStock;

  for (let index = 0; index <= totalDays; index++) {
    const date = addDaysKey_(today, index);
    if (index > 0) projectedStock += settings.dailyProduction;
    const reserved = reservations[date] || 0;
    projectedStock -= reserved;
    rows.push({
      date: date,
      reserved: reserved,
      projectedStock: projectedStock,
      maxAdditional: 0
    });
  }

  let suffixMinimum = Infinity;
  for (let index = rows.length - 1; index >= 0; index--) {
    suffixMinimum = Math.min(suffixMinimum, rows[index].projectedStock);
    rows[index].maxAdditional = Math.max(0, Math.floor(suffixMinimum - settings.safetyReserve));
  }

  return {
    settings: settings,
    horizonStart: today,
    horizonEnd: horizonEnd,
    days: rows.filter(row => row.date <= horizonEnd)
  };
}

function readEggSettings_() {
  const sheet = getOrCreateSheet_(CONFIG.SETTINGS_SHEET);
  formatSettingsSheet_(sheet);
  seedEggSettings_(sheet);
  const values = readSettingsMap_(sheet);
  const today = todayKey_();

  const dailyProduction = safeInteger_(values.EGG_DAILY_PRODUCTION, CONFIG.DEFAULT_EGG_DAILY_PRODUCTION);
  const storedStock = safeInteger_(values.EGG_STOCK, CONFIG.DEFAULT_EGG_STOCK);
  const storedDate = normalizeDateKey_(values.EGG_STOCK_DATE, today);
  const elapsedDays = Math.max(0, daysBetweenKeys_(storedDate, today));
  const accruedEggs = elapsedDays * Math.max(0, dailyProduction);

  return {
    baseStock: Math.max(0, storedStock),
    baseDate: storedDate,
    elapsedDays: elapsedDays,
    accruedEggs: accruedEggs,
    currentStock: Math.max(0, storedStock + accruedEggs),
    stockDate: today,
    dailyProduction: Math.max(0, dailyProduction),
    safetyReserve: Math.max(0, safeInteger_(values.EGG_SAFETY_RESERVE, CONFIG.DEFAULT_EGG_SAFETY_RESERVE)),
    planningDays: Math.min(365, Math.max(7, safeInteger_(values.EGG_PLANNING_DAYS, CONFIG.DEFAULT_EGG_PLANNING_DAYS)))
  };
}

function writeEggSettings_(settings) {
  const sheet = getOrCreateSheet_(CONFIG.SETTINGS_SHEET);
  formatSettingsSheet_(sheet);
  setSetting_(sheet, 'EGG_STOCK', settings.currentStock, 'Aktuální fyzický počet vajec skladem');
  setTextSetting_(sheet, 'EGG_STOCK_DATE', settings.stockDate, 'Datum, ke kterému platí aktuální sklad');
  setSetting_(sheet, 'EGG_DAILY_PRODUCTION', settings.dailyProduction, 'Předpokládaný počet nových vajec za den');
  setSetting_(sheet, 'EGG_SAFETY_RESERVE', settings.safetyReserve, 'Počet vajec, který se zákazníkům nenabízí');
  setSetting_(sheet, 'EGG_PLANNING_DAYS', settings.planningDays, 'Kolik dní dopředu lze plánovat');
}

function adjustEggStock_(delta) {
  const settings = readEggSettings_();
  const nextStock = settings.currentStock + Number(delta || 0);
  if (nextStock < 0) throw new Error('Aktuální sklad vajec by klesl pod nulu. Nejprve upravte sklad v záložce Vejce.');
  settings.currentStock = Math.floor(nextStock);
  settings.stockDate = todayKey_();
  writeEggSettings_(settings);
}

function ensureEggStockCanBeReduced_(quantity) {
  const settings = readEggSettings_();
  if (settings.currentStock < quantity) {
    throw new Error(`Fyzicky je skladem pouze ${settings.currentStock} vajec. Nejprve upravte sklad nebo stav objednávky.`);
  }
}

function readProducts_() {
  const sheet = getOrCreateSheet_(CONFIG.PRODUCTS_SHEET);
  formatProductsSheet_(sheet);
  seedProducts_(sheet);
  repairDefaultProductSettings_(sheet);
  const rows = sheet.getDataRange().getValues().slice(1);

  return rows.filter(row => row[0] !== '').map(row => ({
    id: String(row[0]),
    emoji: restoreSheetText_(row[1] || '📦'),
    name: restoreSheetText_(row[2] || ''),
    price: Number(row[3] || 0),
    unit: restoreSheetText_(row[4] || 'kus'),
    short: restoreSheetText_(row[5] || ''),
    detail: restoreSheetText_(row[6] || ''),
    visible: toBool_(row[7]),
    soldOut: toBool_(row[8]),
    restock: formatSheetDate_(row[9]),
    leadDays: String(row[0]) === CONFIG.EGG_PRODUCT_ID ? 0 : Number(row[10] || 0),
    quick: quickButtonsForProduct_(row[0], row[1], row[2], row[11]),
    preorder: toBool_(row[13]),
    preorderDate: formatSheetDate_(row[14]) || formatSheetDate_(row[9]),
    capacity: Number(row[15] || 0),
    emailGroup: normalizeEmailGroup_(row[16], row[2]),
    emailText: restoreSheetText_(row[17] || ''),
    image: restoreSheetText_(row[18] || ''),
    reserved: reservedProductQuantity_(String(row[0]))
  }));
}

function readOrders_() {
  const sheet = getOrCreateSheet_(CONFIG.ORDERS_SHEET);
  formatOrdersSheet_(sheet);
  ensureOrderNumbers_(sheet);
  const rows = sheet.getDataRange().getValues().slice(1);
  return rows.filter(row => row[0] !== '').map(orderFromSheetRow_).reverse();
}

function readOrdersForAvailability_() {
  const sheet = getOrCreateSheet_(CONFIG.ORDERS_SHEET);
  formatOrdersSheet_(sheet);
  return sheet.getDataRange().getValues().slice(1)
    .filter(row => row[0] !== '')
    .map(orderFromSheetRow_);
}

function orderFromSheetRow_(row) {
  let items = [];
  try { items = JSON.parse(String(row[10] || '[]')); } catch (_) {}

  return {
    id: String(row[0] || ''),
    created: formatDateTime_(row[1]),
    status: String(row[2] || 'Nová'),
    name: restoreSheetText_(row[3] || ''),
    phone: restoreSheetText_(row[4] || ''),
    email: restoreSheetText_(row[11] || ''),
    pickup: formatSheetDate_(row[5]),
    itemsText: restoreSheetText_(row[6] || ''),
    items: Array.isArray(items) ? items : [],
    total: Number(row[7] || 0),
    note: restoreSheetText_(row[8] || ''),
    source: restoreSheetText_(row[9] || ''),
    contactMethod: restoreSheetText_(row[12] || 'SMS') || 'SMS',
    splitOrder: toBool_(row[13]),
    preorderPickup: formatSheetDate_(row[14]),
    regularStatus: String(row[15] || row[2] || 'Nová'),
    preorderStatus: String(row[16] || 'Nová'),
    orderNumber: String(row[17] || row[0] || ''),
    readyEmailRegularAt: String(row[18] || ''),
    readyEmailPreorderAt: String(row[19] || ''),
    communication: parseJsonArray_(row[20]),
    internalNote: restoreSheetText_(row[21] || ''),
    timeline: parseJsonArray_(row[22])
  };
}

function validateOrder_(payload, manual) {
  const name = cleanText_(payload.name, 100);
  const phone = cleanText_(payload.phone, 40);
  const email = cleanText_(payload.email, 254).toLowerCase();
  const pickup = cleanText_(payload.pickup, 20);
  const note = cleanText_(payload.note, 500);
  const status = manual ? cleanText_(payload.status || 'Nová', 30) : 'Nová';
  const contactMethod = cleanText_(payload.contactMethod || 'SMS', 20);
  const splitOrder = toBool_(payload.splitOrder);
  const preorderPickup = cleanText_(payload.preorderPickup, 20);
  const regularStatus = manual ? cleanText_(payload.regularStatus || status, 30) : 'Nová';
  const preorderStatus = manual ? cleanText_(payload.preorderStatus || 'Nová', 30) : 'Nová';

  if (name.length < 2) throw new Error('Neplatné jméno.');
  if (!manual && phone.length < 5) throw new Error('Neplatný telefon.');
  if (!manual && !isValidEmail_(email)) throw new Error('Zadejte platnou e-mailovou adresu.');
  if (manual && email && !isValidEmail_(email)) throw new Error('E-mailová adresa není platná.');
  if (!CONFIG.ORDER_STATUSES.includes(status) || !CONFIG.ORDER_STATUSES.includes(regularStatus) || !CONFIG.ORDER_STATUSES.includes(preorderStatus)) throw new Error('Neplatný stav objednávky.');
  if (!['SMS', 'E-mail'].includes(contactMethod)) throw new Error('Neplatný způsob kontaktu.');
  if (preorderPickup && !isValidDateKey_(preorderPickup)) throw new Error('Neplatný termín předobjednávky.');
  if (pickup && !isValidDateKey_(pickup)) throw new Error('Neplatný termín vyzvednutí.');
  if (!Array.isArray(payload.items) || !payload.items.length || payload.items.length > CONFIG.MAX_ITEMS) {
    throw new Error('Neplatné položky.');
  }

  const productMap = {};
  readProducts_().forEach(product => { productMap[String(product.id)] = product; });

  const itemTotals = {};
  payload.items.forEach(item => {
    const productId = cleanIdentifier_(item.productId, 'ID produktu');
    const qty = Math.floor(Number(item.qty));
    const product = productMap[productId];
    if (!product) throw new Error('Objednaný produkt už neexistuje. Obnovte stránku a zkuste to znovu.');
    if (!manual && (!product.visible || (product.soldOut && !product.preorder))) {
      throw new Error(`Produkt ${product.name} nyní není možné objednat.`);
    }
    if (!Number.isInteger(qty) || qty < 1) throw new Error('Neplatné množství položky.');

    itemTotals[productId] = (itemTotals[productId] || 0) + qty;
    if (itemTotals[productId] > CONFIG.MAX_QUANTITY_PER_ITEM) {
      throw new Error(`U jednoho produktu lze objednat nejvýše ${CONFIG.MAX_QUANTITY_PER_ITEM} kusů.`);
    }
  });

  const items = Object.keys(itemTotals).map(productId => {
    const product = productMap[productId];
    const priceValue = Number(product.price);
    if (!product.name || !Number.isFinite(priceValue) || priceValue < 0) throw new Error('Neplatná položka.');
    return {
      productId: productId,
      name: product.name,
      qty: itemTotals[productId],
      price: priceValue,
      emailGroup: product.emailGroup,
      emailText: product.emailText || ''
    };
  });

  return {
    name: name,
    phone: phone,
    email: email,
    pickup: pickup,
    note: note,
    status: splitOrder ? aggregateSplitStatus_(regularStatus, preorderStatus) : status,
    items: items,
    total: items.reduce((sum, item) => sum + item.qty * item.price, 0),
    contactMethod: contactMethod,
    splitOrder: splitOrder,
    preorderPickup: preorderPickup,
    regularStatus: splitOrder ? regularStatus : status,
    preorderStatus: splitOrder ? preorderStatus : status
  };
}

function normalizeProduct_(product) {
  const id = product.id ? cleanIdentifier_(product.id, 'ID produktu') : Utilities.getUuid();
  const emoji = cleanText_(product.emoji || '📦', 10);
  const name = cleanText_(product.name, 100);
  const unit = cleanText_(product.unit || 'kus', 30);
  const restock = cleanText_(product.restock, 20);
  const preorder = toBool_(product.preorder);
  const preorderDate = cleanText_(product.preorderDate || product.restock, 20);
  const price = Number(product.price);
  const emailGroup = normalizeEmailGroup_(product.emailGroup, name);
  const emailText = cleanText_(product.emailText, 120);
  const image = cleanText_(product.image, 500);

  if (!name) throw new Error('Vyplňte název produktu.');
  if (!unit) throw new Error('Vyplňte jednotku produktu.');
  if (!Number.isFinite(price) || price < 0 || price > 1000000) throw new Error('Cena produktu není platná.');
  if (restock && !isValidDateKey_(restock)) throw new Error('Datum doplnění produktu není platné.');
  if (preorderDate && !isValidDateKey_(preorderDate)) throw new Error('Datum naskladnění předobjednávky není platné.');
  if (preorder && !preorderDate) throw new Error('U předobjednávky vyplňte předpokládané datum naskladnění.');
  if (emailGroup === 'VLASTNI' && !emailText) throw new Error('U vlastního textu e-mailu vyplňte vlastní označení.');

  return {
    id: id,
    emoji: emoji,
    name: name,
    price: price,
    unit: unit,
    short: cleanText_(product.short, 300),
    detail: cleanText_(product.detail, 1000),
    visible: toBool_(product.visible),
    soldOut: toBool_(product.soldOut),
    preorder: preorder,
    preorderDate: preorderDate,
    restock: restock || preorderDate,
    leadDays: String(id) === CONFIG.EGG_PRODUCT_ID ? 0 : Math.min(365, Math.max(0, Math.floor(Number(product.leadDays) || 0))),
    quick: quickButtonsForProduct_(id, emoji, name, product.quick),
    capacity: Math.max(0, Math.floor(Number(product.capacity) || 0)),
    emailGroup: emailGroup,
    emailText: emailGroup === 'VLASTNI' ? emailText : '',
    image: image
  };
}

function eggQtyFromItems_(items) {
  return (items || [])
    .filter(item => String(item.productId) === CONFIG.EGG_PRODUCT_ID)
    .reduce((sum, item) => sum + Math.max(0, Math.floor(Number(item.qty) || 0)), 0);
}

function aggregateSplitStatus_(regularStatus, preorderStatus) {
  const statuses = [String(regularStatus || 'Nová'), String(preorderStatus || 'Nová')];
  if (statuses.every(value => value === 'Zrušeno')) return 'Zrušeno';
  if (statuses.every(value => ['Vyzvednuto', 'Zrušeno'].includes(value))) return 'Vyzvednuto';
  if (statuses.some(value => value === 'Připraveno')) return 'Připraveno';
  if (statuses.some(value => value === 'Připravuji' || value === 'Vyzvednuto')) return 'Připravuji';
  return 'Nová';
}

function isReservingStatus_(status) {
  return !['Vyzvednuto', 'Zrušeno'].includes(String(status || 'Nová'));
}

function isFulfilledStatus_(status) {
  return String(status || '') === 'Vyzvednuto';
}

function getOrCreateSheet_(name) {
  const spreadsheet = SpreadsheetApp.getActiveSpreadsheet();
  if (!spreadsheet) throw new Error('Skript musí být vytvořený z Google Tabulky.');
  return spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
}

function formatWatchlistSheet_(sheet) {
  const headers = ['Produkt ID', 'Produkt', 'E-mail', 'Vytvořeno', 'Upozorněno'];
  if (sheet.getLastRow() === 0) sheet.appendRow(headers);
  else sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
}

function subscribeStock_(payload) {
  const productId = cleanIdentifier_(payload.productId, 'ID produktu');
  const email = cleanText_(payload.email, 254).toLowerCase();
  if (!isValidEmail_(email)) throw new Error('Zadejte platnou e-mailovou adresu.');
  const product = readProducts_().find(item => String(item.id) === productId);
  if (!product) throw new Error('Produkt nebyl nalezen.');
  if (product.visible && !product.soldOut) throw new Error('Produkt je již skladem a lze ho objednat.');
  const sheet = getOrCreateSheet_(CONFIG.WATCHLIST_SHEET);
  formatWatchlistSheet_(sheet);
  const rows = sheet.getDataRange().getValues();
  const exists = rows.slice(1).some(row => String(row[0]) === productId && String(row[2]).toLowerCase() === email && !row[4]);
  if (!exists) sheet.appendRow([productId, safeSheetText_(product.name), safeSheetText_(email), new Date(), '']);
  return htmlResponse_(true, 'Hlídací pes byl zapnutý.', productId, {});
}

function notifyStockWatchers_(product) {
  const sheet = getOrCreateSheet_(CONFIG.WATCHLIST_SHEET);
  formatWatchlistSheet_(sheet);
  const rows = sheet.getDataRange().getValues();
  for (let i = 1; i < rows.length; i++) {
    if (String(rows[i][0]) !== String(product.id) || rows[i][4]) continue;
    const email = restoreSheetText_(rows[i][2] || '');
    if (!isValidEmail_(email)) continue;
    try {
      MailApp.sendEmail({
        to: email,
        subject: `${product.name} je znovu skladem – ${CONFIG.BRAND_NAME}`,
        body: `Dobrý den,\n\nprodukt ${product.name} je znovu skladem a můžete si ho objednat na našem objednávkovém webu.\n\nTento e-mail posíláme jednorázově na základě zapnutého hlídacího psa.\n\nS přáním krásného dne\n\nMartin Dvořák\n${CONFIG.BRAND_NAME}\nPoctivé produkty od našich včel, slepiček a ze zahrádky.`,
        name: CONFIG.BRAND_NAME,
        replyTo: CONFIG.NOTIFICATION_EMAIL
      });
      sheet.getRange(i + 1, 5).setValue(new Date());
    } catch (error) { console.error('Hlídací pes – e-mail se nepodařilo odeslat', error); }
  }
}

function productFromSheetRow_(row) {
  return { id: String(row[0] || ''), visible: toBool_(row[7]), soldOut: toBool_(row[8]) };
}

function formatOrdersSheet_(sheet) {
  const headers = ['Interní ID', 'Vytvořeno', 'Stav', 'Jméno', 'Telefon', 'Termín vyzvednutí', 'Položky', 'Celkem Kč', 'Poznámka', 'Zdroj', 'ItemsJSON', 'E-mail', 'Kontakt před vyzvednutím', 'Rozdělená objednávka', 'Termín předobjednávky', 'Stav dostupné části', 'Stav předobjednávky', 'Číslo objednávky', 'E-mail připraveno 1', 'E-mail připraveno 2', 'Komunikace JSON', 'Interní poznámka', 'Časová osa JSON'];
  ensureHeaders_(sheet, headers);
  sheet.setFrozenRows(1);
}


function ensureOrderNumbers_(sheet) {
  if (sheet.getLastRow() < 2) return;
  const values = sheet.getRange(2, 1, sheet.getLastRow() - 1, 18).getValues();
  let changed = false;
  for (let i = 0; i < values.length; i++) {
    if (!values[i][0] || values[i][17]) continue;
    const created = values[i][1] instanceof Date ? values[i][1] : new Date();
    values[i][17] = nextOrderNumber_(created);
    changed = true;
  }
  if (changed) sheet.getRange(2, 1, values.length, 18).setValues(values);
}

function formatProductsSheet_(sheet) {
  const headers = ['ID', 'Emoji', 'Název', 'Cena', 'Jednotka', 'Krátký popis', 'Podrobnosti', 'Viditelný', 'Vyprodáno', 'Doplnění', 'Předstih dní', 'Rychlá tlačítka', 'Aktualizováno', 'Předobjednávka', 'Datum předobjednávky', 'Plánované množství', 'Text e-mailu', 'Vlastní označení', 'Fotografie produktu'];
  ensureHeaders_(sheet, headers);
  sheet.setFrozenRows(1);
}

function formatSettingsSheet_(sheet) {
  const headers = ['Klíč', 'Hodnota', 'Popis'];
  ensureHeaders_(sheet, headers);
  sheet.setFrozenRows(1);
}

function ensureHeaders_(sheet, headers) {
  sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight('bold');
}

function seedProducts_(sheet) {
  if (sheet.getLastRow() > 1) return;
  const now = new Date();
  sheet.getRange(2, 1, 2, 19).setValues([
    ['1', '🍯', 'Květový med', 190, '950 g', 'Smíšený květový med z okolí Lukášova.', 'Včely sbírají nektar z lučního kvítí, maliní, ovocných stromů, lip a okolních lesů. Každá sklenice tak nese chuť místní krajiny.', true, false, '', 0, '', now, false, '', 0, 'VCELICKY', '', ''],
    ['2', '🥚', 'Čerstvá vejce', 7, 'kus', 'Vejce od našich slepic z domácího chovu.', 'Slepice krmíme kvalitní směsí a zeleninou. Každý den mají přístup na trávu, kde si hledají červy a další přirozenou potravu.', true, false, '', 0, '6, 10, 30', now, false, '', 0, 'SLEPICKY', '', '']
  ]);
}

function repairDefaultProductSettings_(sheet) {
  const values = sheet.getDataRange().getValues();
  for (let row = 1; row < values.length; row++) {
    if (String(values[row][0]) !== CONFIG.EGG_PRODUCT_ID) continue;

    const leadDays = Number(values[row][10] || 0);
    const quick = String(values[row][11] || '').replace(/\s+/g, '');
    if (leadDays === 0 && quick === '6,10,30') return;

    sheet.getRange(row + 1, 11, 1, 3).setValues([[0, '6, 10, 30', new Date()]]);
    return;
  }
}

function quickButtonsForProduct_(id, emoji, name, value) {
  if (String(id) === CONFIG.EGG_PRODUCT_ID) return [6, 10, 30];
  const text = `${emoji || ''} ${name || ''}`.toLocaleLowerCase('cs-CZ');
  if (text.indexOf('🥚') !== -1 || text.indexOf('vejce') !== -1) return [6, 10, 30];
  const source = Array.isArray(value) ? value : String(value || '').split(',');
  return source.map(item => Number(String(item).trim())).filter(item => Number.isFinite(item) && item > 0);
}

function seedEggSettings_(sheet) {
  const today = todayKey_();
  setSettingIfMissing_(sheet, 'EGG_STOCK', CONFIG.DEFAULT_EGG_STOCK, 'Aktuální fyzický počet vajec skladem');
  setSettingIfMissing_(sheet, 'EGG_STOCK_DATE', today, 'Datum, ke kterému platí aktuální sklad');
  setSettingIfMissing_(sheet, 'EGG_DAILY_PRODUCTION', CONFIG.DEFAULT_EGG_DAILY_PRODUCTION, 'Předpokládaný počet nových vajec za den');
  setSettingIfMissing_(sheet, 'EGG_SAFETY_RESERVE', CONFIG.DEFAULT_EGG_SAFETY_RESERVE, 'Počet vajec, který se zákazníkům nenabízí');
  setSettingIfMissing_(sheet, 'EGG_PLANNING_DAYS', CONFIG.DEFAULT_EGG_PLANNING_DAYS, 'Kolik dní dopředu lze plánovat');
}


function publicBusinessSettings_() {
  const map = readSettingsMap_(getOrCreateSheet_(CONFIG.SETTINGS_SHEET));
  return {
    bannerEnabled: toBool_(map.BANNER_ENABLED),
    bannerStyle: cleanText_(map.BANNER_STYLE || 'yellow', 20),
    bannerTitle: restoreSheetText_(map.BANNER_TITLE || ''),
    bannerText: restoreSheetText_(map.BANNER_TEXT || ''),
    bannerFrom: normalizeDateKey_(map.BANNER_FROM, ''),
    bannerTo: normalizeDateKey_(map.BANNER_TO, ''),
    ordersPaused: toBool_(map.ORDERS_PAUSED),
    pauseFrom: normalizeDateKey_(map.PAUSE_FROM, ''),
    pauseTo: normalizeDateKey_(map.PAUSE_TO, ''),
    pauseMessage: restoreSheetText_(map.PAUSE_MESSAGE || ''),
    dailyOrderLimit: Math.max(0, safeInteger_(map.DAILY_ORDER_LIMIT, 0))
  };
}

function saveBusinessSettings_(payload) {
  const settings = payload.settings || payload;
  const pauseFrom = normalizeDateKey_(settings.pauseFrom, '');
  const pauseTo = normalizeDateKey_(settings.pauseTo, '');
  if (toBool_(settings.ordersPaused) && (!pauseFrom || !pauseTo)) throw new Error('Vyplňte začátek i konec blokace vyzvednutí.');
  if (pauseFrom && pauseTo && pauseFrom > pauseTo) throw new Error('Konec blokace nesmí být před jejím začátkem.');
  const sheet = getOrCreateSheet_(CONFIG.SETTINGS_SHEET);
  setSetting_(sheet, 'BANNER_ENABLED', toBool_(settings.bannerEnabled), 'Zobrazit informační banner');
  setTextSetting_(sheet, 'BANNER_STYLE', cleanText_(settings.bannerStyle || 'yellow', 20), 'Barva banneru');
  setTextSetting_(sheet, 'BANNER_TITLE', cleanText_(settings.bannerTitle, 150), 'Nadpis banneru');
  setTextSetting_(sheet, 'BANNER_TEXT', cleanText_(settings.bannerText, 800), 'Text banneru');
  setTextSetting_(sheet, 'BANNER_FROM', normalizeDateKey_(settings.bannerFrom, ''), 'Banner zobrazit od');
  setTextSetting_(sheet, 'BANNER_TO', normalizeDateKey_(settings.bannerTo, ''), 'Banner zobrazit do');
  setSetting_(sheet, 'ORDERS_PAUSED', toBool_(settings.ordersPaused), 'Zablokovat vyzvednutí v období');
  setTextSetting_(sheet, 'PAUSE_FROM', pauseFrom, 'Blokace vyzvednutí od');
  setTextSetting_(sheet, 'PAUSE_TO', pauseTo, 'Blokace vyzvednutí do');
  setTextSetting_(sheet, 'PAUSE_MESSAGE', cleanText_(settings.pauseMessage, 800), 'Upozornění při blokaci vyzvednutí');
  setSetting_(sheet, 'DAILY_ORDER_LIMIT', Math.max(0, Math.floor(Number(settings.dailyOrderLimit) || 0)), 'Maximum objednávek na den');
  return htmlResponse_(true, 'Nastavení webu bylo uloženo.', '', { settings: publicBusinessSettings_() });
}

function reservedProductQuantity_(productId) {
  const productSheet = getOrCreateSheet_(CONFIG.PRODUCTS_SHEET);
  formatProductsSheet_(productSheet);
  const productRow = productSheet.getDataRange().getValues().slice(1).find(row => String(row[0]) === String(productId));
  const productIsPreorder = productRow ? toBool_(productRow[13]) : false;
  return readOrdersForAvailability_()
    .filter(order => {
      const partStatus = order.splitOrder ? (productIsPreorder ? order.preorderStatus : order.regularStatus) : order.status;
      return isReservingStatus_(partStatus);
    })
    .flatMap(order => order.items || [])
    .filter(item => String(item.productId) === String(productId))
    .reduce((sum, item) => sum + Math.max(0, Number(item.qty) || 0), 0);
}

function validateBusinessRules_(order) {
  const settings = publicBusinessSettings_();
  if (settings.ordersPaused && settings.pauseFrom && settings.pauseTo) {
    const blockedDates = [order.pickup];
    if (order.splitOrder && order.preorderPickup) blockedDates.push(order.preorderPickup);
    if (blockedDates.some(date => date && date >= settings.pauseFrom && date <= settings.pauseTo)) {
      const firstAfter = addDaysKey_(settings.pauseTo, 1);
      throw new Error(settings.pauseMessage || `V zadaném období nebude možné objednávku vyzvednout. Zvolte termín nejdříve ${formatDateForMessage_(firstAfter)}.`);
    }
  }

  if (settings.dailyOrderLimit > 0 && order.pickup) {
    const count = readOrdersForAvailability_().filter(item =>
      item.pickup === order.pickup && isReservingStatus_(item.status)
    ).length;
    if (count >= settings.dailyOrderLimit) throw new Error('Zvolený den je již plně obsazený. Vyberte jiný termín.');
  }

  const products = {};
  readProducts_().forEach(product => products[String(product.id)] = product);
  order.items.forEach(item => {
    const product = products[String(item.productId)];
    if (!product || !product.capacity) return;
    const reserved = reservedProductQuantity_(item.productId);
    if (reserved + item.qty > product.capacity) {
      throw new Error(`U produktu ${product.name} zbývá k rezervaci pouze ${Math.max(0, product.capacity - reserved)} ${product.unit}.`);
    }
  });
}

function normalizeEggStockDateSetting_(sheet) {
  const values = readSettingsMap_(sheet);
  const today = todayKey_();
  const normalized = normalizeDateKey_(values.EGG_STOCK_DATE, today);
  setTextSetting_(sheet, 'EGG_STOCK_DATE', normalized, 'Datum, ke kterému platí aktuální sklad');
}

function readSettingsMap_(sheet) {
  const map = {};
  const rows = sheet.getDataRange().getValues().slice(1);
  rows.forEach(row => {
    if (row[0] !== '') map[String(row[0])] = row[1];
  });
  return map;
}

function setSettingIfMissing_(sheet, key, value, description) {
  const values = sheet.getDataRange().getValues();
  for (let row = 1; row < values.length; row++) {
    if (String(values[row][0]) === key) return;
  }
  sheet.appendRow([key, value, description]);
}

function setSetting_(sheet, key, value, description) {
  const values = sheet.getDataRange().getValues();
  for (let row = 1; row < values.length; row++) {
    if (String(values[row][0]) === key) {
      sheet.getRange(row + 1, 2, 1, 2).setValues([[value, description]]);
      return;
    }
  }
  sheet.appendRow([key, value, description]);
}

function setTextSetting_(sheet, key, value, description) {
  const values = sheet.getDataRange().getValues();
  for (let row = 1; row < values.length; row++) {
    if (String(values[row][0]) === key) {
      const valueCell = sheet.getRange(row + 1, 2);
      valueCell.setNumberFormat('@');
      valueCell.setValue(String(value));
      sheet.getRange(row + 1, 3).setValue(description);
      return;
    }
  }
  const targetRow = sheet.getLastRow() + 1;
  sheet.getRange(targetRow, 1).setValue(key);
  const valueCell = sheet.getRange(targetRow, 2);
  valueCell.setNumberFormat('@');
  valueCell.setValue(String(value));
  sheet.getRange(targetRow, 3).setValue(description);
}

function clampInteger_(value, minimum, maximum, label) {
  const number = Math.floor(Number(value));
  if (!Number.isFinite(number) || number < minimum || number > maximum) {
    throw new Error(`${label} musí být celé číslo od ${minimum} do ${maximum}.`);
  }
  return number;
}

function safeInteger_(value, fallback) {
  const number = Math.floor(Number(value));
  return Number.isFinite(number) ? number : fallback;
}

function normalizeDateKey_(value, fallback) {
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  }
  const text = String(value == null ? '' : value).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const parsed = new Date(text);
  if (!isNaN(parsed)) return Utilities.formatDate(parsed, CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  return fallback;
}

function todayKey_() {
  return Utilities.formatDate(new Date(), CONFIG.TIME_ZONE, 'yyyy-MM-dd');
}

function parseDateKey_(value) {
  return new Date(String(value) + 'T12:00:00');
}

function addDaysKey_(value, days) {
  const date = parseDateKey_(value);
  date.setDate(date.getDate() + Number(days || 0));
  return Utilities.formatDate(date, CONFIG.TIME_ZONE, 'yyyy-MM-dd');
}

function daysBetweenKeys_(from, to) {
  return Math.round((parseDateKey_(to).getTime() - parseDateKey_(from).getTime()) / 86400000);
}

function formatDateForMessage_(value) {
  return Utilities.formatDate(parseDateKey_(value), CONFIG.TIME_ZONE, 'd. M. yyyy');
}

function cleanText_(value, maximumLength) {
  return String(value == null ? '' : value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maximumLength);
}

function cleanIdentifier_(value, label) {
  const id = cleanText_(value, 100);
  if (!id || !/^[A-Za-z0-9_-]{1,100}$/.test(id)) {
    throw new Error((label || 'ID') + ' není platné.');
  }
  return id;
}

function isValidDateKey_(value) {
  const text = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const date = parseDateKey_(text);
  return !isNaN(date.getTime()) && Utilities.formatDate(date, CONFIG.TIME_ZONE, 'yyyy-MM-dd') === text;
}

function safeSheetText_(value) {
  const text = String(value == null ? '' : value);
  return /^[=+\-@]/.test(text) ? "'" + text : text;
}

function restoreSheetText_(value) {
  return String(value == null ? '' : value).replace(/^'(?=[=+\-@])/, '');
}

function toBool_(value) {
  return value === true || String(value).toLowerCase() === 'true' || String(value) === '1';
}

function formatSheetDate_(value) {
  if (!value) return '';
  if (Object.prototype.toString.call(value) === '[object Date]' && !isNaN(value)) {
    return Utilities.formatDate(value, CONFIG.TIME_ZONE, 'yyyy-MM-dd');
  }
  return String(value).slice(0, 10);
}

function formatDateTime_(value) {
  if (!value) return '';
  const date = new Date(value);
  return isNaN(date) ? String(value) : Utilities.formatDate(date, CONFIG.TIME_ZONE, 'd. M. yyyy HH:mm');
}

function generatePassword_() {
  return 'PDP-' + Utilities.getUuid().replace(/-/g, '').slice(0, 12);
}

function jsonpResponse_(e, object) {
  const requested = String(e && e.parameter && e.parameter.callback || 'callback');
  const callback = requested.replace(/[^a-zA-Z0-9_.$]/g, '') || 'callback';
  const json = JSON.stringify(object)
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return ContentService.createTextOutput(`${callback}(${json});`)
    .setMimeType(ContentService.MimeType.JAVASCRIPT);
}

function htmlResponse_(ok, message, id, extra) {
  const result = Object.assign({
    type: 'PDP_BACKEND_RESULT',
    ok: ok,
    message: message,
    id: id
  }, extra || {});

  const resultJson = JSON.stringify(result)
    .replace(/</g, '\\u003c')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  const html = `<!doctype html>
<html lang="cs">
<head><meta charset="utf-8"><title>Výsledek</title></head>
<body>
<script>
(function () {
  const result = ${resultJson};
  function sendResult() {
    try { window.parent.postMessage(result, '*'); } catch (error) {}
    try { window.top.postMessage(result, '*'); } catch (error) {}
  }
  sendResult();
  setTimeout(sendResult, 100);
  setTimeout(sendResult, 500);
})();
<\/script>
</body>
</html>`;

  return HtmlService.createHtmlOutput(html)
    .setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}

function buildTextEmail_(order, id, createdAt) {
  return [
    'Nová objednávka',
    '',
    `Číslo: ${id}`,
    `Přijata: ${Utilities.formatDate(createdAt, CONFIG.TIME_ZONE, 'd. M. yyyy HH:mm')}`,
    `Jméno: ${order.name}`,
    `Telefon: ${order.phone}`,
    `E-mail: ${order.email || 'neuveden'}`,
    `Vyzvednutí: ${order.pickup || 'neuvedeno'}`,
    `Kontakt před vyzvednutím: ${order.contactMethod}`,
    `Rozdělit objednávku: ${order.splitOrder ? 'ANO' : 'NE'}`,
    ...(order.splitOrder ? [`Předobjednaná část: ${order.preorderPickup || 'bude upřesněno'}`] : []),
    '',
    'Položky:',
    ...order.items.map(item => `- ${item.qty}× ${item.name}: ${item.qty * item.price} Kč`),
    '',
    `Celkem: ${order.total} Kč`,
    `Poznámka: ${order.note || '—'}`
  ].join('\n');
}

function buildHtmlEmail_(order, id) {
  const rows = order.items.map(item => `<tr><td style="padding:8px;border-bottom:1px solid #eee">${escapeHtml_(item.qty + '× ' + item.name)}</td><td style="text-align:right;font-weight:700">${item.qty * item.price} Kč</td></tr>`).join('');
  return `<div style="font-family:Arial;max-width:600px"><h2>${escapeHtml_(CONFIG.BRAND_NAME)}</h2><p><b>Jméno:</b> ${escapeHtml_(order.name)}<br><b>Telefon:</b> ${escapeHtml_(order.phone)}<br><b>E-mail:</b> ${escapeHtml_(order.email || 'neuveden')}<br><b>Vyzvednutí:</b> ${escapeHtml_(order.pickup || 'neuvedeno')}</p><table style="width:100%;border-collapse:collapse">${rows}</table><p style="font-size:22px;text-align:right"><b>Celkem: ${order.total} Kč</b></p><p><b>Poznámka:</b> ${escapeHtml_(order.note || '—')}</p><small>ID: ${escapeHtml_(id)}</small></div>`;
}


function parseJsonArray_(value) {
  try { const x = JSON.parse(String(value || '[]')); return Array.isArray(x) ? x : []; } catch (_) { return []; }
}

function nextOrderNumber_(date) {
  const year = Utilities.formatDate(date || new Date(), CONFIG.TIME_ZONE, 'yyyy');
  const props = PropertiesService.getScriptProperties();
  const key = 'ORDER_COUNTER_' + year;
  const next = Number(props.getProperty(key) || 0) + 1;
  props.setProperty(key, String(next));
  return 'PP-' + year + '-' + String(next).padStart(4, '0');
}

function readyItems_(order, part) {
  if (!order.splitOrder) return order.items || [];
  const products = readProducts_();
  const byId = {}; products.forEach(p => byId[String(p.id)] = p);
  return (order.items || []).filter(item => {
    const p = byId[String(item.productId)] || {};
    const isPre = Boolean(p.preorder);
    return part === 'preorder' ? isPre : !isPre;
  });
}

function readyAnimalPhrase_(order, part) {
  return customerAnimalPhrase_(Object.assign({}, order, {items: readyItems_(order, part)}));
}

function readyWorkMessage_(order, part) {
  const subject = readyAnimalPhrase_(order, part);
  const verb = /farmáři/i.test(subject) ? 'dokončili' : 'dokončily';
  return `${subject} ${verb} práci.`;
}

function buildReadyTextEmail_(order, part) {
  const greeting = firstNameVocative_(order.name);
  const date = part === 'preorder' ? order.preorderPickup : order.pickup;
  const partText = order.splitOrder ? (part === 'preorder' ? 'Předobjednaná část Vaší objednávky' : 'První část Vaší objednávky') : 'Vaše objednávka';
  return [
    `Dobrý den${greeting ? ', ' + greeting : ''},`, '',
    readyWorkMessage_(order, part), '',
    `${partText} je připravena k vyzvednutí.`, '',
    'Prosíme o její vyzvednutí dne', '', formatCustomerPickupDate_(date), '',
    'na adrese', '', 'Pod Prosečí 102/2', 'Jablonec nad Nisou', '',
    'Pokud se Vám termín nehodí, odpovězte na tento e-mail nebo nás kontaktujte na telefonním čísle +420 732 687 040.', '',
    'Děkujeme za Vaši důvěru a těšíme se na Vás.', '', 'S přáním krásného dne', '', 'Martin Dvořák', CONFIG.BRAND_NAME, 'Poctivé produkty od našich včel, slepiček a ze zahrádky.', '', `Číslo objednávky: ${order.orderNumber}`
  ].join('\n');
}

function buildReadyHtmlEmail_(order, part) {
  return '<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;line-height:1.6;color:#2b241f">' +
    buildReadyTextEmail_(order, part).split('\n').map(line => line ? '<p style="margin:8px 0">'+escapeHtml_(line)+'</p>' : '<br>').join('') + '</div>';
}

function sendReadyEmail_(order, part) {
  MailApp.sendEmail({to:order.email, subject:'📦 Vaše objednávka je připravena k vyzvednutí – ' + order.orderNumber,
    body:buildReadyTextEmail_(order, part), htmlBody:buildReadyHtmlEmail_(order, part), name:CONFIG.BRAND_NAME, replyTo:CONFIG.NOTIFICATION_EMAIL});
}

function resendReadyEmail_(payload) {
  const id = cleanIdentifier_(payload.id, 'ID objednávky');
  const part = payload.part === 'preorder' ? 'preorder' : 'regular';
  const sheet = getOrCreateSheet_(CONFIG.ORDERS_SHEET); formatOrdersSheet_(sheet);
  const values = sheet.getDataRange().getValues();
  for (let i=1;i<values.length;i++) if (String(values[i][0])===id) {
    const order=orderFromSheetRow_(values[i]);
    if (!order.email) throw new Error('Objednávka nemá e-mail.');
    sendReadyEmail_(order, part);
    const comm=order.communication || []; comm.push({type:'ready-'+part+'-resend',at:new Date().toISOString(),text:'E-mail o připravené objednávce odeslán znovu'});
    sheet.getRange(i+1,21).setValue(JSON.stringify(comm));
    return htmlResponse_(true,'E-mail byl odeslán znovu.',id,{});
  }
  throw new Error('Objednávka nebyla nalezena.');
}

function isValidEmail_(value) {
  const email = String(value || '').trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

function firstNameVocative_(fullName) {
  const first = cleanText_(String(fullName || '').trim().split(/\s+/)[0], 50);
  if (!first) return '';
  const lower = first.toLocaleLowerCase('cs-CZ');
  const known = {
    martin:'Martine', petr:'Petře', pavel:'Pavle', jan:'Jane', tomáš:'Tomáši', lukáš:'Lukáši',
    michal:'Michale', jiří:'Jiří', josef:'Josefe', david:'Davide', ondřej:'Ondřeji',
    jakub:'Jakube', marek:'Marku', radek:'Radku', roman:'Romane', milan:'Milane',
    eva:'Evo', jana:'Jano', hana:'Hano', anna:'Anno', lucie:'Lucie', petra:'Petro',
    veronika:'Veroniko', kateřina:'Kateřino', martina:'Martino', monika:'Moniko',
    lenka:'Lenko', alena:'Aleno', marie:'Marie', tereza:'Terezo', barbora:'Barboro'
  };
  if (known[lower]) return known[lower];
  if (/[aá]$/.test(lower)) return first.slice(0, -1) + 'o';
  if (/ek$/.test(lower)) return first.slice(0, -2) + 'ku';
  if (/el$/.test(lower)) return first + 'i';
  if (/r$/.test(lower)) return first + 'e';
  return first;
}

function normalizeEmailGroup_(value, productName) {
  const group = String(value || '').trim().toUpperCase();
  if (['SLEPICKY', 'VCELICKY', 'FARMARI', 'VLASTNI'].includes(group)) return group;
  const name = String(productName || '').toLocaleLowerCase('cs-CZ');
  if (name.includes('vejce')) return 'SLEPICKY';
  if (/med|včel|propolis|vosk/i.test(name)) return 'VCELICKY';
  return 'FARMARI';
}

function emailSubjectForItem_(item, productMap) {
  const product = productMap && productMap[String(item.productId)];
  const group = normalizeEmailGroup_(item.emailGroup || (product && product.emailGroup), item.name || (product && product.name));
  if (group === 'SLEPICKY') return 'naše slepičky';
  if (group === 'VCELICKY') return 'naše včeličky';
  if (group === 'VLASTNI') return cleanText_(item.emailText || (product && product.emailText), 120) || 'podprosečští farmáři';
  return 'podprosečští farmáři';
}

function customerAnimalPhrase_(order) {
  const productMap = {};
  readProducts_().forEach(product => { productMap[String(product.id)] = product; });
  const subjects = [];
  (order.items || []).forEach(item => {
    const subject = emailSubjectForItem_(item, productMap);
    if (subject && subjects.indexOf(subject) === -1) subjects.push(subject);
  });
  if (!subjects.length) return 'podprosečští farmáři';
  if (subjects.length === 1) return subjects[0];
  if (subjects.length === 2) return subjects[0] + ' a ' + subjects[1];
  return subjects.slice(0, -1).join(', ') + ' a ' + subjects[subjects.length - 1];
}

function customerReadyWorkMessage_(order) {
  const subject = customerAnimalPhrase_(order);
  const verb = /farmáři/i.test(subject) ? 'dokončili' : 'dokončily';
  return `${subject} ${verb} práci.`;
}

function customerWorkMessage_(order) {
  return `${customerAnimalPhrase_(order)} na Vaší objednávce usilovně pracují. Den před vyzvednutím Vás budeme kontaktovat formou ${order.contactMethod === 'E-mail' ? 'e-mailu' : 'SMS'}.`;
}

function splitOrderMessage_(order) {
  if (!order.splitOrder) return '';
  return `Vaši objednávku jsme rozdělili na dvě vyzvednutí. Dostupné produkty připravíme na ${formatCustomerPickupDate_(order.pickup)} a předobjednané produkty po naskladnění, předpokládaně ${formatCustomerPickupDate_(order.preorderPickup)}.`;
}

function buildCustomerTextEmail_(order, id) {
  const greeting = firstNameVocative_(order.name);
  return [
    `Dobrý den${greeting ? ', ' + greeting : ''},`,
    '',
    customerWorkMessage_(order),
    ...(order.splitOrder ? ['', splitOrderMessage_(order)] : []),
    '',
    'Přehled objednávky:',
    ...order.items.map(item => `- ${item.qty}× ${item.name}: ${item.qty * item.price} Kč`),
    '',
    `Celkem: ${order.total} Kč`,
    `Termín vyzvednutí: ${formatCustomerPickupDate_(order.pickup)}`,
    ...(order.splitOrder ? [`Termín předobjednané části: ${formatCustomerPickupDate_(order.preorderPickup)}`] : []),
    `Způsob kontaktu před vyzvednutím: ${order.contactMethod}`,
    `Číslo objednávky: ${id}`,
    '',
    'Děkujeme za Vaši objednávku.',
    '',
    'S přáním krásného dne',
    '',
    'Martin Dvořák',
    CONFIG.BRAND_NAME,
    'Poctivé produkty od našich včel, slepiček a ze zahrádky.'
  ].join('\n');
}

function buildCustomerHtmlEmail_(order, id) {
  const greeting = firstNameVocative_(order.name);
  const rows = order.items.map(item => `<tr><td style="padding:9px 0;border-bottom:1px solid #eadfce">${escapeHtml_(item.qty + '× ' + item.name)}</td><td style="padding:9px 0;border-bottom:1px solid #eadfce;text-align:right;font-weight:700">${item.qty * item.price} Kč</td></tr>`).join('');
  const split = order.splitOrder ? `<p style="padding:16px;background:#eef7ff;border-radius:12px"><b>${escapeHtml_(splitOrderMessage_(order))}</b></p>` : '';
  return `<div style="font-family:Arial,sans-serif;max-width:620px;margin:auto;color:#2b241f;line-height:1.55"><div style="background:#f3b72e;padding:22px 26px;border-radius:18px 18px 0 0"><h1 style="font-size:24px;margin:0">${escapeHtml_(CONFIG.BRAND_NAME)}</h1></div><div style="padding:26px;border:1px solid #eadfce;border-top:0;border-radius:0 0 18px 18px"><p>Dobrý den${greeting ? ', <b>' + escapeHtml_(greeting) + '</b>' : ''},</p><p style="padding:16px;background:#fff8e5;border-radius:12px"><b>${escapeHtml_(customerWorkMessage_(order))}</b></p>${split}<table style="width:100%;border-collapse:collapse;margin-top:18px">${rows}</table><p style="font-size:22px;text-align:right"><b>Celkem: ${order.total} Kč</b></p><p><b>Termín vyzvednutí:</b> ${escapeHtml_(formatCustomerPickupDate_(order.pickup))}${order.splitOrder ? `<br><b>Termín předobjednané části:</b> ${escapeHtml_(formatCustomerPickupDate_(order.preorderPickup))}` : ''}<br><b>Kontakt před vyzvednutím:</b> ${escapeHtml_(order.contactMethod)}<br><b>Číslo objednávky:</b> ${escapeHtml_(id)}</p><p style="margin-top:28px">Děkujeme za Vaši objednávku.</p><p style="margin-top:24px">S přáním krásného dne<br><b>Martin Dvořák</b><br>${escapeHtml_(CONFIG.BRAND_NAME)}<br><i>Poctivé produkty od našich včel, slepiček a ze zahrádky.</i></p></div></div>`;
}

function formatCustomerPickupDate_(dateKey) {
  if (!dateKey || !isValidDateKey_(dateKey)) return 'bude upřesněn';
  const parts = String(dateKey).split('-').map(Number);
  return `${parts[2]}. ${parts[1]}. ${parts[0]}`;
}

function escapeHtml_(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
