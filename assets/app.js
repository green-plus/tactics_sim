import { buildMemory, DEFAULT_WIN_RATES, strategyWinRate } from "./sim.js?v=20260617-context";

const DATASETS = {
  normal: {
    label: "通常",
    url: "./data/policy_study_300.json",
  },
  uta: {
    label: "追加データ例",
    url: "./data/policy_study_300_uta_sakura.json",
  },
};

const state = {
  reports: {},
  activeKey: "normal",
  customReport: null,
  customReports: null,
  model: null,
  sampleMemory: null,
  winRateConfig: null,
  defaultWinRateConfig: null,
};

const els = {
  summaryMetrics: document.querySelector("#summaryMetrics"),
  compareStrip: document.querySelector("#compareStrip"),
  strategyTable: document.querySelector("#strategyTable"),
  strategyFilters: document.querySelector("#strategyFilters"),
  modelControls: document.querySelector("#modelControls"),
  caseList: document.querySelector("#caseList"),
  caseCount: document.querySelector("#caseCount"),
  scope: document.querySelector("#scope"),
  search: document.querySelector("#search"),
  order: document.querySelector("#order"),
  fileInput: document.querySelector("#fileInput"),
  refreshButton: document.querySelector("#refreshButton"),
  selectAll: document.querySelector("#selectAll"),
  selectNone: document.querySelector("#selectNone"),
  enableStrategies: document.querySelector("#enableStrategies"),
  disableStrategies: document.querySelector("#disableStrategies"),
  resetModel: document.querySelector("#resetModel"),
  primeText: document.querySelector("#primeText"),
  compositeText: document.querySelector("#compositeText"),
  includeAdditional: document.querySelector("#includeAdditional"),
  additionalPrimeText: document.querySelector("#additionalPrimeText"),
  additionalCompositeText: document.querySelector("#additionalCompositeText"),
  additionalInputs: document.querySelector("#additionalInputs"),
  trialCount: document.querySelector("#trialCount"),
  simSeed: document.querySelector("#simSeed"),
  handSize: document.querySelector("#handSize"),
  runSimulation: document.querySelector("#runSimulation"),
  loadSampleMemory: document.querySelector("#loadSampleMemory"),
  clearMemory: document.querySelector("#clearMemory"),
  parseStatus: document.querySelector("#parseStatus"),
  customDatasetTab: document.querySelector("#customDatasetTab"),
  downloadReport: document.querySelector("#downloadReport"),
  winRateJson: document.querySelector("#winRateJson"),
  applyWinRateJson: document.querySelector("#applyWinRateJson"),
  resetWinRateJson: document.querySelector("#resetWinRateJson"),
  winRateJsonStatus: document.querySelector("#winRateJsonStatus"),
};

const symbols = {
  0: "X",
  10: "T",
  11: "J",
  12: "Q",
  13: "K",
};

const faceMap = {
  t: 10,
  j: 11,
  q: 12,
  k: 13,
};

async function init() {
  await loadBundledReports();
  normalizeStaticLabels();
  bindEvents();
  renderAll();
}

function normalizeStaticLabels() {
  const normalTab = document.querySelector('[data-dataset="normal"]');
  const addedTab = document.querySelector('[data-dataset="uta"]');
  if (normalTab) normalTab.textContent = "通常";
  if (addedTab) addedTab.textContent = "追加";
  els.customDatasetTab?.remove();
}

async function loadBundledReports() {
  const entries = await Promise.all(
    Object.entries(DATASETS).map(async ([key, dataset]) => {
      const response = await fetch(dataset.url, { cache: "no-store" });
      if (!response.ok) throw new Error(`${dataset.url} を読み込めませんでした`);
      return [key, await response.json()];
    }),
  );
  const [sampleMemory, winRateConfig] = await Promise.all([
    fetch("./data/sample_memory.json", { cache: "no-store" }).then((response) => response.json()),
    fetch("./data/win_rates.json", { cache: "no-store" }).then((response) => response.json()),
  ]);
  state.reports = Object.fromEntries(entries);
  state.sampleMemory = sampleMemory;
  state.winRateConfig = winRateConfig;
  state.defaultWinRateConfig = structuredClone(winRateConfig);
  state.customReport = null;
  state.customReports = null;
  state.model = null;
  state.activeKey = "normal";
  loadSampleMemory(false);
  syncWinRateJson();
  showCustomTab(false);
  setActiveDatasetButton("normal");
}

