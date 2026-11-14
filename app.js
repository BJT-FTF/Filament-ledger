/* Filament Ledger
 * Offline PWA for tracking 3D-printer filament cost and spool remainder.
 * Amounts are Australian dollars; weights are grams.
 */
(function (global) {
  "use strict";

  var STORAGE_KEY = "filament-ledger-v1";
  var MATERIALS = [
    "PPA-CF", "PA-CF", "PA", "PETG", "PETG-CF", "PLA", "PLA-CF", "PLA-HF",
    "ABS", "ASA", "PC", "PC-CF", "TPU", "PVA", "Support", "Other"
  ];

  function createId() {
    if (global.crypto && typeof global.crypto.randomUUID === "function") {
      return global.crypto.randomUUID();
    }
    return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
  }

  function todayISO() {
    var d = new Date();
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, "0");
    var day = String(d.getDate()).padStart(2, "0");
    return y + "-" + m + "-" + day;
  }

  function nowISO() {
    return new Date().toISOString();
  }

  function toNumber(v, fallback) {
    var n = typeof v === "number" ? v : parseFloat(String(v).replace(/,/g, ""));
    return Number.isFinite(n) ? n : fallback;
  }

  function roundMoney(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function roundGrams(n) {
    return Math.round((Number(n) + Number.EPSILON) * 10) / 10;
  }

  var audFormat = new Intl.NumberFormat("en-AU", {
    style: "currency",
    currency: "AUD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });

  function formatAUD(n) {
    if (!Number.isFinite(Number(n))) return "—";
    return audFormat.format(Number(n));
  }

  function formatPerGram(n) {
    if (!Number.isFinite(Number(n))) return "—";
    return new Intl.NumberFormat("en-AU", {
      style: "currency",
      currency: "AUD",
      minimumFractionDigits: 2,
      maximumFractionDigits: 4
    }).format(Number(n)) + "/g";
  }

  function formatGrams(n) {
    if (!Number.isFinite(Number(n))) return "—";
    var v = Number(n);
    var s = Math.abs(v - Math.round(v)) < 1e-9 ? String(Math.round(v)) : v.toFixed(1);
    return s + " g";
  }

  function formatPercent(n) {
    if (!Number.isFinite(Number(n))) return "—";
    return (Math.round(Number(n) * 10) / 10) + "%";
  }

  function formatDateAU(iso) {
    if (!iso) return "—";
    var part = String(iso).slice(0, 10);
    var bits = part.split("-");
    if (bits.length !== 3) return part;
    return bits[2] + "/" + bits[1] + "/" + bits[0];
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c];
    });
  }

  function costPerGram(spool) {
    var price = toNumber(spool && spool.priceAUD, NaN);
    var grams = toNumber(spool && spool.netGrams, NaN);
    if (!Number.isFinite(price) || !Number.isFinite(grams) || grams <= 0) return NaN;
    return price / grams;
  }

  function printCost(grams, cpg) {
    var g = toNumber(grams, NaN);
    var c = toNumber(cpg, NaN);
    if (!Number.isFinite(g) || !Number.isFinite(c)) return NaN;
    return roundMoney(g * c);
  }

  function percentLeft(spool) {
    var rem = toNumber(spool && spool.remainingGrams, NaN);
    var net = toNumber(spool && spool.netGrams, NaN);
    if (!Number.isFinite(rem) || !Number.isFinite(net) || net <= 0) return NaN;
    return (rem / net) * 100;
  }

  function remainingValue(spool) {
    var rem = toNumber(spool && spool.remainingGrams, NaN);
    var cpg = costPerGram(spool);
    if (!Number.isFinite(rem) || !Number.isFinite(cpg)) return NaN;
    return roundMoney(rem * cpg);
  }

  function isLow(spool, threshold) {
    if (spool && spool.archived) return false;
    var p = percentLeft(spool);
    return Number.isFinite(p) && p <= toNumber(threshold, 15);
  }

  function defaultSettings() {
    return { lowSpoolPercent: 15, theme: "system" };
  }

  function emptyState() {
    return { version: 1, settings: defaultSettings(), spools: [], prints: [], adjustments: [] };
  }

  function exampleSpool() {
    return {
      id: createId(),
      name: "Example spool (safe to delete)",
      brand: "Bambu Lab",
      material: "PPA-CF",
      colour: "Black",
      colourHex: "#1a1a1a",
      priceAUD: 240,
      netGrams: 750,
      remainingGrams: 750,
      purchaseDate: "",
      notes: "Sample data so you can try the calculator and print log. Delete anytime.",
      archived: false,
      createdAt: nowISO(),
      updatedAt: nowISO()
    };
  }

  function normalizeState(raw) {
    var base = emptyState();
    if (!raw || typeof raw !== "object") return base;
    var settings = Object.assign(defaultSettings(), raw.settings || {});
    settings.lowSpoolPercent = toNumber(settings.lowSpoolPercent, 15);
    if (settings.lowSpoolPercent < 1) settings.lowSpoolPercent = 1;
    if (settings.lowSpoolPercent > 50) settings.lowSpoolPercent = 50;
    if (["system", "light", "dark"].indexOf(settings.theme) === -1) settings.theme = "system";
    return {
      version: 1,
      settings: settings,
      spools: Array.isArray(raw.spools) ? raw.spools.map(normalizeSpool).filter(Boolean) : [],
      prints: Array.isArray(raw.prints) ? raw.prints.map(normalizePrint).filter(Boolean) : [],
      adjustments: Array.isArray(raw.adjustments) ? raw.adjustments.map(normalizeAdj).filter(Boolean) : []
    };
  }

  function normalizeSpool(s) {
    if (!s || typeof s !== "object") return null;
    var net = Math.max(0, toNumber(s.netGrams, 0));
    var rem = toNumber(s.remainingGrams, net);
    if (!Number.isFinite(rem)) rem = net;
    return {
      id: s.id || createId(),
      name: String(s.name || "").trim() || "Untitled spool",
      brand: String(s.brand || "").trim(),
      material: String(s.material || "").trim() || "Other",
      colour: String(s.colour || s.color || "").trim(),
      colourHex: String(s.colourHex || s.colorHex || "").trim(),
      priceAUD: Math.max(0, toNumber(s.priceAUD, 0)),
      netGrams: net,
      remainingGrams: rem,
      purchaseDate: String(s.purchaseDate || "").slice(0, 10),
      notes: String(s.notes || ""),
      archived: Boolean(s.archived),
      createdAt: s.createdAt || nowISO(),
      updatedAt: s.updatedAt || s.createdAt || nowISO()
    };
  }

  function normalizePrint(p) {
    if (!p || typeof p !== "object") return null;
    return {
      id: p.id || createId(),
      spoolId: p.spoolId || "",
      spoolName: String(p.spoolName || ""),
      material: String(p.material || ""),
      partName: String(p.partName || "").trim() || "Untitled part",
      gramsUsed: Math.max(0, toNumber(p.gramsUsed, 0)),
      costAUD: roundMoney(toNumber(p.costAUD, 0)),
      date: String(p.date || todayISO()).slice(0, 10),
      job: String(p.job || p.customer || "").trim(),
      notes: String(p.notes || ""),
      success: p.success !== false,
      createdAt: p.createdAt || nowISO(),
      updatedAt: p.updatedAt || p.createdAt || nowISO()
    };
  }

  function normalizeAdj(a) {
    if (!a || typeof a !== "object") return null;
    return {
      id: a.id || createId(),
      spoolId: a.spoolId || "",
      previousGrams: toNumber(a.previousGrams, 0),
      newGrams: toNumber(a.newGrams, 0),
      date: String(a.date || todayISO()).slice(0, 10),
      notes: String(a.notes || ""),
      createdAt: a.createdAt || nowISO()
    };
  }

  function findSpool(state, id) {
    return state.spools.find(function (s) { return s.id === id; }) || null;
  }

  function findPrint(state, id) {
    return state.prints.find(function (p) { return p.id === id; }) || null;
  }

  function snapshotSpool(spool) {
    var label = [spool.brand, spool.name].filter(Boolean).join(" ").trim() || spool.name;
    return { spoolName: label, material: spool.material };
  }

  function addSpool(state, data) {
    var seed = Object.assign({ remainingGrams: toNumber(data && data.netGrams, 0) }, data, {
      id: createId(),
      archived: false,
      createdAt: nowISO(),
      updatedAt: nowISO()
    });
    var spool = normalizeSpool(seed);
    state.spools.unshift(spool);
    return spool;
  }

  function refreshPrintCosts(state, spoolId) {
    var spool = findSpool(state, spoolId);
    if (!spool) return;
    var cpg = costPerGram(spool);
    var snap = snapshotSpool(spool);
    state.prints.forEach(function (p) {
      if (p.spoolId === spoolId) {
        p.costAUD = printCost(p.gramsUsed, cpg);
        p.spoolName = snap.spoolName;
        p.material = spool.material;
      }
    });
  }

  function updateSpool(state, id, data) {
    var spool = findSpool(state, id);
    if (!spool) throw new Error("Spool not found");
    var next = normalizeSpool(Object.assign({}, spool, data, {
      id: spool.id,
      createdAt: spool.createdAt,
      updatedAt: nowISO()
    }));
    Object.assign(spool, next);
    refreshPrintCosts(state, id);
    return spool;
  }

  function archiveSpool(state, id, archived) {
    var spool = findSpool(state, id);
    if (!spool) throw new Error("Spool not found");
    spool.archived = Boolean(archived);
    spool.updatedAt = nowISO();
    return spool;
  }

  function deleteSpool(state, id) {
    var idx = state.spools.findIndex(function (s) { return s.id === id; });
    if (idx === -1) throw new Error("Spool not found");
    var spool = state.spools[idx];
    var linked = state.prints.filter(function (p) { return p.spoolId === id; });
    var snap = snapshotSpool(spool);
    linked.forEach(function (p) {
      if (!p.spoolName) p.spoolName = snap.spoolName;
      if (!p.material) p.material = spool.material;
      p.spoolId = "";
    });
    state.adjustments = state.adjustments.filter(function (a) { return a.spoolId !== id; });
    state.spools.splice(idx, 1);
    return { removed: spool, unlinkedPrints: linked.length };
  }

  function adjustRemaining(state, id, newGrams, notes, date) {
    var spool = findSpool(state, id);
    if (!spool) throw new Error("Spool not found");
    var previous = spool.remainingGrams;
    var next = toNumber(newGrams, NaN);
    if (!Number.isFinite(next) || next < 0) throw new Error("Remaining grams must be 0 or more");
    spool.remainingGrams = roundGrams(next);
    spool.updatedAt = nowISO();
    var adj = {
      id: createId(),
      spoolId: id,
      previousGrams: previous,
      newGrams: spool.remainingGrams,
      date: date || todayISO(),
      notes: notes || "",
      createdAt: nowISO()
    };
    state.adjustments.unshift(adj);
    return { spool: spool, adjustment: adj };
  }

  function addPrint(state, data) {
    var spool = findSpool(state, data.spoolId);
    if (!spool) throw new Error("Choose a spool");
    var grams = toNumber(data.gramsUsed, NaN);
    if (!Number.isFinite(grams) || grams <= 0) throw new Error("Grams used must be greater than 0");
    var cpg = costPerGram(spool);
    var snap = snapshotSpool(spool);
    var print = normalizePrint({
      id: createId(),
      spoolId: spool.id,
      spoolName: snap.spoolName,
      material: snap.material,
      partName: data.partName,
      gramsUsed: grams,
      costAUD: printCost(grams, cpg),
      date: data.date || todayISO(),
      job: data.job,
      notes: data.notes,
      success: data.success !== false,
      createdAt: nowISO(),
      updatedAt: nowISO()
    });
    spool.remainingGrams = roundGrams(spool.remainingGrams - grams);
    spool.updatedAt = nowISO();
    state.prints.unshift(print);
    return print;
  }

  function updatePrint(state, id, data) {
    var print = findPrint(state, id);
    if (!print) throw new Error("Print not found");
    var oldSpool = findSpool(state, print.spoolId);
    if (oldSpool) {
      oldSpool.remainingGrams = roundGrams(oldSpool.remainingGrams + print.gramsUsed);
      oldSpool.updatedAt = nowISO();
    }
    var nextSpoolId = data.spoolId !== undefined ? data.spoolId : print.spoolId;
    var spool = findSpool(state, nextSpoolId);
    if (!spool) throw new Error("Choose a spool");
    var grams = toNumber(data.gramsUsed !== undefined ? data.gramsUsed : print.gramsUsed, NaN);
    if (!Number.isFinite(grams) || grams <= 0) throw new Error("Grams used must be greater than 0");
    var cpg = costPerGram(spool);
    var snap = snapshotSpool(spool);
    Object.assign(print, {
      spoolId: spool.id,
      spoolName: snap.spoolName,
      material: snap.material,
      partName: data.partName !== undefined ? (String(data.partName).trim() || "Untitled part") : print.partName,
      gramsUsed: grams,
      costAUD: printCost(grams, cpg),
      date: data.date !== undefined ? String(data.date).slice(0, 10) : print.date,
      job: data.job !== undefined ? String(data.job).trim() : print.job,
      notes: data.notes !== undefined ? String(data.notes) : print.notes,
      success: data.success !== undefined ? Boolean(data.success) : print.success,
      updatedAt: nowISO()
    });
    spool.remainingGrams = roundGrams(spool.remainingGrams - grams);
    spool.updatedAt = nowISO();
    return print;
  }

  function deletePrint(state, id) {
    var idx = state.prints.findIndex(function (p) { return p.id === id; });
    if (idx === -1) throw new Error("Print not found");
    var print = state.prints[idx];
    var spool = findSpool(state, print.spoolId);
    if (spool) {
      spool.remainingGrams = roundGrams(spool.remainingGrams + print.gramsUsed);
      spool.updatedAt = nowISO();
    }
    state.prints.splice(idx, 1);
    return print;
  }

  function calculate(input) {
    var cpg = NaN;
    var source = "manual";
    if (input.spool) {
      cpg = costPerGram(input.spool);
      source = "spool";
    } else {
      cpg = costPerGram({ priceAUD: input.priceAUD, netGrams: input.netGrams });
    }
    var grams = toNumber(input.grams, NaN);
    return { costPerGram: cpg, grams: grams, cost: printCost(grams, cpg), source: source };
  }

  function loggedGramsForSpool(state, spoolId) {
    return roundGrams(state.prints
      .filter(function (p) { return p.spoolId === spoolId; })
      .reduce(function (sum, p) { return sum + toNumber(p.gramsUsed, 0); }, 0));
  }

  function summarize(state) {
    var threshold = state.settings.lowSpoolPercent;
    var allSpools = state.spools;
    var active = allSpools.filter(function (s) { return !s.archived; });
    var totalSpend = roundMoney(allSpools.reduce(function (sum, s) { return sum + toNumber(s.priceAUD, 0); }, 0));
    var remainingValueTotal = roundMoney(active.reduce(function (sum, s) {
      var v = remainingValue(s);
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0));
    var prints = state.prints.slice();
    var totalGramsPrinted = roundGrams(prints.reduce(function (sum, p) { return sum + toNumber(p.gramsUsed, 0); }, 0));
    var successfulGrams = roundGrams(prints.filter(function (p) { return p.success; }).reduce(function (sum, p) { return sum + toNumber(p.gramsUsed, 0); }, 0));
    var failedGrams = roundGrams(prints.filter(function (p) { return !p.success; }).reduce(function (sum, p) { return sum + toNumber(p.gramsUsed, 0); }, 0));
    var totalPrintCost = roundMoney(prints.reduce(function (sum, p) { return sum + toNumber(p.costAUD, 0); }, 0));
    var failedCost = roundMoney(prints.filter(function (p) { return !p.success; }).reduce(function (sum, p) { return sum + toNumber(p.costAUD, 0); }, 0));

    function group(rows, keyFn, nameKey) {
      var map = {};
      rows.forEach(function (p) {
        var key = keyFn(p);
        if (!map[key]) {
          map[key] = { grams: 0, cost: 0, count: 0 };
          map[key][nameKey] = key;
        }
        map[key].grams += p.gramsUsed;
        map[key].cost += p.costAUD;
        map[key].count += 1;
      });
      return Object.keys(map).map(function (k) {
        var r = map[k];
        r.grams = roundGrams(r.grams);
        r.cost = roundMoney(r.cost);
        return r;
      }).sort(function (a, b) { return b.cost - a.cost; });
    }

    var lowSpools = active.filter(function (s) { return isLow(s, threshold); })
      .sort(function (a, b) { return percentLeft(a) - percentLeft(b); });

    return {
      totalSpend: totalSpend,
      remainingValueTotal: remainingValueTotal,
      consumedValue: roundMoney(totalSpend - remainingValueTotal),
      totalGramsPrinted: totalGramsPrinted,
      successfulGrams: successfulGrams,
      failedGrams: failedGrams,
      totalPrintCost: totalPrintCost,
      failedCost: failedCost,
      materialRows: group(prints, function (p) { return p.material || "Unknown"; }, "material"),
      jobRows: group(prints, function (p) { return p.job || "(No job)"; }, "job"),
      partRows: group(prints, function (p) { return p.partName || "Untitled part"; }, "part"),
      lowSpools: lowSpools,
      spoolCount: active.length,
      archivedCount: allSpools.length - active.length,
      printCount: prints.length
    };
  }

  function exportPayload(state) {
    return {
      app: "filament-ledger",
      version: 1,
      exportedAt: nowISO(),
      settings: state.settings,
      spools: state.spools,
      prints: state.prints,
      adjustments: state.adjustments
    };
  }

  function importPayload(current, payload, mode) {
    if (!payload || typeof payload !== "object") throw new Error("Invalid backup file");
    if (payload.app && payload.app !== "filament-ledger") {
      if (!payload.spools && !payload.prints) throw new Error("This file is not a Filament Ledger backup");
    }
    var incoming = normalizeState(payload);
    if (mode === "replace") return incoming;
    var next = normalizeState(current);
    var spoolMap = new Map(next.spools.map(function (s) { return [s.id, s]; }));
    incoming.spools.forEach(function (s) { spoolMap.set(s.id, s); });
    next.spools = Array.from(spoolMap.values());
    var printMap = new Map(next.prints.map(function (p) { return [p.id, p]; }));
    incoming.prints.forEach(function (p) { printMap.set(p.id, p); });
    next.prints = Array.from(printMap.values()).sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt));
    });
    var adjMap = new Map(next.adjustments.map(function (a) { return [a.id, a]; }));
    incoming.adjustments.forEach(function (a) { adjMap.set(a.id, a); });
    next.adjustments = Array.from(adjMap.values());
    next.settings = Object.assign({}, next.settings, incoming.settings);
    return next;
  }

  function csvEscape(v) {
    var s = String(v == null ? "" : v);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  function exportPrintsCSV(state) {
    var headers = ["Date", "Part", "Job", "Spool", "Material", "Grams", "Cost (AUD)", "Status", "Notes"];
    var lines = [headers.join(",")];
    var rows = state.prints.slice().sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt));
    });
    rows.forEach(function (p) {
      lines.push([
        formatDateAU(p.date),
        p.partName,
        p.job,
        p.spoolName,
        p.material,
        p.gramsUsed,
        toNumber(p.costAUD, 0).toFixed(2),
        p.success ? "Success" : "Failed",
        p.notes
      ].map(csvEscape).join(","));
    });
    return lines.join("\r\n") + "\r\n";
  }

  function loadState() {
    if (typeof localStorage === "undefined") return emptyState();
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyState();
      return normalizeState(JSON.parse(raw));
    } catch (err) {
      return emptyState();
    }
  }

  function saveState(state) {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  }

  var api = {
    STORAGE_KEY: STORAGE_KEY,
    MATERIALS: MATERIALS,
    createId: createId,
    todayISO: todayISO,
    nowISO: nowISO,
    toNumber: toNumber,
    roundMoney: roundMoney,
    roundGrams: roundGrams,
    formatAUD: formatAUD,
    formatPerGram: formatPerGram,
    formatGrams: formatGrams,
    formatPercent: formatPercent,
    formatDateAU: formatDateAU,
    esc: esc,
    costPerGram: costPerGram,
    printCost: printCost,
    percentLeft: percentLeft,
    remainingValue: remainingValue,
    isLow: isLow,
    emptyState: emptyState,
    exampleSpool: exampleSpool,
    normalizeState: normalizeState,
    findSpool: findSpool,
    findPrint: findPrint,
    addSpool: addSpool,
    updateSpool: updateSpool,
    archiveSpool: archiveSpool,
    deleteSpool: deleteSpool,
    adjustRemaining: adjustRemaining,
    addPrint: addPrint,
    updatePrint: updatePrint,
    deletePrint: deletePrint,
    calculate: calculate,
    summarize: summarize,
    loggedGramsForSpool: loggedGramsForSpool,
    exportPayload: exportPayload,
    importPayload: importPayload,
    exportPrintsCSV: exportPrintsCSV,
    loadState: loadState,
    saveState: saveState
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  global.FilamentLedger = api;

  if (typeof document === "undefined") return;

  var state = loadState();
  var currentView = "spools";
  var showArchived = false;
  var printFilter = { spoolId: "", q: "" };
  var calcForm = { spoolId: "", priceAUD: "", netGrams: "", grams: "" };
  var installEvent = null;
  var toastTimer = null;

  function persist() {
    try {
      saveState(state);
    } catch (err) {
      toast("Could not save — storage may be full");
    }
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $all(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  function applyTheme() {
    var theme = state.settings.theme || "system";
    if (theme === "system") document.documentElement.removeAttribute("data-theme");
    else document.documentElement.setAttribute("data-theme", theme);
    var meta = $all('meta[name="theme-color"]');
    var dark = theme === "dark" || (theme === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var color = dark ? "#14100e" : "#f4efe8";
    meta.forEach(function (m) { m.setAttribute("content", color); });
  }

  function toast(msg) {
    var el = $("#toast");
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.hidden = true; }, 2600);
  }

  function closeMenu() {
    var menu = $("#app-menu");
    menu.hidden = true;
    $("#menu-btn").setAttribute("aria-expanded", "false");
  }

  function toggleMenu() {
    var menu = $("#app-menu");
    var open = menu.hidden;
    menu.hidden = !open;
    $("#menu-btn").setAttribute("aria-expanded", open ? "true" : "false");
  }

  function setView(name) {
    currentView = name;
    $all(".view").forEach(function (v) { v.hidden = v.getAttribute("data-view") !== name; });
    $all(".tab-btn").forEach(function (b) { b.classList.toggle("is-active", b.getAttribute("data-nav") === name); });
    if (location.hash !== "#" + name) {
      try { history.replaceState(null, "", "#" + name); } catch (e) { /* ignore */ }
    }
    render();
  }

  function activeSpools() {
    return state.spools.filter(function (s) { return !s.archived; });
  }

  function spoolLabel(s) {
    var bits = [];
    if (s.brand) bits.push(s.brand);
    bits.push(s.name);
    if (s.material) bits.push("(" + s.material + ")");
    return bits.join(" ");
  }

  function barClass(pct) {
    if (!Number.isFinite(pct)) return "bar";
    if (pct <= state.settings.lowSpoolPercent) return "bar is-low";
    if (pct <= 30) return "bar is-mid";
    return "bar";
  }

  function materialOptions(selected, allowCustom) {
    var val = selected || "";
    var known = MATERIALS.indexOf(val) !== -1;
    var html = MATERIALS.map(function (m) {
      return '<option value="' + esc(m) + '"' + (m === val ? " selected" : "") + ">" + esc(m) + "</option>";
    }).join("");
    if (allowCustom && val && !known) {
      html += '<option value="' + esc(val) + '" selected>' + esc(val) + "</option>";
    }
    html += '<option value="__custom__">Custom…</option>';
    return html;
  }

  function spoolOptions(selectedId, includeArchived, includeEmpty) {
    var list = includeArchived ? state.spools.slice() : activeSpools();
    var html = includeEmpty ? '<option value="">Select a spool</option>' : "";
    list.forEach(function (s) {
      var rem = formatGrams(s.remainingGrams) + " left";
      var label = spoolLabel(s) + (s.archived ? " (archived)" : "") + " — " + rem;
      html += '<option value="' + esc(s.id) + '"' + (s.id === selectedId ? " selected" : "") + ">" + esc(label) + "</option>";
    });
    if (selectedId && !list.some(function (s) { return s.id === selectedId; })) {
      var gone = findSpool(state, selectedId);
      if (gone) {
        html += '<option value="' + esc(gone.id) + '" selected>' + esc(spoolLabel(gone)) + "</option>";
      }
    }
    return html;
  }

  function renderSpools() {
    var el = $("#view-spools");
    var list = state.spools.filter(function (s) { return showArchived || !s.archived; });
    var low = activeSpools().filter(function (s) { return isLow(s, state.settings.lowSpoolPercent); });
    var html = '<div class="toolbar"><h2>Spools</h2><div class="row">' +
      '<label class="btn btn-ghost btn-sm switch-row" style="min-height:2.25rem;padding:0 0.7rem;gap:0.4rem">' +
      '<input type="checkbox" id="toggle-archived"' + (showArchived ? " checked" : "") + '> Archived</label>' +
      '<button type="button" class="btn btn-primary" data-open="spool-new">Add spool</button></div></div>';

    if (low.length) {
      html += '<div class="alert" style="margin-bottom:0.85rem">Low filament: ' +
        low.map(function (s) { return esc(s.name) + " (" + esc(formatPercent(percentLeft(s))) + ")"; }).join(", ") +
        ".</div>";
    }

    if (!list.length) {
      html += '<div class="card empty"><h3>No spools yet</h3>' +
        "<p>Add a roll with the price you paid and its net weight. The app works out cost per gram and tracks what’s left as you log prints.</p>" +
        '<div class="row" style="justify-content:center">' +
        '<button type="button" class="btn btn-primary" data-open="spool-new">Add spool</button>' +
        '<button type="button" class="btn" id="add-example">Add example spool</button>' +
        "</div>" +
        '<p class="hint">The example is a 750 g Bambu PPA-CF roll at $240. It’s clearly labelled and safe to delete.</p>' +
        "</div>";
    } else {
      html += '<div class="card-list">' + list.map(spoolCardHtml).join("") + "</div>";
    }
    el.innerHTML = html;
  }

  function spoolCardHtml(s) {
    var pct = percentLeft(s);
    var low = isLow(s, state.settings.lowSpoolPercent);
    var badges = "";
    if (s.archived) badges += '<span class="badge badge-muted">Finished</span>';
    else if (low) badges += '<span class="badge badge-low">Low</span>';
    var swatch = s.colourHex
      ? '<span class="swatch" style="background:' + esc(s.colourHex) + '" title="' + esc(s.colour || s.colourHex) + '"></span>'
      : '<span class="swatch" title="No colour set"></span>';
    var sub = [s.brand, s.material, s.colour].filter(Boolean).join(" · ");
    return '<article class="card" data-spool="' + esc(s.id) + '">' +
      '<button type="button" class="card-click" data-open="spool-detail" data-id="' + esc(s.id) + '">' +
      '<div class="spool-top"><div class="spool-title">' + swatch + '<div>' +
      '<h3 class="spool-name">' + esc(s.name) + "</h3>" +
      (sub ? '<p class="meta">' + esc(sub) + "</p>" : "") +
      "</div></div>" + badges + "</div>" +
      '<div class="spool-stats">' +
      '<div><span class="stat-label">Cost / g</span><div class="stat-value">' + esc(formatPerGram(costPerGram(s))) + "</div></div>" +
      '<div><span class="stat-label">Remaining</span><div class="stat-value">' + esc(formatGrams(s.remainingGrams)) + "</div></div>" +
      '<div><span class="stat-label">Value left</span><div class="stat-value">' + esc(formatAUD(remainingValue(s))) + "</div></div>" +
      "</div>" +
      '<div class="' + barClass(pct) + '"><span style="width:' + Math.max(0, Math.min(100, pct || 0)) + '%"></span></div>' +
      '<div class="bar-label"><span>' + esc(formatGrams(s.remainingGrams)) + " of " + esc(formatGrams(s.netGrams)) + "</span><span>" +
      esc(formatPercent(pct)) + " left</span></div>" +
      "</button>" +
      '<div class="card-actions">' +
      (s.archived ? "" : '<button type="button" class="btn btn-sm btn-primary" data-open="print-new" data-spool="' + esc(s.id) + '">Log print</button>') +
      '<button type="button" class="btn btn-sm" data-open="adjust" data-id="' + esc(s.id) + '">Adjust remaining</button>' +
      "</div></article>";
  }

  function renderPrints() {
    var el = $("#view-prints");
    var html = '<div class="toolbar"><h2>Print log</h2>' +
      '<button type="button" class="btn btn-primary" data-open="print-new">Log print</button></div>';
    html += '<div class="filter-bar">' +
      '<select id="filter-spool" aria-label="Filter by spool">' +
      '<option value="">All spools</option>' + spoolOptions(printFilter.spoolId, true, false) +
      "</select>" +
      '<input type="text" id="filter-q" placeholder="Search part, job, notes" value="' + esc(printFilter.q) + '" aria-label="Search prints">' +
      "</div>";
    html += '<div id="print-list"></div>';
    el.innerHTML = html;
    fillPrintList();
  }

  function fillPrintList() {
    var box = document.getElementById("print-list");
    if (!box) return;
    var rows = state.prints.slice().sort(function (a, b) {
      return String(b.date).localeCompare(String(a.date)) || String(b.createdAt).localeCompare(String(a.createdAt));
    });
    if (printFilter.spoolId) rows = rows.filter(function (p) { return p.spoolId === printFilter.spoolId; });
    if (printFilter.q) {
      var q = printFilter.q.toLowerCase();
      rows = rows.filter(function (p) {
        return [p.partName, p.job, p.spoolName, p.material, p.notes].join(" ").toLowerCase().indexOf(q) !== -1;
      });
    }
    if (!state.prints.length) {
      box.innerHTML = '<div class="card empty"><h3>No prints logged</h3><p>After a slice, log the grams used against a spool. The cost is grams × cost per gram, and that weight comes off the remainder.</p></div>';
    } else if (!rows.length) {
      box.innerHTML = '<div class="card empty"><h3>No matching prints</h3><p>Try clearing the filter or search.</p></div>';
    } else {
      box.innerHTML = '<div class="card-list">' + rows.map(function (p) {
        return '<article class="card' + (p.success ? "" : " print-failed") + '">' +
          '<div class="print-item"><div>' +
          '<h3 class="spool-name">' + esc(p.partName) + "</h3>" +
          '<p class="meta">' + esc(formatDateAU(p.date)) + " · " + esc(p.spoolName || "Deleted spool") +
          (p.job ? " · " + esc(p.job) : "") +
          " · " + esc(formatGrams(p.gramsUsed)) +
          (p.success ? "" : " · Failed") + "</p>" +
          (p.notes ? '<p class="meta">' + esc(p.notes) + "</p>" : "") +
          '</div><div class="cost">' + esc(formatAUD(p.costAUD)) + "</div></div>" +
          '<div class="card-actions">' +
          '<button type="button" class="btn btn-sm" data-open="print-edit" data-id="' + esc(p.id) + '">Edit</button>' +
          '<button type="button" class="btn btn-sm btn-danger" data-action="delete-print" data-id="' + esc(p.id) + '">Delete</button>' +
          "</div></article>";
      }).join("") + "</div>";
    }
  }

  function renderCalc() {
    var el = $("#view-calc");
    var spool = calcForm.spoolId ? findSpool(state, calcForm.spoolId) : null;
    var input = spool
      ? { spool: spool, grams: calcForm.grams }
      : { priceAUD: calcForm.priceAUD, netGrams: calcForm.netGrams, grams: calcForm.grams };
    var result = calculate(input);
    var hasResult = Number.isFinite(result.cost);
    var html = "<h2>Quick calculator</h2>" +
      "<p class=\"meta\" style=\"margin:0.3rem 0 1rem\">Work out a slice cost without logging it. Pick a saved spool, or type a price and roll size.</p>" +
      '<div class="card"><div class="form-grid">' +
      '<label class="field">Spool<select id="calc-spool"><option value="">Enter price &amp; weight manually</option>' +
      spoolOptions(calcForm.spoolId, false, false) + "</select></label>";
    if (!spool) {
      html += '<div class="form-grid two">' +
        '<label class="field">Price paid (AUD)<input type="number" id="calc-price" inputmode="decimal" min="0" step="0.01" value="' + esc(calcForm.priceAUD) + '"></label>' +
        '<label class="field">Spool net weight (g)<input type="number" id="calc-net" inputmode="decimal" min="0" step="1" value="' + esc(calcForm.netGrams) + '"></label>' +
        "</div>";
    } else {
      html += '<div class="live-cost">Using ' + esc(spoolLabel(spool)) + " at <strong>" +
        esc(formatPerGram(costPerGram(spool))) + "</strong> · " + esc(formatGrams(spool.remainingGrams)) + " remaining</div>";
    }
    html += '<label class="field">Slice weight (g)<input type="number" id="calc-grams" inputmode="decimal" min="0" step="0.1" value="' + esc(calcForm.grams) + '"></label>' +
      "</div></div>";
    html += '<div class="calc-result" id="calc-result"></div>';
    el.innerHTML = html;
    updateCalcResult();
  }

  function updateCalcResult() {
    var box = document.getElementById("calc-result");
    if (!box) return;
    var spool = calcForm.spoolId ? findSpool(state, calcForm.spoolId) : null;
    var input = spool
      ? { spool: spool, grams: calcForm.grams }
      : { priceAUD: calcForm.priceAUD, netGrams: calcForm.netGrams, grams: calcForm.grams };
    var result = calculate(input);
    var hasResult = Number.isFinite(result.cost);
    var html = '<div class="amount">' + (hasResult ? esc(formatAUD(result.cost)) : "$0.00") + "</div>" +
      '<div class="breakdown">' +
      (Number.isFinite(result.costPerGram) && Number.isFinite(result.grams)
        ? esc(formatGrams(result.grams)) + " × " + esc(formatPerGram(result.costPerGram))
        : "Enter a weight to see the cost") +
      "</div>";
    if (hasResult && spool) {
      html += '<div style="margin-top:1rem"><button type="button" class="btn btn-primary" data-open="print-new" data-spool="' +
        esc(spool.id) + '" data-grams="' + esc(result.grams) + '">Log this print</button></div>';
    }
    box.innerHTML = html;
  }

  function renderSummary() {
    var el = $("#view-summary");
    var sum = summarize(state);
    function table(rows, nameKey, nameLabel) {
      if (!rows.length) return '<p class="muted">Nothing logged yet.</p>';
      return '<div class="table-wrap"><table class="data"><thead><tr><th>' + nameLabel +
        '</th><th class="num">Prints</th><th class="num">Grams</th><th class="num">Cost</th></tr></thead><tbody>' +
        rows.map(function (r) {
          return "<tr><td>" + esc(r[nameKey]) + '</td><td class="num">' + r.count +
            '</td><td class="num">' + esc(formatGrams(r.grams)) + '</td><td class="num">' + esc(formatAUD(r.cost)) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    var html = "<h2>Summary</h2>" +
      '<div class="stat-grid" style="margin-top:0.9rem">' +
      statCard("Spent on filament", formatAUD(sum.totalSpend), sum.spoolCount + " active · " + sum.archivedCount + " finished") +
      statCard("Value remaining", formatAUD(sum.remainingValueTotal), "Active spools") +
      statCard("Grams printed", formatGrams(sum.totalGramsPrinted), sum.printCount + " logs · " + formatGrams(sum.failedGrams) + " failed") +
      statCard("Cost of prints", formatAUD(sum.totalPrintCost), sum.failedCost ? (formatAUD(sum.failedCost) + " of that failed") : "All logged jobs") +
      "</div>";
    if (sum.lowSpools.length) {
      html += '<div class="card" style="margin-bottom:1rem"><h3 class="spool-name">Low spools</h3>' +
        '<p class="meta">Warning when ' + esc(String(state.settings.lowSpoolPercent)) + "% or less remains.</p><ul>" +
        sum.lowSpools.map(function (s) {
          return "<li>" + esc(spoolLabel(s)) + " — " + esc(formatGrams(s.remainingGrams)) + " (" + esc(formatPercent(percentLeft(s))) + ")</li>";
        }).join("") + "</ul></div>";
    }
    html += '<div class="card" style="margin-bottom:0.75rem"><h3 class="spool-name">Cost by material</h3>' + table(sum.materialRows, "material", "Material") + "</div>";
    html += '<div class="card" style="margin-bottom:0.75rem"><h3 class="spool-name">Cost by job</h3>' + table(sum.jobRows, "job", "Job") + "</div>";
    html += '<div class="card"><h3 class="spool-name">Cost by part</h3>' + table(sum.partRows, "part", "Part") + "</div>";
    el.innerHTML = html;
  }

  function statCard(label, num, hint) {
    return '<div class="stat-card"><span class="stat-label">' + esc(label) + '</span><div class="num">' +
      esc(num) + "</div>" + (hint ? '<div class="meta">' + esc(hint) + "</div>" : "") + "</div>";
  }

  function render() {
    if (currentView === "spools") renderSpools();
    else if (currentView === "prints") renderPrints();
    else if (currentView === "calc") renderCalc();
    else renderSummary();
  }

  function closeDialog() {
    $("#overlay-root").innerHTML = "";
  }

  function openDialog(html) {
    closeMenu();
    $("#overlay-root").innerHTML = '<div class="backdrop" data-close-backdrop="1"><div class="dialog" role="dialog" aria-modal="true">' +
      '<div class="dialog-handle"></div>' + html + "</div></div>";
    var dialog = $(".dialog");
    var focus = dialog.querySelector("input, select, textarea, button");
    if (focus) focus.focus();
  }

  function openConfirm(title, message, confirmLabel, danger, onYes) {
    openDialog("<h2>" + esc(title) + "</h2><p>" + message + "</p>" +
      '<div class="dialog-actions"><button type="button" class="btn" data-close="1">Cancel</button>' +
      '<button type="button" class="btn ' + (danger ? "btn-danger" : "btn-primary") + '" id="confirm-yes">' +
      esc(confirmLabel || "Confirm") + "</button></div>");
    $("#confirm-yes").addEventListener("click", function () { closeDialog(); onYes(); });
  }

  function openSpoolForm(existing) {
    var s = existing || {
      name: "", brand: "", material: "PPA-CF", colour: "", colourHex: "#888888",
      priceAUD: "", netGrams: "", remainingGrams: "", purchaseDate: "", notes: ""
    };
    var customMaterial = s.material && MATERIALS.indexOf(s.material) === -1;
    openDialog(
      "<h2>" + (existing ? "Edit spool" : "Add spool") + "</h2>" +
      '<form id="spool-form" class="form-grid">' +
      '<label class="field">Name<input name="name" required maxlength="80" value="' + esc(s.name) + '" placeholder="e.g. PPA-CF Black 750g"></label>' +
      '<div class="form-grid two">' +
      '<label class="field">Brand<input name="brand" maxlength="60" value="' + esc(s.brand) + '" placeholder="e.g. Bambu Lab"></label>' +
      '<label class="field">Material<select name="material">' + materialOptions(s.material, true) + "</select></label>" +
      "</div>" +
      '<label class="field" id="custom-material-wrap"' + (customMaterial ? "" : " hidden") + ">Custom material" +
      '<input name="materialCustom" maxlength="40" value="' + esc(customMaterial ? s.material : "") + '"></label>' +
      '<div class="inline-color"><label class="field">Colour<input name="colour" maxlength="40" value="' + esc(s.colour) + '" placeholder="e.g. Black"></label>' +
      '<label class="field">Swatch<input type="color" name="colourHex" value="' + esc(s.colourHex || "#888888") + '"></label></div>' +
      '<div class="form-grid two">' +
      '<label class="field">Price paid (AUD)<input name="priceAUD" type="number" inputmode="decimal" min="0" step="0.01" required value="' + esc(s.priceAUD) + '"></label>' +
      '<label class="field">Spool net weight (g)<input name="netGrams" type="number" inputmode="decimal" min="0.1" step="1" required value="' + esc(s.netGrams) + '"></label>' +
      "</div>" +
      (existing
        ? '<label class="field">Remaining (g)<input name="remainingGrams" type="number" inputmode="decimal" step="0.1" min="0" value="' + esc(s.remainingGrams) + '"><span class="help">Editing this here also adjusts the remainder. Prefer Adjust remaining after weighing.</span></label>'
        : '<p class="help">Remaining starts at the full net weight. Log prints or use Adjust remaining after you weigh the roll.</p>') +
      '<div class="live-cost" id="spool-live-cost"></div>' +
      '<label class="field">Purchase date <span class="help">(optional)</span><input name="purchaseDate" type="date" value="' + esc(s.purchaseDate || "") + '"></label>' +
      '<label class="field">Notes <span class="help">(optional)</span><textarea name="notes" maxlength="500">' + esc(s.notes) + "</textarea></label>" +
      '<p class="error" id="spool-form-error" hidden></p>' +
      '<div class="dialog-actions"><button type="button" class="btn" data-close="1">Cancel</button>' +
      '<button type="submit" class="btn btn-primary">' + (existing ? "Save changes" : "Add spool") + "</button></div>" +
      "</form>"
    );

    var form = $("#spool-form");
    function updateLive() {
      var price = toNumber(form.priceAUD.value, NaN);
      var net = toNumber(form.netGrams.value, NaN);
      var cpg = costPerGram({ priceAUD: price, netGrams: net });
      var box = $("#spool-live-cost");
      if (Number.isFinite(cpg)) box.innerHTML = "Cost per gram: <strong>" + esc(formatPerGram(cpg)) + "</strong>";
      else box.innerHTML = "Enter price and net weight to see cost per gram.";
    }
    updateLive();
    form.priceAUD.addEventListener("input", updateLive);
    form.netGrams.addEventListener("input", updateLive);
    form.material.addEventListener("change", function () {
      var custom = form.material.value === "__custom__";
      $("#custom-material-wrap").hidden = !custom;
      if (custom) form.materialCustom.focus();
    });
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var material = form.material.value;
      if (material === "__custom__") material = form.materialCustom.value.trim();
      if (!material) {
        $("#spool-form-error").hidden = false;
        $("#spool-form-error").textContent = "Enter a material.";
        return;
      }
      var payload = {
        name: form.name.value,
        brand: form.brand.value,
        material: material,
        colour: form.colour.value,
        colourHex: form.colourHex.value,
        priceAUD: form.priceAUD.value,
        netGrams: form.netGrams.value,
        purchaseDate: form.purchaseDate.value,
        notes: form.notes.value
      };
      try {
        if (existing) {
          if (form.remainingGrams) payload.remainingGrams = form.remainingGrams.value;
          updateSpool(state, existing.id, payload);
          toast("Spool updated");
        } else {
          payload.remainingGrams = toNumber(payload.netGrams, 0);
          addSpool(state, payload);
          toast("Spool added");
        }
        persist();
        closeDialog();
        render();
      } catch (err) {
        $("#spool-form-error").hidden = false;
        $("#spool-form-error").textContent = err.message || "Could not save spool";
      }
    });
  }

  function openAdjust(id) {
    var s = findSpool(state, id);
    if (!s) return;
    var logged = loggedGramsForSpool(state, id);
    var expected = roundGrams(s.netGrams - logged);
    openDialog(
      "<h2>Adjust remaining</h2>" +
      "<p class=\"meta\">" + esc(spoolLabel(s)) + "</p>" +
      "<p>Currently <strong>" + esc(formatGrams(s.remainingGrams)) + "</strong> of " + esc(formatGrams(s.netGrams)) +
      ". Logged prints total " + esc(formatGrams(logged)) +
      (Math.abs(expected - s.remainingGrams) > 0.05
        ? ", so the remainder after prints would be " + esc(formatGrams(expected)) + "."
        : ".") +
      "</p>" +
      '<form id="adjust-form" class="form-grid">' +
      '<label class="field">New remaining weight (g)<input name="remaining" type="number" inputmode="decimal" min="0" step="0.1" required value="' + esc(s.remainingGrams) + '"></label>' +
      '<label class="field">Note <span class="help">(optional)</span><input name="notes" maxlength="200" placeholder="e.g. Weighed on kitchen scale"></label>' +
      '<p class="error" id="adjust-error" hidden></p>' +
      '<div class="dialog-actions"><button type="button" class="btn" data-close="1">Cancel</button>' +
      '<button type="submit" class="btn btn-primary">Save remaining</button></div></form>'
    );
    $("#adjust-form").addEventListener("submit", function (e) {
      e.preventDefault();
      try {
        adjustRemaining(state, id, e.target.remaining.value, e.target.notes.value);
        persist();
        closeDialog();
        toast("Remainder updated");
        render();
      } catch (err) {
        $("#adjust-error").hidden = false;
        $("#adjust-error").textContent = err.message || "Could not adjust";
      }
    });
  }

  function openPrintForm(existing, defaults) {
    defaults = defaults || {};
    var first = activeSpools()[0];
    var p = existing || {
      spoolId: defaults.spoolId || (first && first.id) || "",
      partName: defaults.partName || "",
      gramsUsed: defaults.gramsUsed || "",
      date: todayISO(),
      job: "",
      notes: "",
      success: true
    };
    if (!state.spools.length) {
      openDialog("<h2>Log print</h2><p>Add a spool first, then you can log prints against it.</p>" +
        '<div class="dialog-actions"><button type="button" class="btn" data-close="1">Close</button>' +
        '<button type="button" class="btn btn-primary" data-open="spool-new">Add spool</button></div>');
      return;
    }
    openDialog(
      "<h2>" + (existing ? "Edit print" : "Log print") + "</h2>" +
      '<form id="print-form" class="form-grid">' +
      '<label class="field">Spool<select name="spoolId" required>' + spoolOptions(p.spoolId, true, true) + "</select></label>" +
      '<label class="field">Part name<input name="partName" required maxlength="80" value="' + esc(p.partName) + '" placeholder="e.g. Bike clamp, revision 2"></label>' +
      '<div class="form-grid two">' +
      '<label class="field">Grams used<input name="gramsUsed" type="number" inputmode="decimal" min="0.1" step="0.1" required value="' + esc(p.gramsUsed) + '"></label>' +
      '<label class="field">Date<input name="date" type="date" required value="' + esc(p.date) + '"></label>' +
      "</div>" +
      '<div class="live-cost" id="print-live-cost"></div>' +
      '<label class="field">Job / customer <span class="help">(optional)</span><input name="job" maxlength="80" value="' + esc(p.job) + '"></label>' +
      '<label class="field">Notes <span class="help">(optional)</span><textarea name="notes" maxlength="500">' + esc(p.notes) + "</textarea></label>" +
      '<label class="switch-row"><span>Print succeeded</span><input type="checkbox" name="success"' + (p.success ? " checked" : "") + "></label>" +
      '<p class="help">Failed prints still use filament, so they still come off the spool and count toward cost.</p>' +
      '<p class="error" id="print-form-error" hidden></p>' +
      '<div class="dialog-actions"><button type="button" class="btn" data-close="1">Cancel</button>' +
      '<button type="submit" class="btn btn-primary">' + (existing ? "Save changes" : "Log print") + "</button></div></form>"
    );
    var form = $("#print-form");
    function updateLive() {
      var spool = findSpool(state, form.spoolId.value);
      var grams = toNumber(form.gramsUsed.value, NaN);
      var box = $("#print-live-cost");
      if (!spool) { box.textContent = "Choose a spool to see the cost."; return; }
      var cpg = costPerGram(spool);
      var cost = printCost(grams, cpg);
      var rem = spool.remainingGrams;
      if (existing && existing.spoolId === spool.id) rem = roundGrams(rem + existing.gramsUsed);
      var bits = [esc(spoolLabel(spool)), esc(formatPerGram(cpg)), esc(formatGrams(rem)) + " remaining"];
      var html = bits.join(" · ");
      if (Number.isFinite(cost)) html += "<br><strong>" + esc(formatAUD(cost)) + "</strong>";
      if (Number.isFinite(grams) && grams > rem + 0.05) {
        html += ' <span class="error">This is more than the remaining filament.</span>';
      }
      box.innerHTML = html;
    }
    updateLive();
    form.spoolId.addEventListener("change", updateLive);
    form.gramsUsed.addEventListener("input", updateLive);
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var payload = {
        spoolId: form.spoolId.value,
        partName: form.partName.value,
        gramsUsed: form.gramsUsed.value,
        date: form.date.value,
        job: form.job.value,
        notes: form.notes.value,
        success: form.success.checked
      };
      var spool = findSpool(state, payload.spoolId);
      var grams = toNumber(payload.gramsUsed, NaN);
      var remaining = spool ? spool.remainingGrams : 0;
      if (existing && spool && existing.spoolId === spool.id) remaining = roundGrams(remaining + existing.gramsUsed);
      function commit() {
        try {
          if (existing) updatePrint(state, existing.id, payload);
          else addPrint(state, payload);
          persist();
          closeDialog();
          toast(existing ? "Print updated" : "Print logged");
          render();
        } catch (err) {
          $("#print-form-error").hidden = false;
          $("#print-form-error").textContent = err.message || "Could not save print";
        }
      }
      if (spool && Number.isFinite(grams) && grams > remaining + 0.05) {
        openConfirm(
          "Use more than remaining?",
          "This print uses " + esc(formatGrams(grams)) + " but " + esc(spoolLabel(spool)) + " only has " + esc(formatGrams(remaining)) + " left. Log it anyway? The remainder will go negative.",
          "Log anyway",
          true,
          commit
        );
        return;
      }
      commit();
    });
  }

  function openSpoolDetail(id) {
    var s = findSpool(state, id);
    if (!s) return;
    var prints = state.prints.filter(function (p) { return p.spoolId === id; })
      .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); });
    var logged = loggedGramsForSpool(state, id);
    var pct = percentLeft(s);
    var html = "<h2>" + esc(s.name) + "</h2>" +
      '<p class="meta">' + esc([s.brand, s.material, s.colour].filter(Boolean).join(" · ")) +
      (s.purchaseDate ? " · bought " + esc(formatDateAU(s.purchaseDate)) : "") +
      (s.archived ? " · Finished" : "") + "</p>" +
      '<div class="spool-stats">' +
      "<div><span class=\"stat-label\">Paid</span><div class=\"stat-value\">" + esc(formatAUD(s.priceAUD)) + "</div></div>" +
      "<div><span class=\"stat-label\">Cost / g</span><div class=\"stat-value\">" + esc(formatPerGram(costPerGram(s))) + "</div></div>" +
      "<div><span class=\"stat-label\">Value left</span><div class=\"stat-value\">" + esc(formatAUD(remainingValue(s))) + "</div></div>" +
      "</div>" +
      '<div class="' + barClass(pct) + '" style="margin-top:0.9rem"><span style="width:' + Math.max(0, Math.min(100, pct || 0)) + '%"></span></div>' +
      '<div class="bar-label"><span>' + esc(formatGrams(s.remainingGrams)) + " of " + esc(formatGrams(s.netGrams)) +
      "</span><span>" + esc(formatPercent(pct)) + " left</span></div>" +
      '<p class="meta">Logged prints: ' + esc(formatGrams(logged)) + ".</p>" +
      (s.notes ? "<p>" + esc(s.notes) + "</p>" : "") +
      '<div class="card-actions">' +
      (s.archived ? "" : '<button type="button" class="btn btn-sm btn-primary" data-open="print-new" data-spool="' + esc(s.id) + '">Log print</button>') +
      '<button type="button" class="btn btn-sm" data-open="adjust" data-id="' + esc(s.id) + '">Adjust remaining</button>' +
      '<button type="button" class="btn btn-sm" data-open="spool-edit" data-id="' + esc(s.id) + '">Edit</button>' +
      '<button type="button" class="btn btn-sm" data-action="archive-spool" data-id="' + esc(s.id) + '">' +
      (s.archived ? "Restore" : "Mark finished") + "</button>" +
      '<button type="button" class="btn btn-sm btn-danger" data-action="delete-spool" data-id="' + esc(s.id) + '">Delete</button>' +
      "</div>";
    if (prints.length) {
      html += "<hr class=\"sep\"><h3 class=\"spool-name\">Prints on this spool</h3><div class=\"table-wrap\"><table class=\"data\"><tbody>" +
        prints.map(function (p) {
          return "<tr><td>" + esc(formatDateAU(p.date)) + "</td><td>" + esc(p.partName) +
            (p.success ? "" : " (failed)") + '</td><td class="num">' + esc(formatGrams(p.gramsUsed)) +
            '</td><td class="num">' + esc(formatAUD(p.costAUD)) + "</td></tr>";
        }).join("") + "</tbody></table></div>";
    }
    html += '<div class="dialog-actions"><button type="button" class="btn" data-close="1">Close</button></div>';
    openDialog(html);
  }

  function openSettings() {
    openDialog(
      "<h2>Settings</h2>" +
      '<form id="settings-form" class="form-grid">' +
      '<label class="field">Low-spool warning (%)' +
      '<input name="low" type="number" min="1" max="50" step="1" value="' + esc(state.settings.lowSpoolPercent) + '">' +
      '<span class="help">Active spools at or below this remaining percentage are flagged. Default is 15%.</span></label>' +
      '<label class="field">Theme<select name="theme">' +
      ["system", "light", "dark"].map(function (t) {
        return '<option value="' + t + '"' + (state.settings.theme === t ? " selected" : "") + ">" +
          (t === "system" ? "Match device" : t.charAt(0).toUpperCase() + t.slice(1)) + "</option>";
      }).join("") + "</select></label>" +
      '<p class="help">Data stays on this device (in the browser). Export a JSON backup if you switch phones or clear site data. To install this app on a phone it must be served over HTTPS.</p>' +
      '<div class="dialog-actions"><button type="button" class="btn" data-close="1">Cancel</button>' +
      '<button type="submit" class="btn btn-primary">Save settings</button></div></form>'
    );
    $("#settings-form").addEventListener("submit", function (e) {
      e.preventDefault();
      state.settings.lowSpoolPercent = toNumber(e.target.low.value, 15);
      state.settings.theme = e.target.theme.value;
      persist();
      applyTheme();
      closeDialog();
      toast("Settings saved");
      render();
    });
  }

  function confirmDeletePrint(id) {
    var p = findPrint(state, id);
    if (!p) return;
    openConfirm(
      "Delete this print?",
      esc(p.partName) + " (" + esc(formatGrams(p.gramsUsed)) + ", " + esc(formatAUD(p.costAUD)) +
        ") will be removed and the grams will be credited back to the spool.",
      "Delete print",
      true,
      function () {
        deletePrint(state, id);
        persist();
        toast("Print deleted, grams credited");
        render();
      }
    );
  }

  function confirmDeleteSpool(id) {
    var s = findSpool(state, id);
    if (!s) return;
    var n = state.prints.filter(function (p) { return p.spoolId === id; }).length;
    var msg = "Delete <strong>" + esc(s.name) + "</strong>? This cannot be undone.";
    if (n) {
      msg += " " + n + " print" + (n === 1 ? "" : "s") +
        " will be kept in the log, but won’t be linked to a spool. Marking the spool as finished is usually better.";
    }
    openConfirm("Delete spool?", msg, "Delete spool", true, function () {
      deleteSpool(state, id);
      persist();
      toast("Spool deleted");
      render();
    });
  }

  function downloadText(filename, text, mime) {
    var blob = new Blob([text], { type: mime || "text/plain" });
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 500);
  }

  function stamp() {
    return todayISO();
  }

  function handleImportFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var payload = JSON.parse(String(reader.result || ""));
        openDialog(
          "<h2>Import backup</h2>" +
          "<p>This file has " + ((payload.spools && payload.spools.length) || 0) + " spools and " +
          ((payload.prints && payload.prints.length) || 0) + " prints.</p>" +
          "<p>Replace overwrites everything on this device. Merge keeps existing records and adds or updates matching IDs.</p>" +
          '<div class="dialog-actions">' +
          '<button type="button" class="btn" data-close="1">Cancel</button>' +
          '<button type="button" class="btn" id="import-merge">Merge</button>' +
          '<button type="button" class="btn btn-primary" id="import-replace">Replace all</button></div>'
        );
        $("#import-merge").addEventListener("click", function () {
          state = importPayload(state, payload, "merge");
          persist(); applyTheme(); closeDialog(); toast("Backup merged"); render();
        });
        $("#import-replace").addEventListener("click", function () {
          openConfirm("Replace all data?", "Everything currently stored on this device will be replaced by the backup.", "Replace all", true, function () {
            state = importPayload(state, payload, "replace");
            persist(); applyTheme(); toast("Backup imported"); render();
          });
        });
      } catch (err) {
        toast("Could not read that backup file");
      }
    };
    reader.readAsText(file);
  }

  document.addEventListener("click", function (e) {
    var t = e.target.closest("[data-nav], [data-open], [data-action], [data-close], [data-close-backdrop], #menu-btn, #theme-btn, #add-example, #install-item");
    if (!t) {
      if (!$("#app-menu").hidden && !e.target.closest("#app-menu") && !e.target.closest("#menu-btn")) closeMenu();
      return;
    }
    if (t.id === "menu-btn") { toggleMenu(); return; }
    if (t.id === "theme-btn") {
      var order = ["system", "light", "dark"];
      var i = order.indexOf(state.settings.theme);
      state.settings.theme = order[(i + 1) % order.length];
      persist(); applyTheme();
      toast(state.settings.theme === "system" ? "Theme: match device" : "Theme: " + state.settings.theme);
      return;
    }
    if (t.id === "add-example") {
      state.spools.unshift(exampleSpool());
      persist(); render(); toast("Example spool added — safe to delete");
      return;
    }
    if (t.hasAttribute("data-nav")) { closeMenu(); setView(t.getAttribute("data-nav")); return; }
    if (t.hasAttribute("data-close") || (t.hasAttribute("data-close-backdrop") && e.target === t)) { closeDialog(); return; }
    var open = t.getAttribute("data-open");
    if (open === "spool-new") { closeDialog(); openSpoolForm(null); return; }
    if (open === "spool-edit") { closeDialog(); openSpoolForm(findSpool(state, t.getAttribute("data-id"))); return; }
    if (open === "spool-detail") { openSpoolDetail(t.getAttribute("data-id")); return; }
    if (open === "adjust") { closeDialog(); openAdjust(t.getAttribute("data-id")); return; }
    if (open === "print-new") {
      closeDialog();
      openPrintForm(null, { spoolId: t.getAttribute("data-spool") || "", gramsUsed: t.getAttribute("data-grams") || "" });
      return;
    }
    if (open === "print-edit") { closeDialog(); openPrintForm(findPrint(state, t.getAttribute("data-id"))); return; }
    var action = t.getAttribute("data-action");
    if (action === "settings") { closeMenu(); openSettings(); return; }
    if (action === "export-json") {
      closeMenu();
      downloadText("filament-ledger-" + stamp() + ".json", JSON.stringify(exportPayload(state), null, 2), "application/json");
      toast("JSON backup downloaded");
      return;
    }
    if (action === "export-csv") {
      closeMenu();
      downloadText("filament-ledger-prints-" + stamp() + ".csv", exportPrintsCSV(state), "text/csv");
      toast("Print log CSV downloaded");
      return;
    }
    if (action === "import-json") { closeMenu(); $("#import-file").click(); return; }
    if (action === "install") {
      closeMenu();
      if (installEvent) {
        installEvent.prompt();
        installEvent.userChoice.finally(function () { installEvent = null; $("#install-item").hidden = true; });
      }
      return;
    }
    if (action === "delete-print") { confirmDeletePrint(t.getAttribute("data-id")); return; }
    if (action === "delete-spool") { confirmDeleteSpool(t.getAttribute("data-id")); return; }
    if (action === "archive-spool") {
      var s = findSpool(state, t.getAttribute("data-id"));
      if (!s) return;
      archiveSpool(state, s.id, !s.archived);
      persist();
      closeDialog();
      toast(s.archived ? "Spool marked finished" : "Spool restored");
      render();
    }
  });

  document.addEventListener("change", function (e) {
    if (e.target.id === "toggle-archived") { showArchived = e.target.checked; render(); }
    if (e.target.id === "filter-spool") { printFilter.spoolId = e.target.value; render(); }
    if (e.target.id === "calc-spool") { calcForm.spoolId = e.target.value; render(); }
    if (e.target.id === "import-file") {
      handleImportFile(e.target.files && e.target.files[0]);
      e.target.value = "";
    }
  });

  document.addEventListener("input", function (e) {
    if (e.target.id === "filter-q") { printFilter.q = e.target.value; fillPrintList(); }
    if (e.target.id === "calc-price") { calcForm.priceAUD = e.target.value; updateCalcResult(); }
    if (e.target.id === "calc-net") { calcForm.netGrams = e.target.value; updateCalcResult(); }
    if (e.target.id === "calc-grams") { calcForm.grams = e.target.value; updateCalcResult(); }
  });

  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") {
      if ($("#overlay-root").innerHTML) closeDialog();
      closeMenu();
    }
  });

  window.addEventListener("hashchange", function () {
    var name = (location.hash || "").replace("#", "");
    if (["spools", "prints", "calc", "summary"].indexOf(name) !== -1) setView(name);
  });

  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault();
    installEvent = e;
    $("#install-item").hidden = false;
  });

  if (window.matchMedia) {
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
  }

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("./sw.js").catch(function () { /* offline first-run is fine */ });
  }

  applyTheme();
  var initial = (location.hash || "").replace("#", "");
  if (["spools", "prints", "calc", "summary"].indexOf(initial) !== -1) currentView = initial;
  setView(currentView);
})(typeof globalThis !== "undefined" ? globalThis : this);
