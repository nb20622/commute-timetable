import { APP_VERSION, CSV_DATE } from "./version.js";

const TIME_PATTERN = /^[0-9]{2}:[0-9]{2}$/;
const EXPECTED_TIME_FORMAT = "HH:mm または 24:xx";
const TRANSFER_MINUTES = 3;

const ORIGIN_LABELS = {
  nishisanso: "西三荘",
  moriguchishi: "守口市",
};

/**
 * Convert an HH:mm or 24:xx value to minutes from 00:00.
 */
export function parseTimeToMinutes(value) {
  if (typeof value !== "string" || !TIME_PATTERN.test(value)) {
    throw new RangeError(`Invalid time: ${String(value)}`);
  }

  const [hours, minutes] = value.split(":").map(Number);
  if (hours > 24 || minutes > 59) {
    throw new RangeError(`Invalid time: ${value}`);
  }

  return hours * 60 + minutes;
}

function createCsvError(fileName, lineNumber, value, type, message) {
  return {
    fileName,
    lineNumber,
    value,
    expected: EXPECTED_TIME_FORMAT,
    type,
    message,
  };
}

/**
 * Parse one timetable CSV without throwing so a broken section can be stopped
 * independently from the rest of the application.
 */
export function parseCsv(csvText, fileName = "") {
  const trains = [];
  const errors = [];
  const source = typeof csvText === "string" ? csvText : "";

  if (source.trim() === "") {
    errors.push(
      createCsvError(fileName, 1, "", "empty-data", "CSVデータが空です。"),
      createCsvError(fileName, 1, "", "insufficient-data", "区間データが0件です。"),
    );
    return { trains, errors };
  }

  const lines = source.split(/\r?\n/);
  while (lines.length > 0 && lines.at(-1).trim() === "") {
    lines.pop();
  }

  const header = lines[0].replace(/^\uFEFF/, "");
  if (header !== "dep,arr") {
    errors.push(
      createCsvError(fileName, 1, lines[0], "invalid-header", "ヘッダは dep,arr である必要があります。"),
    );
  } else {
    for (let index = 1; index < lines.length; index += 1) {
      const lineNumber = index + 1;
      const values = lines[index].split(",");
      const dep = values[0] ?? "";
      const arr = values[1] ?? "";

      if (values.length !== 2 || dep === "" || arr === "") {
        errors.push(
          createCsvError(fileName, lineNumber, lines[index], "missing-value", "dep または arr が欠落しています。"),
        );
        continue;
      }

      let depMin;
      let arrMin;
      try {
        depMin = parseTimeToMinutes(dep);
      } catch {
        errors.push(
          createCsvError(fileName, lineNumber, dep, "invalid-time", "時刻形式が不正です。"),
        );
      }

      try {
        arrMin = parseTimeToMinutes(arr);
      } catch {
        errors.push(
          createCsvError(fileName, lineNumber, arr, "invalid-time", "時刻形式が不正です。"),
        );
      }

      if (depMin !== undefined && arrMin !== undefined) {
        trains.push({ dep, arr, depMin, arrMin });
      }
    }
  }

  if (trains.length === 0) {
    errors.push(
      createCsvError(fileName, lines.length > 1 ? 2 : 1, "", "insufficient-data", "区間データが0件です。"),
    );
  }

  return { trains, errors };
}

function findEarliestTrain(trains, minimumDeparture) {
  return trains
    .filter((train) => train.depMin >= minimumDeparture)
    .reduce((earliest, train) => {
      if (
        earliest === null
        || train.depMin < earliest.depMin
        || (train.depMin === earliest.depMin && train.arrMin < earliest.arrMin)
      ) {
        return train;
      }
      return earliest;
    }, null);
}

function withStations(train, from, to) {
  return {
    from,
    to,
    dep: train.dep,
    arr: train.arr,
    depMin: train.depMin,
    arrMin: train.arrMin,
  };
}

/**
 * Build complete routes using the earliest available train at each transfer.
 */