function bindEvents() {
  document.querySelectorAll("[data-dataset]").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeKey = button.dataset.dataset;
      state.model = null;
      setActiveDatasetButton(state.activeKey);
      renderAll();
    });
  });

  [els.scope, els.search, els.order].forEach((control) => {
    control.addEventListener("input", renderCases);
  });

  els.refreshButton.addEventListener("click", async () => {
    await loadBundledReports();
    renderAll();
  });

  els.selectAll.addEventListener("click", () => {
    document.querySelectorAll(".strategy-filter").forEach((input) => {
      input.checked = true;
    });
    renderCases();
  });

  els.selectNone.addEventListener("click", () => {
    document.querySelectorAll(".strategy-filter").forEach((input) => {
      input.checked = false;
    });
    renderCases();
  });

  els.enableStrategies.addEventListener("click", () => {
    Object.values(ensureModel(sourceReport()).settings).forEach((setting) => {
      setting.enabled = true;
    });
    renderAll();
  });

  els.disableStrategies.addEventListener("click", () => {
    Object.entries(ensureModel(sourceReport()).settings).forEach(([strategy, setting]) => {
      setting.enabled = strategy === "all-out";
    });
    renderAll();
  });

  els.resetModel.addEventListener("click", () => {
    state.model = null;
    renderAll();
  });

  els.applyWinRateJson.addEventListener("click", () => {
    applyWinRateJson();
  });

  els.resetWinRateJson.addEventListener("click", () => {
    state.winRateConfig = structuredClone(state.defaultWinRateConfig);
    syncWinRateJson();
    state.model = null;
    renderAll();
  });

  els.loadSampleMemory.addEventListener("click", () => {
    loadSampleMemory(true);
  });

  els.clearMemory.addEventListener("click", () => {
    els.primeText.value = "";
    els.compositeText.value = "";
    els.additionalPrimeText.value = "";
    els.additionalCompositeText.value = "";
    els.includeAdditional.checked = false;
    syncAdditionalInputs();
    renderParsePreview();
  });

  [els.primeText, els.compositeText, els.additionalPrimeText, els.additionalCompositeText].forEach((control) => {
    control.addEventListener("input", renderParsePreview);
  });
  els.includeAdditional.addEventListener("input", () => {
    syncAdditionalInputs();
    renderParsePreview();
  });

  els.runSimulation.addEventListener("click", runSimulationFromInputs);

  els.downloadReport.addEventListener("click", downloadCurrentReport);

  els.fileInput.addEventListener("change", async () => {
    const [file] = els.fileInput.files;
    if (!file) return;
    const text = await file.text();
    const report = JSON.parse(text);
    state.customReport = report;
    state.customReports = { normal: report, uta: null };
    state.activeKey = "normal";
    state.model = null;
    showCustomTab(false);
    setActiveDatasetButton("normal");
    renderAll();
  });
}

function loadSampleMemory(shouldRender = true) {
  if (!state.sampleMemory) return;
  els.primeText.value = state.sampleMemory.primeText || "";
  els.compositeText.value = state.sampleMemory.compositeText || "";
  els.additionalPrimeText.value = state.sampleMemory.additionalPrimeText || "";
  els.additionalCompositeText.value = state.sampleMemory.additionalCompositeText || "";
  els.includeAdditional.checked = false;
  syncAdditionalInputs();
  renderParsePreview();
  if (shouldRender) renderAll();
}

function syncAdditionalInputs() {
  const enabled = els.includeAdditional.checked;
  els.additionalInputs.classList.toggle("is-disabled", !enabled);
  els.additionalPrimeText.disabled = !enabled;
  els.additionalCompositeText.disabled = !enabled;
}

function syncWinRateJson() {
  if (!els.winRateJson || !state.winRateConfig) return;
  els.winRateJson.value = JSON.stringify(state.winRateConfig, null, 2);
  els.winRateJsonStatus.textContent = "";
}

function applyWinRateJson() {
  try {
    const parsed = JSON.parse(els.winRateJson.value);
    state.winRateConfig = {
      strategy_rates: { ...(parsed.strategy_rates || {}) },
      conditional_rates: parsed.conditional_rates || [],
      move_overrides: parsed.move_overrides || {},
    };
    state.model = null;
    els.winRateJsonStatus.textContent = "適用しました";
    renderAll();
  } catch (error) {
    els.winRateJsonStatus.textContent = `JSONを読めません: ${error.message}`;
  }
}