export function buildRouteCandidates(first, second, third, origin, baseMin) {
  const originLabel = ORIGIN_LABELS[origin];
  if (!originLabel) {
    throw new RangeError(`Unknown origin: ${String(origin)}`);
  }

  const candidates = [];
  for (const firstTrain of first) {
    if (firstTrain.depMin < baseMin) {
      continue;
    }

    const secondTrain = findEarliestTrain(
      second,
      firstTrain.arrMin + TRANSFER_MINUTES,
    );
    if (!secondTrain) {
      continue;
    }

    const thirdTrain = findEarliestTrain(
      third,
      secondTrain.arrMin + TRANSFER_MINUTES,
    );
    if (!thirdTrain) {
      continue;
    }

    candidates.push({
      id: `${origin}-${firstTrain.depMin}-${thirdTrain.arrMin}`,
      origin,
      originLabel,
      destinationLabel: "新深江",
      first: withStations(firstTrain, originLabel, "関目"),
      second: withStations(secondTrain, "関目成育", "今里"),
      third: withStations(thirdTrain, "今里", "新深江"),
      totalMinutes: thirdTrain.arrMin - firstTrain.depMin,
    });
  }

  candidates.sort((left, right) => (
    left.first.depMin - right.first.depMin
    || left.third.arrMin - right.third.arrMin
  ));

  // For each arrival, retain only the latest departure; exact dep/arr pairs
  // naturally collapse to one route.
  const bestByArrival = new Map();
  for (const candidate of candidates) {
    const current = bestByArrival.get(candidate.third.arrMin);
    if (!current || candidate.first.depMin > current.first.depMin) {
      bestByArrival.set(candidate.third.arrMin, candidate);
    }
  }

  return [...bestByArrival.values()].sort((left, right) => (
    left.first.depMin - right.first.depMin
    || left.third.arrMin - right.third.arrMin
  ));
}

/**
 * Start the displayed candidate list from a route explicitly chosen by ID.
 */
export function getVisibleRouteCandidates(routes, preferredRouteId) {
  if (!preferredRouteId) {
    return routes;
  }

  const preferredIndex = routes.findIndex(
    (route) => route.id === preferredRouteId,
  );
  return preferredIndex >= 0 ? routes.slice(preferredIndex) : routes;
}

/**
 * Return the active ride stage at the exact timetable boundary.
 */
export function getRideStatus(route, nowMin) {
  if (nowMin < route.first.depMin) {
    return {
      status: "before-departure",
      label: `${route.originLabel} 発まで`,
      targetMin: route.first.depMin,
      keepRide: true,
    };
  }

  if (nowMin < route.second.depMin) {
    return {
      status: "to-sekime-seiiku",
      label: "関目成育 発まで",
      targetMin: route.second.depMin,
      keepRide: true,
    };
  }

  if (nowMin < route.third.depMin) {
    return {
      status: "to-imazato",
      label: "今里 発まで",
      targetMin: route.third.depMin,
      keepRide: true,
    };
  }

  if (nowMin < route.third.arrMin) {
    return {
      status: "to-shinfukae",
      label: "新深江 着まで",
      targetMin: route.third.arrMin,
      keepRide: true,
    };
  }

  if (nowMin <= route.third.arrMin + 5) {
    return {
      status: "arrived",
      label: "到着済み",
      targetMin: null,
      keepRide: true,
    };
  }

  return {
    status: "expired",
    label: null,
    targetMin: null,
    keepRide: false,
  };
}

/**
 * Normalize a device clock value to the previous service day's late-night
 * minutes so it can be compared with 24:xx timetable entries.
 */
export function serviceMinutesFromClock(hours, minutes) {
  return hours < 5
    ? hours * 60 + minutes + 1440
    : hours * 60 + minutes;
}

/**
 * Format a non-negative countdown value for display.
 */
export function formatCountdown(totalSeconds) {
  const safeSeconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `あと ${minutes}分${seconds}秒`;
}

if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", () => {
    const FILES = {
      nishisanso: "keihan_nishisanso_to_sekime_weekday.csv",
      moriguchishi: "keihan_moriguchishi_to_sekime_weekday.csv",
      second: "metro_sekime_seiiku_to_imazato_weekday.csv",
      third: "metro_imazato_to_shinfukae_weekday.csv",
    };
    const VALID_ORIGINS = new Set(["nishisanso", "moriguchishi"]);
    const VALID_MODES = new Set(["current", "manual"]);
    const DEFAULT_MANUAL_TIME = "19:30";

    const routeContent = document.querySelector("#route-content");
    const errorContent = document.querySelector("#error-content");
    const manualTimeRow = document.querySelector("#manual-time-row");
    const manualTimeInput = document.querySelector("#manual-time");
    const updateButton = document.querySelector("#update-data");
    const updateStatus = document.querySelector("#update-status");
    const originButtons = [...document.querySelectorAll("[data-origin]")];
    const modeInputs = [...document.querySelectorAll('input[name="mode"]')];
    let serviceWorkerRegistration = null;

    const readStoredValue = (key) => {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    };

    const writeStoredValue = (key, value) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        // Storage can be unavailable in restricted browser contexts.
      }
    };

    const removeStoredValue = (key) => {
      try {
        localStorage.removeItem(key);
      } catch {
        // Storage can be unavailable in restricted browser contexts.
      }
    };

    function getClockState() {
      const now = new Date();
      const serviceMinutes = serviceMinutesFromClock(
        now.getHours(),
        now.getMinutes(),
      );
      const serviceSeconds = serviceMinutes * 60 + now.getSeconds();
      const serviceDate = new Date(now);
      if (now.getHours() < 5) {
        serviceDate.setDate(serviceDate.getDate() - 1);
      }

      return {
        serviceMinutes,
        serviceSeconds,
        serviceDate: [
          serviceDate.getFullYear(),
          String(serviceDate.getMonth() + 1).padStart(2, "0"),
          String(serviceDate.getDate()).padStart(2, "0"),
        ].join("-"),
      };
    }

    function isStoredRoute(value) {
      const sections = value && [value.first, value.second, value.third];
      return Boolean(
        value
        && typeof value.id === "string"
        && typeof value.origin === "string"
        && typeof value.originLabel === "string"
        && sections.every((section) => (
          section
          && typeof section.dep === "string"
          && typeof section.arr === "string"
          && Number.isFinite(section.depMin)
          && Number.isFinite(section.arrMin)
        )),
      );
    }

    function restoreActiveRideRoute() {
      const stored = readStoredValue("activeRideRoute");
      if (!stored) {
        return null;
      }

      try {
        const route = JSON.parse(stored);
        const clock = getClockState();
        if (
          !isStoredRoute(route)
          || route.serviceDate !== clock.serviceDate
          || !getRideStatus(route, clock.serviceMinutes).keepRide
        ) {
          removeStoredValue("activeRideRoute");
          return null;
        }
        return route;
      } catch {
        removeStoredValue("activeRideRoute");
        return null;
      }
    }

    const storedOrigin = readStoredValue("selectedOrigin");
    const storedMode = readStoredValue("mode");
    const state = {
      selectedOrigin: VALID_ORIGINS.has(storedOrigin)
        ? storedOrigin
        : "nishisanso",
      mode: VALID_MODES.has(storedMode) ? storedMode : "current",
      manualTime: readStoredValue("manualTime") ?? DEFAULT_MANUAL_TIME,
      detailOpenRouteId: readStoredValue("detailOpenRouteId"),
      activeRideRoute: restoreActiveRideRoute(),
      preferredRouteId: null,
      data: null,
      nearestDepartureMin: null,
      activeRideStatus: null,
    };

    document.querySelector("#csv-date").textContent = CSV_DATE;
    document.querySelector("#app-version").textContent = APP_VERSION;
    manualTimeInput.value = state.manualTime;

    function createElement(tagName, className, textContent) {
      const element = document.createElement(tagName);
      if (className) {
        element.className = className;
      }
      if (textContent !== undefined) {
        element.textContent = textContent;
      }
      return element;
    }

    function setControlsFromState() {
      for (const button of originButtons) {
        const selected = button.dataset.origin === state.selectedOrigin;
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
      }

      for (const input of modeInputs) {
        input.checked = input.value === state.mode;
      }
      manualTimeRow.hidden = state.mode !== "manual";
    }

    function getBaseMinutes() {
      if (state.mode === "manual") {
        try {
          return { value: parseTimeToMinutes(state.manualTime), error: null };
        } catch {
          return {
            value: null,
            error: `時刻「${state.manualTime}」が不正です。${EXPECTED_TIME_FORMAT}で入力してください。`,
          };
        }
      }

      const clock = getClockState();
      return {
        // Once seconds have elapsed within a minute, that minute's departure
        // is already unavailable.
        value: Math.ceil(clock.serviceSeconds / 60),
        error: null,
      };
    }

    function renderMessage(message) {
      errorContent.hidden = true;
      errorContent.replaceChildren();
      routeContent.hidden = false;
      routeContent.replaceChildren(
        createElement("p", "status-message", message),
      );
    }

    function renderInputError(message) {
      routeContent.hidden = true;
      errorContent.hidden = false;
      const title = createElement("h2", "", "入力エラー");
      const detail = createElement("p", "", message);
      errorContent.replaceChildren(title, detail);
    }

    function renderDataErrors(errors) {
      routeContent.hidden = true;
      errorContent.hidden = false;
      const title = createElement("h2", "", "データエラー");
      const items = errors.map((error) => {
        const item = createElement("div", "error-item");
        item.append(
          createElement(
            "p",
            "",
            `${error.fileName} の${error.lineNumber}行目：`,
          ),
          createElement("p", "", error.message),
          createElement("p", "", `値：${error.value}`),
          createElement("p", "", `期待形式：${error.expected}`),
        );
        return item;
      });
      errorContent.replaceChildren(title, ...items);
    }

    function setDetailOpenRouteId(routeId) {
      state.detailOpenRouteId = routeId;
      if (routeId) {
        writeStoredValue("detailOpenRouteId", routeId);
      } else {
        removeStoredValue("detailOpenRouteId");
      }
    }

    function toggleRouteDetail(route) {
      setDetailOpenRouteId(
        state.detailOpenRouteId === route.id ? null : route.id,
      );
      render();
    }

    function createCountdown(label, targetMin, className = "") {
      const clock = getClockState();
      const wrapper = createElement("div", `countdown ${className}`.trim());
      const labelElement = createElement("p", "countdown-label", label);
      const valueElement = createElement(
        "p",
        "countdown-value",
        formatCountdown(targetMin * 60 - clock.serviceSeconds),
      );
      valueElement.dataset.countdownTarget = String(targetMin * 60);
      wrapper.append(labelElement, valueElement);
      return wrapper;
    }

    function createRouteDetail(route, showCountdown) {
      const detail = createElement("div", "route-detail");
      detail.id = `detail-${route.id}`;

      if (showCountdown) {
        const status = getRideStatus(route, getClockState().serviceMinutes);
        if (status.keepRide && status.targetMin !== null) {
          detail.append(
            createCountdown(status.label, status.targetMin, "detail-countdown"),
          );
        }
      }

      const sections = [
        [route.first.dep, route.first.from, "発", route.first.arr, route.first.to, "着"],
        [route.second.dep, route.second.from, "発", route.second.arr, route.second.to, "着"],
        [route.third.dep, route.third.from, "発", route.third.arr, route.third.to, "着"],
      ];
      for (const [dep, from, depAction, arr, to, arrAction] of sections) {
        const section = createElement("div", "detail-section");
        section.append(
          createElement("p", "", `${dep} ${from} ${depAction}`),
          createElement("p", "", `${arr} ${to} ${arrAction}`),
        );
        detail.append(section);
      }
      return detail;
    }

    function createDetailButton(route, rerender) {
      const button = createElement(
        "button",
        "secondary-button",
        state.detailOpenRouteId === route.id ? "詳細を閉じる" : "詳細を見る",
      );
      button.type = "button";
      button.setAttribute("aria-expanded", String(
        state.detailOpenRouteId === route.id,
      ));
      button.setAttribute("aria-controls", `detail-${route.id}`);
      button.addEventListener("click", (event) => {
        event.stopPropagation();
        setDetailOpenRouteId(
          state.detailOpenRouteId === route.id ? null : route.id,
        );
        rerender();
      });
      return button;
    }

    function appendDetailIfOpen(container, route, showCountdown) {
      if (state.detailOpenRouteId === route.id) {
        container.append(createRouteDetail(route, showCountdown));
      }
    }

    function useRoute(route) {
      state.activeRideRoute = {
        ...route,
        serviceDate: getClockState().serviceDate,
      };
      writeStoredValue(
        "activeRideRoute",
        JSON.stringify(state.activeRideRoute),
      );
      render();
    }

    function clearActiveRideRoute() {
      state.activeRideRoute = null;
      state.activeRideStatus = null;
      removeStoredValue("activeRideRoute");
    }

    function createNearestRouteCard(route, nextRoute) {
      const card = createElement("article", "route-card");
      card.addEventListener("click", (event) => {
        if (
          event.target.closest("button")
          || event.target.closest(".route-detail")
        ) {
          return;
        }
        toggleRouteDetail(route);
      });
      if (state.mode === "current") {
        card.append(
          createCountdown(
            state.preferredRouteId
              ? "選択中ルートの出発まで"
              : "次の成立ルートまで",
            route.first.depMin,
            "nearest-countdown",
          ),
        );
      }
      card.append(
        createElement(
          "p",
          "route-main",
          `${route.first.dep} ${route.originLabel} 発 → ${route.third.arr} 新深江 着`,
        ),
        createElement(
          "p",
          "route-duration",
          `所要時間 ${route.totalMinutes}分`,
        ),
      );

      const actions = createElement("div", "route-actions");
      if (state.mode === "current") {
        const useButton = createElement(
          "button",
          "primary-button",
          "このルートを使う",
        );
        useButton.type = "button";
        useButton.addEventListener("click", () => useRoute(route));
        actions.append(useButton);
      }
      actions.append(createDetailButton(route, render));
      if (state.mode === "current" && nextRoute) {
        const nextRouteButton = createElement(
          "button",
          "secondary-button next-route-button",
          "1本後のルートに変更",
        );
        nextRouteButton.type = "button";
        nextRouteButton.addEventListener("click", () => {
          state.preferredRouteId = nextRoute.id;
          setDetailOpenRouteId(null);
          render();
        });
        actions.append(nextRouteButton);
      }
      card.append(actions);
      appendDetailIfOpen(card, route, state.mode === "current");
      return card;
    }

    function createNextRouteItem(route) {
      const item = createElement("li", "next-route-item");
      const summary = createElement("div", "next-route-summary");
      summary.tabIndex = 0;
      summary.setAttribute("role", "button");
      summary.setAttribute("aria-expanded", String(
        state.detailOpenRouteId === route.id,
      ));
      summary.setAttribute("aria-controls", `detail-${route.id}`);
      summary.append(
        createElement("span", "", `${route.first.dep} → ${route.third.arr}`),
        createElement("span", "", `${route.totalMinutes}分`),
      );

      item.addEventListener("click", (event) => {
        if (
          event.target.closest("button")
          || event.target.closest(".route-detail")
        ) {
          return;
        }
        toggleRouteDetail(route);
      });
      summary.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggleRouteDetail(route);
        }
      });

      const actions = createElement("div", "candidate-actions");
      actions.append(createDetailButton(route, render));
      item.append(summary, actions);
      appendDetailIfOpen(item, route, state.mode === "current");
      return item;
    }

    function renderRoutes(routes) {
      errorContent.hidden = true;
      errorContent.replaceChildren();
      routeContent.hidden = false;

      if (routes.length === 0) {
        renderMessage("本日の運行は終了しました");
        return;
      }

      if (
        state.preferredRouteId
        && !routes.some((route) => route.id === state.preferredRouteId)
      ) {
        state.preferredRouteId = null;
      }
      const visibleRoutes = state.mode === "current"
        ? getVisibleRouteCandidates(routes, state.preferredRouteId)
        : routes;
      const nearest = visibleRoutes[0];
      state.nearestDepartureMin = nearest.first.depMin;
      const card = createNearestRouteCard(nearest, visibleRoutes[1]);

      const nextRoutes = visibleRoutes.slice(1, 4);
      if (nextRoutes.length === 0) {
        routeContent.replaceChildren(card);
        return;
      }

      const nextSection = createElement("section", "next-routes");
      const heading = createElement("h2", "", "次の候補");
      const list = createElement("ul", "next-route-list");
      for (const route of nextRoutes) {
        list.append(createNextRouteItem(route));
      }
      nextSection.append(heading, list);
      routeContent.replaceChildren(card, nextSection);
    }

    function renderActiveRideRoute(route) {
      errorContent.hidden = true;
      errorContent.replaceChildren();
      routeContent.hidden = false;

      const clock = getClockState();
      const status = getRideStatus(route, clock.serviceMinutes);
      if (!status.keepRide) {
        clearActiveRideRoute();
        render();
        return;
      }
      state.activeRideStatus = status.status;

      const card = createElement("article", "active-ride-card");
      card.append(createElement("p", "active-ride-heading", "乗車中ルート"));
      if (status.status === "arrived") {
        card.append(createElement("p", "ride-status-label", status.label));
      } else {
        card.append(createCountdown(status.label, status.targetMin));
      }
      card.append(
        createElement(
          "p",
          "route-main",
          `${route.first.dep} ${route.originLabel} 発 → ${route.third.arr} 新深江 着`,
        ),
      );

      const actions = createElement("div", "route-actions");
      const endButton = createElement(
        "button",
        "danger-button",
        "乗車中ルートを終了",
      );
      endButton.type = "button";
      endButton.addEventListener("click", () => {
        clearActiveRideRoute();
        render();
      });
      actions.append(createDetailButton(route, renderActiveRide));
      actions.append(endButton);
      card.append(actions);
      appendDetailIfOpen(card, route, true);
      routeContent.replaceChildren(card);
    }

    function renderActiveRide() {
      if (state.activeRideRoute) {
        renderActiveRideRoute(state.activeRideRoute);
      } else {
        render();
      }
    }

    // Only errors from the three CSVs used by the selected origin stop it.
    function render() {
      setControlsFromState();
      state.nearestDepartureMin = null;

      if (state.mode === "current" && state.activeRideRoute) {
        renderActiveRideRoute(state.activeRideRoute);
        return;
      }

      if (!state.data) {
        renderMessage("時刻表を読み込んでいます...");
        return;
      }

      const usedSections = [
        state.data[state.selectedOrigin],
        state.data.second,
        state.data.third,
      ];
      const errors = usedSections.flatMap((section) => section.errors);
      if (errors.length > 0) {
        renderDataErrors(errors);
        return;
      }

      const baseMinutes = getBaseMinutes();
      if (baseMinutes.error) {
        renderInputError(baseMinutes.error);
        return;
      }

      const routes = buildRouteCandidates(
        usedSections[0].trains,
        usedSections[1].trains,
        usedSections[2].trains,
        state.selectedOrigin,
        baseMinutes.value,
      );
      renderRoutes(routes);
    }

    function updateCountdowns() {
      const clock = getClockState();

      if (state.activeRideRoute) {
        const status = getRideStatus(
          state.activeRideRoute,
          clock.serviceMinutes,
        );
        if (
          !status.keepRide
          || state.activeRideRoute.serviceDate !== clock.serviceDate
        ) {
          clearActiveRideRoute();
          render();
          return;
        }
        if (
          state.mode === "current"
          && state.activeRideStatus !== status.status
        ) {
          renderActiveRideRoute(state.activeRideRoute);
          return;
        }
      }

      if (
        state.mode === "current"
        && !state.activeRideRoute
        && state.nearestDepartureMin !== null
        && clock.serviceSeconds > state.nearestDepartureMin * 60
      ) {
        render();
        return;
      }

      if (state.mode !== "current") {
        return;
      }
      for (const element of document.querySelectorAll(
        "[data-countdown-target]",
      )) {
        const targetSeconds = Number(element.dataset.countdownTarget);
        element.textContent = formatCountdown(
          targetSeconds - clock.serviceSeconds,
        );
      }
    }

    function createLoadError(fileName, message) {
      return {
        trains: [],
        errors: [{
          fileName,
          lineNumber: 1,
          value: "",
          expected: EXPECTED_TIME_FORMAT,
          type: "load-error",
          message,
        }],
      };
    }

    async function loadCsv(fileName) {
      try {
        const response = await fetch(`data/${fileName}`);
        if (!response.ok) {
          return createLoadError(
            fileName,
            `CSVを読み込めませんでした（HTTP ${response.status}）。`,
          );
        }
        return parseCsv(await response.text(), fileName);
      } catch {
        return createLoadError(fileName, "CSVを読み込めませんでした。");
      }
    }

    async function registerServiceWorker() {
      if (!("serviceWorker" in navigator)) {
        return null;
      }

      try {
        serviceWorkerRegistration = await navigator.serviceWorker.register(
          "service-worker.js",
        );
        return serviceWorkerRegistration;
      } catch {
        // PWA support is optional; timetable features continue without it.
        return null;
      }
    }

    function waitForActivation(worker) {
      if (!worker || worker.state === "activated") {
        return Promise.resolve();
      }

      return new Promise((resolve, reject) => {
        const timeoutId = setTimeout(() => {
          reject(new Error("Service Worker activation timed out."));
        }, 15000);
        worker.addEventListener("statechange", () => {
          if (worker.state === "activated") {
            clearTimeout(timeoutId);
            resolve();
          } else if (worker.state === "redundant") {
            clearTimeout(timeoutId);
            reject(new Error("Service Worker became redundant."));
          }
        });
      });
    }

    function requestCacheRefresh(worker) {
      return new Promise((resolve, reject) => {
        const channel = new MessageChannel();
        const timeoutId = setTimeout(() => {
          reject(new Error("Cache refresh timed out."));
        }, 30000);

        channel.port1.onmessage = (event) => {
          clearTimeout(timeoutId);
          if (event.data?.ok) {
            resolve();
          } else {
            reject(new Error(event.data?.message || "Cache refresh failed."));
          }
        };
        worker.postMessage(
          { type: "REFRESH_CACHE" },
          [channel.port2],
        );
      });
    }

    function setUpdateStatus(message, type = "") {
      updateStatus.textContent = message;
      updateStatus.classList.toggle("is-success", type === "success");
      updateStatus.classList.toggle("is-error", type === "error");
    }

    async function updateApplicationData() {
      updateButton.disabled = true;
      updateButton.textContent = "更新中…";
      setUpdateStatus("最新データを確認しています。");

      try {
        if (!("serviceWorker" in navigator)) {
          throw new Error("Service Worker is unavailable.");
        }

        const registration = serviceWorkerRegistration
          || await registerServiceWorker();
        if (!registration) {
          throw new Error("Service Worker registration failed.");
        }

        await registration.update();

        const pendingWorker = registration.waiting || registration.installing;
        if (pendingWorker) {
          if (pendingWorker.state === "installed") {
            pendingWorker.postMessage({ type: "SKIP_WAITING" });
          }
          await waitForActivation(pendingWorker);
        }

        const readyRegistration = await navigator.serviceWorker.ready;
        const activeWorker = readyRegistration.active
          || navigator.serviceWorker.controller;
        if (!activeWorker) {
          throw new Error("No active Service Worker.");
        }

        await requestCacheRefresh(activeWorker);
        setUpdateStatus("更新しました。再読み込みします。", "success");
        setTimeout(() => window.location.reload(), 600);
      } catch {
        setUpdateStatus(
          "更新に失敗しました（オフラインの可能性）。旧データを使用します。",
          "error",
        );
        updateButton.disabled = false;
        updateButton.textContent = "データを更新";
      }
    }

    for (const button of originButtons) {
      button.addEventListener("click", () => {
        state.selectedOrigin = button.dataset.origin;
        state.preferredRouteId = null;
        writeStoredValue("selectedOrigin", state.selectedOrigin);
        render();
      });
    }

    for (const input of modeInputs) {
      input.addEventListener("change", () => {
        if (!input.checked) {
          return;
        }
        state.mode = input.value;
        state.preferredRouteId = null;
        writeStoredValue("mode", state.mode);
        render();
      });
    }

    manualTimeInput.addEventListener("input", () => {
      state.manualTime = manualTimeInput.value.trim();
      writeStoredValue("manualTime", state.manualTime);
      render();
    });

    updateButton.addEventListener("click", updateApplicationData);

    render();
    registerServiceWorker();

    // Load every section independently so one broken origin CSV does not stop
    // the other origin from continuing to work.
    Promise.all([
      loadCsv(FILES.nishisanso),
      loadCsv(FILES.moriguchishi),
      loadCsv(FILES.second),
      loadCsv(FILES.third),
    ]).then(([nishisanso, moriguchishi, second, third]) => {
      state.data = { nishisanso, moriguchishi, second, third };
      render();
    });

    setInterval(updateCountdowns, 1000);
  });
}