function downloadCurrentReport() {
  const report = buildModeledReport(sourceReport());
  const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  const seed = report.seed ?? "no-seed";
  link.href = url;
  link.download = `primeqk_policy_${state.activeKey}_${seed}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function sourceReport() {
  if (state.customReports) {
    if (state.activeKey === "uta") return state.customReports.uta || state.customReports.normal;
    return state.customReports.normal;
  }
  return state.reports[state.activeKey];
}

function showCustomTab(show) {
  els.customDatasetTab?.classList.toggle("is-hidden", !show);
}

function setActiveDatasetButton(key) {
  document.querySelectorAll("[data-dataset]").forEach((item) => {
    item.classList.toggle("is-active", item.dataset.dataset === key);
  });
}

function renderAll() {
  const source = sourceReport();
  if (!source) return;
  ensureModel(source);
  renderParsePreview();
  renderModelControls(source);
  renderDerivedViews();
}

function buildInputPayload(withAdditional) {
  const primeParts = [els.primeText.value];
  const compositeParts = [els.compositeText.value];
  if (withAdditional) {
    primeParts.push(els.additionalPrimeText.value);
    compositeParts.push(els.additionalCompositeText.value);
  }
  return {
    primeText: primeParts.filter((text) => text?.trim()).join("\n"),
    compositeText: compositeParts.filter((text) => text?.trim()).join("\n"),
  };
}

function renderStatusChips(chips) {
  return chips.map(([label, value, tone]) => (
    `<span class="status-chip ${tone || ""}">${escapeHtml(label)} <b>${escapeHtml(value)}</b></span>`
  )).join("");
}

function previewMemoryStatus() {
  const base = buildInputPayload(false);
  const memory = buildMemory(base.primeText, base.compositeText, "");
  const chips = [
    ["通常 素数値", formatInt(memory.stats.primeValues)],
    ["通常 素数手", formatInt(memory.stats.primeMoves)],
    ["通常 合成式", formatInt(memory.stats.compositeEquations)],
    ["通常 合成手", formatInt(memory.stats.compositeMoves)],
  ];
  const warnings = [...memory.stats.warnings];
  if (els.includeAdditional.checked) {
    const added = buildInputPayload(true);
    const addedMemory = buildMemory(added.primeText, added.compositeText, "");
    warnings.push(...addedMemory.stats.warnings);
    chips.push(
      ["追加込み 素数値", formatInt(addedMemory.stats.primeValues)],
      ["追加込み 素数手", formatInt(addedMemory.stats.primeMoves)],
      ["追加込み 合成式", formatInt(addedMemory.stats.compositeEquations)],
      ["追加込み 合成手", formatInt(addedMemory.stats.compositeMoves)],
    );
  }
  if (warnings.length) {
    chips.push(["警告", `${formatInt(warnings.length)}件: ${warnings.slice(0, 3).join(" / ")}`, "warn"]);
  }
  return renderStatusChips(chips);
}

function renderParsePreview() {
  if (!state.sampleMemory || !els.parseStatus) return;
  try {
    els.parseStatus.innerHTML = previewMemoryStatus();
    return;
    const memory = buildMemory(
      els.primeText.value,
      els.compositeText.value,
      els.includeAdditional.checked ? state.sampleMemory.additionalCompositeText : "",
    );
    const shownWarnings = memory.stats.warnings.slice(0, 3);
    const chips = [
      ["素数値", formatInt(memory.stats.primeValues)],
      ["素数手", formatInt(memory.stats.primeMoves)],
      ["合成数式", formatInt(memory.stats.compositeEquations)],
      ["追加式", formatInt(memory.stats.additionalCompositeEquations)],
      ["合成数手", formatInt(memory.stats.compositeMoves)],
    ];
    if (memory.stats.warnings.length) {
      chips.push(["警告", `${formatInt(memory.stats.warnings.length)}件: ${shownWarnings.join(" / ")}`, "warn"]);
    }
    els.parseStatus.innerHTML = chips.map(([label, value, tone]) => (
      `<span class="status-chip ${tone || ""}">${escapeHtml(label)} <b>${escapeHtml(value)}</b></span>`
    )).join("");
  } catch (error) {
    els.parseStatus.innerHTML = `<span class="status-chip warn">${escapeHtml(error.message)}</span>`;
  }
}

function renderStats(stats) {
  if (els.includeAdditional.checked) {
    els.parseStatus.innerHTML = previewMemoryStatus();
    return;
  }
  const statusChips = [
    ["通常 素数値", formatInt(stats.primeValues)],
    ["通常 素数手", formatInt(stats.primeMoves)],
    ["通常 合成式", formatInt(stats.compositeEquations)],
    ["通常 合成手", formatInt(stats.compositeMoves)],
  ];
  if (stats.warnings?.length) {
    statusChips.push(["警告", `${formatInt(stats.warnings.length)}件: ${(stats.warnings || []).slice(0, 3).join(" / ")}`, "warn"]);
  }
  els.parseStatus.innerHTML = renderStatusChips(statusChips);
  return;
  const shownWarnings = (stats.warnings || []).slice(0, 3);
  const chips = [
    ["素数値", formatInt(stats.primeValues)],
    ["素数手", formatInt(stats.primeMoves)],
    ["合成数式", formatInt(stats.compositeEquations)],
    ["追加式", formatInt(stats.additionalCompositeEquations)],
    ["合成数手", formatInt(stats.compositeMoves)],
  ];
  if (stats.warnings?.length) {
    chips.push(["警告", `${formatInt(stats.warnings.length)}件: ${shownWarnings.join(" / ")}`, "warn"]);
  }
  els.parseStatus.innerHTML = chips.map(([label, value, tone]) => (
    `<span class="status-chip ${tone || ""}">${escapeHtml(label)} <b>${escapeHtml(value)}</b></span>`
  )).join("");
}

async function runSimulationFromInputs() {
  const previousText = els.runSimulation.textContent;
  els.runSimulation.disabled = true;
  els.runSimulation.textContent = "実行中";
  await new Promise((resolve) => setTimeout(resolve, 0));
  try {
    ensureModel(sourceReport());
    const request = {
      trials: Number(els.trialCount.value),
      handSize: Number(els.handSize.value),
      seed: Number(els.simSeed.value),
      examples: Number(els.trialCount.value),
      winRates: winConfigFromModel(),
      enabledStrategies: enabledStrategiesFromModel(),
      jokersWild: true,
    };
    const basePayload = buildInputPayload(false);
    els.runSimulation.textContent = "通常 実行中";
    const normalResult = await runSimulationWorker({
      primeText: basePayload.primeText,
      compositeText: basePayload.compositeText,
      additionalCompositeText: "",
      request,
    });
    let utaResult = null;
    if (els.includeAdditional.checked) {
      const addedPayload = buildInputPayload(true);
      els.runSimulation.textContent = "追加 実行中";
      utaResult = await runSimulationWorker({
        primeText: addedPayload.primeText,
        compositeText: addedPayload.compositeText,
        additionalCompositeText: "",
        request,
      });
    }
    state.customReport = normalResult.report;
    state.customReports = { normal: normalResult.report, uta: utaResult?.report || null };
    state.activeKey = "normal";
    state.model = null;
    showCustomTab(false);
    setActiveDatasetButton("normal");
    renderAll();
    renderStats(normalResult.stats);
    return;
    const { report, stats } = await runSimulationWorker({
      primeText: els.primeText.value,
      compositeText: els.compositeText.value,
      additionalCompositeText: els.includeAdditional.checked ? state.sampleMemory.additionalCompositeText : "",
      request,
    });
    state.customReport = report;
    state.activeKey = "custom";
    state.model = null;
    showCustomTab(true);
    setActiveDatasetButton("custom");
    renderAll();
    renderStats(stats);
  } catch (error) {
    els.parseStatus.innerHTML = `<span class="status-chip warn">${escapeHtml(error.message)}</span>`;
  } finally {
    els.runSimulation.disabled = false;
    els.runSimulation.textContent = previousText;
  }
}

function runSimulationWorker(payload) {
  return new Promise((resolve, reject) => {
    const worker = new Worker("./assets/worker.js?v=20260617-context", { type: "module" });
    worker.addEventListener("message", (event) => {
      worker.terminate();
      if (event.data.type === "result") resolve(event.data);
      else reject(new Error(event.data.message || "シミュレーションに失敗しました"));
    });
    worker.addEventListener("error", (event) => {
      worker.terminate();
      reject(new Error(event.message || "Worker error"));
    });
    worker.postMessage(payload);
  });
}

function winConfigFromModel() {
  const model = ensureModel(sourceReport());
  const config = winConfigFromJson();
  for (const [strategy, setting] of Object.entries(model.settings)) {
    if (setting.rateOverride === "") continue;
    const value = Number(setting.rateOverride);
    if (Number.isFinite(value)) config.strategy_rates[strategy] = Math.min(1, Math.max(0, value / 100));
  }
  return config;
}

function enabledStrategiesFromModel() {
  const model = ensureModel(sourceReport());
  return Object.entries(model.settings)
    .filter(([strategy, setting]) => strategy !== "all-out" && setting.enabled)
    .map(([strategy]) => strategy);
}

function renderDerivedViews() {
  const source = sourceReport();
  const modeled = buildModeledReport(source);
  renderSummary(source, modeled);
  renderStrategies(modeled);
  renderCases();
}

function ensureModel(report) {
  const signature = reportSignature(report);
  if (state.model?.signature === signature) return state.model;

  const settings = {};
  for (const strategy of strategiesInReport(report)) {
    settings[strategy] = {
      enabled: true,
      rateOverride: "",
      defaultRate: defaultRateForStrategy(report, strategy),
    };
  }

  state.model = { signature, settings };
  return state.model;
}

function reportSignature(report) {
  return [
    state.customReports ? `custom:${state.activeKey}` : state.activeKey,
    report.seed,
    report.trials,
    report.prime_moves,
    report.composite_moves,
  ].join(":");
}

function strategiesInReport(report) {
  const strategies = new Set(["all-out"]);
  for (const row of sourceRows(report)) {
    strategies.add(baseStrategy(row.strategy));
    for (const candidate of [...(row.initial_candidates || []), ...(row.draw_candidates || [])]) {
      strategies.add(baseStrategy(candidate.strategy));
    }
  }
  return [...strategies].sort((a, b) => {
    if (a === "all-out") return 1;
    if (b === "all-out") return -1;
    return a.localeCompare(b);
  });
}

function defaultRateForStrategy(report, strategy) {
  const selection = report.selection?.find((row) => baseStrategy(row.strategy) === strategy);
  if (selection?.assigned_win_rate !== undefined) return selection.assigned_win_rate;
  const candidates = sourceRows(report).flatMap((row) => [...(row.initial_candidates || []), ...(row.draw_candidates || [])]);
  const match = candidates.find((candidate) => baseStrategy(candidate.strategy) === strategy);
  if (match?.win_rate !== undefined) return match.win_rate;
  return strategy === "all-out" ? 0.5 : 0;
}

function renderModelControls(report) {
  const model = ensureModel(report);
  els.modelControls.innerHTML = Object.entries(model.settings).map(([strategy, setting]) => `
    <label class="model-row">
      <input class="model-enabled" type="checkbox" data-strategy="${escapeHtml(strategy)}" ${setting.enabled ? "checked" : ""} ${strategy === "all-out" ? "disabled" : ""}>
      <span class="model-name">${escapeHtml(strategy)}</span>
      <span class="model-default">${formatPercent(setting.defaultRate)}</span>
      <input class="model-rate" type="number" inputmode="decimal" min="0" max="100" step="0.1" data-strategy="${escapeHtml(strategy)}" value="${escapeHtml(setting.rateOverride)}" placeholder="${percentNumber(setting.defaultRate)}">
    </label>
  `).join("");

  document.querySelectorAll(".model-enabled").forEach((input) => {
    input.addEventListener("input", () => {
      model.settings[input.dataset.strategy].enabled = input.checked;
      renderDerivedViews();
    });
  });

  document.querySelectorAll(".model-rate").forEach((input) => {
    input.addEventListener("input", () => {
      model.settings[input.dataset.strategy].rateOverride = input.value;
      renderDerivedViews();
    });
  });
}

function buildModeledReport(report) {
  const rows = sourceRows(report).map((row) => chooseModeledRow(row));
  const trials = report.trials || rows.length || 1;
  const expectedWins = rows.reduce((sum, row) => sum + row.win_rate, 0);
  const allOuts = rows.filter((row) => baseStrategy(row.strategy) === "all-out").length;
  const drawAttempts = rows.filter((row) => row.drawn_card !== null).length;
  const drawSuccesses = rows.filter((row) => row.drawn_card !== null && baseStrategy(row.strategy) !== "all-out").length;

  const selection = buildSelection(rows, trials, report.selection || []);
  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.strategy]) grouped[row.strategy] = [];
    grouped[row.strategy].push(row);
  }

  return {
    ...report,
    expected_wins: expectedWins,
    expected_win_rate: expectedWins / trials,
    expected_win_rate_ci95_low: null,
    expected_win_rate_ci95_high: null,
    draw_attempts: drawAttempts,
    draw_attempt_rate: drawAttempts / trials,
    draw_successes: drawSuccesses,
    draw_success_rate_given_attempt: drawAttempts ? drawSuccesses / drawAttempts : 0,
    all_outs: allOuts,
    all_out_rate: allOuts / trials,
    selection,
    examples: grouped,
    modeled_rows: rows,
  };
}

function chooseModeledRow(sourceRow) {
  const initial = enabledCandidates(sourceRow.initial_candidates || [], false);
  const draw = enabledCandidates(sourceRow.draw_candidates || [], true);
  const candidates = initial.length ? initial : draw;

  if (!candidates.length) {
    return {
      ...sourceRow,
      strategy: "all-out",
      moves: sourceRow.drawn_card === null ? ["ALL-OUT"] : [`DRAW:${rankLabel(sourceRow.drawn_card).toLowerCase()}`, "ALL-OUT"],
      win_rate: effectiveRate({ strategy: "all-out", win_rate: 0.5 }),
      modeled_from_strategy: sourceRow.strategy,
    };
  }

  const chosen = [...candidates].sort((a, b) => (
    b.modeled_win_rate - a.modeled_win_rate
    || (b.finish_size || 0) - (a.finish_size || 0)
    || a.strategy.localeCompare(b.strategy)
  ))[0];

  return {
    ...sourceRow,
    strategy: chosen.modeled_strategy,
    moves: chosen.moves,
    win_rate: chosen.modeled_win_rate,
    modeled_from_strategy: sourceRow.strategy,
  };
}

function enabledCandidates(candidates, isDraw) {
  return candidates
    .filter((candidate) => settingFor(candidate.strategy).enabled)
    .map((candidate) => ({
      ...candidate,
      modeled_win_rate: effectiveRate(candidate),
      modeled_strategy: isDraw ? `draw:${baseStrategy(candidate.strategy)}` : baseStrategy(candidate.strategy),
    }));
}

function effectiveRate(candidate) {
  const setting = settingFor(candidate.strategy);
  if (baseStrategy(candidate.strategy) === "all-out") {
    const override = Number(setting.rateOverride);
    if (setting.rateOverride !== "" && Number.isFinite(override)) return clamp(override / 100, 0, 1);
    return setting.defaultRate ?? candidate.win_rate ?? 0.5;
  }
  if (!setting.enabled) return -1;
  const override = Number(setting.rateOverride);
  if (setting.rateOverride !== "" && Number.isFinite(override)) return clamp(override / 100, 0, 1);
  if (candidate.moves?.length) {
    return strategyWinRate(baseStrategy(candidate.strategy), candidate.moves, winConfigFromJson());
  }
  return candidate.win_rate ?? setting.defaultRate ?? 0;
}

function winConfigFromJson() {
  return {
    strategy_rates: { ...DEFAULT_WIN_RATES, ...(state.winRateConfig?.strategy_rates || {}) },
    conditional_rates: state.winRateConfig?.conditional_rates || [],
    move_overrides: state.winRateConfig?.move_overrides || {},
  };
}

function settingFor(strategy) {
  const base = baseStrategy(strategy);
  return ensureModel(sourceReport()).settings[base] || { enabled: true, rateOverride: "", defaultRate: 0 };
}

function buildSelection(rows, trials, originalSelection) {
  const order = originalSelection.map((row) => row.strategy);
  for (const row of rows) {
    if (!order.includes(row.strategy)) order.push(row.strategy);
  }

  return order.map((strategy) => {
    const selectedRows = rows.filter((row) => row.strategy === strategy);
    const selected = selectedRows.length;
    const expected = selectedRows.reduce((sum, row) => sum + row.win_rate, 0);
    return {
      strategy,
      selected,
      adoption_rate: selected / trials,
      assigned_win_rate: settingFor(strategy).defaultRate,
      average_selected_win_rate: selected ? expected / selected : null,
      expected_win_contribution: expected / trials,
    };
  });
}

function renderSummary(source, modeled) {
  const metrics = [
    ["試行数", formatInt(modeled.trials)],
    ["期待勝率", formatPercent(modeled.expected_win_rate), "good"],
    ["採用戦術数", formatInt(modeled.selection.filter((row) => row.selected > 0).length)],
    ["ドロー成功", `${formatInt(modeled.draw_successes)} (${formatPercent(modeled.draw_success_rate_given_attempt)})`],
    ["全出し", `${formatInt(modeled.all_outs)} (${formatPercent(modeled.all_out_rate)})`],
    ["合成数手", formatInt(source.composite_moves)],
  ];

  els.summaryMetrics.innerHTML = metrics.map(([label, value, tone]) => `
    <div class="metric">
      <span class="metric__label">${escapeHtml(label)}</span>
      <span class="metric__value ${tone || ""}">${escapeHtml(value)}</span>
    </div>
  `).join("");

  els.compareStrip.innerHTML = renderDataComparison(source, modeled);
}

function renderDataComparison(source, modeled) {
  if (state.customReports) {
    const baselineReport = state.customReports.normal;
    if (state.activeKey === "uta" && state.customReports.uta && baselineReport && source !== baselineReport) {
      return [
        ["比較対象", "追加"],
        ["通常比 期待勝率", signedPercentPoint(source.expected_win_rate - baselineReport.expected_win_rate)],
        ["通常比 全出し", signedInt(source.all_outs - baselineReport.all_outs)],
        ["通常比 合成数手", signedInt(source.composite_moves - baselineReport.composite_moves)],
        ["seed", source.seed ?? "-"],
      ].map(renderDelta).join("");
    }
    return [
      ["モデル期待勝率", formatPercent(modeled.expected_win_rate)],
      ["seed", source.seed ?? "-"],
      ["素数手", formatInt(source.prime_moves)],
      ["合成数手", formatInt(source.composite_moves)],
    ].map(renderDelta).join("");
  }
  const normal = state.reports.normal;
  if (!normal || source === normal || state.activeKey === "custom") {
    return [
      ["モデル期待勝率", formatPercent(modeled.expected_win_rate)],
      ["seed", source.seed ?? "-"],
      ["素数手", formatInt(source.prime_moves)],
      ["合成数手", formatInt(source.composite_moves)],
    ].map(renderDelta).join("");
  }

  return [
    ["比較対象", DATASETS[state.activeKey]?.label || "比較データ"],
    ["通常データ比 期待勝率", signedPercentPoint(source.expected_win_rate - normal.expected_win_rate)],
    ["通常データ比 全出し", signedInt(source.all_outs - normal.all_outs)],
    ["通常データ比 合成数手", signedInt(source.composite_moves - normal.composite_moves)],
    ["seed", source.seed ?? "-"],
  ].map(renderDelta).join("");
}

function renderDelta([label, value]) {
  return `<span class="delta">${escapeHtml(label)} <b>${escapeHtml(value)}</b></span>`;
}

function renderStrategies(report) {
  const rows = report.selection || [];
  const maxSelected = Math.max(1, ...rows.map((row) => row.selected || 0));
  els.strategyTable.innerHTML = `
    <div class="strategy-row strategy-row--head">
      <strong>戦術</strong>
      <span>採用</span>
      <span>使用率</span>
      <span class="hide-mobile">平均勝率</span>
      <span>分布</span>
    </div>
  ` + rows.map((row) => `
    <div class="strategy-row">
      <strong>${escapeHtml(row.strategy)}</strong>
      <span>${formatInt(row.selected)}件</span>
      <span>${formatPercent(row.adoption_rate)}</span>
      <span class="hide-mobile">${formatPercent(row.average_selected_win_rate)}</span>
      <div class="bar" aria-hidden="true"><i style="width:${Math.max(2, (row.selected || 0) / maxSelected * 100)}%"></i></div>
    </div>
  `).join("");

  const checked = new Set([...document.querySelectorAll(".strategy-filter:checked")].map((input) => input.value));
  const hadFilters = document.querySelectorAll(".strategy-filter").length > 0;
  const strategies = [...new Set(modeledRows(report).map((row) => baseStrategy(row.strategy)))];
  els.strategyFilters.innerHTML = strategies.map((strategy) => {
    const isChecked = !hadFilters || checked.has(strategy);
    return `
      <label class="check-chip">
        <input class="strategy-filter" type="checkbox" value="${escapeHtml(strategy)}" ${isChecked ? "checked" : ""}>
        ${escapeHtml(strategy)}
      </label>
    `;
  }).join("");

  document.querySelectorAll(".strategy-filter").forEach((input) => {
    input.addEventListener("input", renderCases);
  });
}

function renderCases() {
  const modeled = buildModeledReport(sourceReport());
  const selected = new Set([...document.querySelectorAll(".strategy-filter:checked")].map((input) => input.value));
  const scope = els.scope.value;
  const query = els.search.value.trim().toLowerCase();
  const order = els.order.value;

  let rows = modeledRows(modeled).filter((row) => {
    if (!matchesStrategy(row, selected, scope)) return false;
    if (!query) return true;
    return searchableText(row).includes(query);
  });

  rows = rows.sort((a, b) => compareRows(a, b, order));

  els.caseCount.textContent = `${rows.length} / ${modeledRows(modeled).length} 件を表示`;
  els.caseList.innerHTML = rows.length
    ? rows.map(renderCase).join("")
    : `<div class="empty">該当する試行はありません</div>`;
}

function sourceRows(report) {
  return Object.entries(report.examples || {}).flatMap(([strategy, cases]) => (
    cases.map((item) => ({ ...item, strategy }))
  )).sort((a, b) => a.trial - b.trial);
}

function modeledRows(report) {
  return report.modeled_rows || sourceRows(report);
}

function renderCase(row) {
  return `
    <article class="case">
      <div class="casehead">
        <strong>#${row.trial} ${escapeHtml(row.strategy)}</strong>
        <span class="rate">${formatPercent(row.win_rate)}</span>
        ${row.drawn_card === null ? "" : `<span class="pill">ドロー ${escapeHtml(rankLabel(row.drawn_card))}</span>`}
      </div>
      <div class="label">初期手札</div>
      <div class="cards">${row.hand.map(renderCard).join("")}</div>
      <div class="label">採用手順</div>
      ${renderRoute(row.moves)}
      ${renderCandidates(row.initial_candidates, "初手で成立した候補")}
      ${renderCandidates(row.draw_candidates, "ドロー後に成立した候補")}
    </article>
  `;
}

function renderCandidates(items, title) {
  if (!items?.length) return "";
  return `
    <details>
      <summary>${escapeHtml(title)} (${items.length})</summary>
      ${items.map((item) => `
        <div class="candidate">
          <div class="candidate-head">
            <b>${escapeHtml(item.strategy)}</b>
            <span>${formatPercent(item.win_rate)}</span>
            <span>モデル ${formatPercent(effectiveRate(item))}</span>
            <span>最終手 ${formatInt(item.finish_size)}枚</span>
          </div>
          ${renderRoute(item.moves)}
        </div>
      `).join("")}
    </details>
  `;
}

function renderRoute(moves) {
  return `<div class="route">${moves.map((item, index) => `${index ? '<span class="arrow">→</span>' : ""}${renderMove(item)}`).join("")}</div>`;
}

function renderMove(text) {
  const isDraw = text.startsWith("DRAW:");
  const isCombined = text.startsWith("COMBINED:");
  const stripped = text.replace(/^DRAW:|^COMBINED:/, "");
  const annotationIndex = stripped.indexOf(" (X=");
  const base = annotationIndex >= 0 ? stripped.slice(0, annotationIndex) : stripped;
  const annotation = annotationIndex >= 0 ? stripped.slice(annotationIndex) : "";
  const cards = !base.includes("=") ? renderPlainCards(base) : null;
  const prefix = isDraw ? "DRAW " : isCombined ? "別ルート " : "";

  return `
    <span class="move ${isDraw ? "draw" : ""} ${isCombined ? "combined" : ""}">
      ${prefix}${cards || `<span class="plain">${escapeHtml(stripped)}</span>`}
      ${cards && annotation ? `<span class="pill">${escapeHtml(annotation)}</span>` : ""}
    </span>
  `;
}

function renderPlainCards(text) {
  const cards = [];
  for (const char of text) {
    if (/[1-9]/.test(char)) {
      cards.push(renderCard(Number(char)));
    } else if (/[tjqkTQJK]/.test(char)) {
      cards.push(renderCard(faceMap[char.toLowerCase()]));
    } else if (char === "X" || char === "x") {
      cards.push(renderCard(0));
    } else {
      return null;
    }
  }
  return cards.join("");
}

function renderCard(rank) {
  const classes = ["card"];
  if (rank === 0) classes.push("joker");
  if (rank >= 10) classes.push("face");
  return `<span class="${classes.join(" ")}">${escapeHtml(rankLabel(rank))}</span>`;
}

function matchesStrategy(row, selected, scope) {
  if (selected.has(baseStrategy(row.strategy))) return true;
  if (scope !== "candidate") return false;
  const candidates = [...(row.initial_candidates || []), ...(row.draw_candidates || [])];
  return candidates.some((candidate) => selected.has(baseStrategy(candidate.strategy)));
}

function compareRows(a, b, order) {
  if (order === "strategy") return a.strategy.localeCompare(b.strategy) || a.trial - b.trial;
  if (order === "rate") return b.win_rate - a.win_rate || a.trial - b.trial;
  if (order === "finish") return finishSize(b) - finishSize(a) || a.trial - b.trial;
  return a.trial - b.trial;
}

function finishSize(row) {
  const candidates = [...(row.initial_candidates || []), ...(row.draw_candidates || [])];
  const selected = candidates.find((candidate) => baseStrategy(candidate.strategy) === baseStrategy(row.strategy));
  return selected?.finish_size || 0;
}

function searchableText(row) {
  return JSON.stringify(row).toLowerCase();
}

function baseStrategy(strategy) {
  return strategy.replace(/^draw:/, "");
}

function rankLabel(rank) {
  return symbols[rank] ?? String(rank);
}

function formatPercent(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return `${(value * 100).toFixed(value >= 0.995 ? 1 : 2)}%`;
}

function percentNumber(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "";
  return String(Math.round(value * 1000) / 10);
}

function signedPercentPoint(value) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(2)}pt`;
}

function signedInt(value) {
  const sign = value >= 0 ? "+" : "";
  return `${sign}${formatInt(value)}`;
}

function formatInt(value) {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  return Number(value).toLocaleString("ja-JP");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
  }[char]));
}

init().catch((error) => {
  els.caseList.innerHTML = `<div class="error">${escapeHtml(error.message)}</div>`;
});
