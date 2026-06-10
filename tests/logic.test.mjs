import test from "node:test";
import assert from "node:assert/strict";

import {
  buildRouteCandidates,
  formatCountdown,
  getRideStatus,
  parseCsv,
  parseTimeToMinutes,
  serviceMinutesFromClock,
} from "../commute-timetable/app.js";

function train(dep, arr) {
  return {
    dep,
    arr,
    depMin: parseTimeToMinutes(dep),
    arrMin: parseTimeToMinutes(arr),
  };
}

const standardSecond = [train("18:54", "19:06")];
const standardThird = [train("19:10", "19:14")];

test("時刻を0:00起点の分数へ変換する", () => {
  assert.equal(parseTimeToMinutes("18:42"), 1122);
  assert.equal(parseTimeToMinutes("24:10"), 1450);
  assert.equal(parseTimeToMinutes("24:00"), 1440);
});

test("不正な時刻形式を拒否する", () => {
  for (const value of ["18-42", "25:00", "18:42:00"]) {
    assert.throws(() => parseTimeToMinutes(value), RangeError);
  }
});

test("始発前の端末時刻を前日サービス日の24時台として正規化する", () => {
  assert.equal(serviceMinutesFromClock(18, 42), 1122);
  assert.equal(serviceMinutesFromClock(23, 59), 1439);
  assert.equal(serviceMinutesFromClock(0, 0), 1440);
  assert.equal(serviceMinutesFromClock(0, 10), 1450);
  assert.equal(serviceMinutesFromClock(5, 0), 300);
  assert.equal(serviceMinutesFromClock(4, 59), 1739);
});

test("残り秒数をカウントダウン表示へ整形する", () => {
  assert.equal(formatCountdown(444), "あと 7分24秒");
  assert.equal(formatCountdown(65), "あと 1分5秒");
  assert.equal(formatCountdown(0), "あと 0分0秒");
  assert.equal(formatCountdown(-10), "あと 0分0秒");
});

test("CSVをSectionTrainへ変換し、元の時刻表記を保持する", () => {
  const result = parseCsv("dep,arr\r\n18:42,18:48\r\n24:10,24:12\r\n", "test.csv");
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.trains, [
    { dep: "18:42", arr: "18:48", depMin: 1122, arrMin: 1128 },
    { dep: "24:10", arr: "24:12", depMin: 1450, arrMin: 1452 },
  ]);
});

test("CSVエラーをthrowせず、ファイル名・行番号・値・期待形式付きで収集する", () => {
  const result = parseCsv("dep,arr\n18-42,\n25:00,18:50", "broken.csv");
  assert.equal(result.trains.length, 0);
  assert.ok(result.errors.some((error) => error.type === "missing-value"));
  assert.ok(result.errors.some((error) => error.type === "invalid-time"));
  assert.ok(result.errors.some((error) => error.type === "insufficient-data"));
  for (const error of result.errors) {
    assert.equal(error.fileName, "broken.csv");
    assert.equal(typeof error.lineNumber, "number");
    assert.equal(typeof error.value, "string");
    assert.equal(error.expected, "HH:mm または 24:xx");
  }
});

test("空データと不正ヘッダを検出する", () => {
  assert.deepEqual(
    parseCsv("", "empty.csv").errors.map((error) => error.type),
    ["empty-data", "insufficient-data"],
  );
  assert.ok(
    parseCsv("departure,arrival\n18:42,18:48", "header.csv").errors
      .some((error) => error.type === "invalid-header"),
  );
});

test("4分ちょうどの乗換は成立する", () => {
  const routes = buildRouteCandidates(
    [train("18:42", "18:48")],
    [train("18:52", "19:06")],
    [train("19:10", "19:14")],
    "nishisanso",
    0,
  );
  assert.equal(routes.length, 1);
});

test("関目の乗換が3分なら候補から除外する", () => {
  const routes = buildRouteCandidates(
    [train("18:42", "18:48")],
    [train("18:51", "19:06")],
    standardThird,
    "nishisanso",
    0,
  );
  assert.deepEqual(routes, []);
});

test("今里の乗換が3分なら候補から除外する", () => {
  const routes = buildRouteCandidates(
    [train("18:42", "18:48")],
    standardSecond,
    [train("19:09", "19:14")],
    "nishisanso",
    0,
  );
  assert.deepEqual(routes, []);
});

test("各firstに対して配列順によらず最早の接続便を選ぶ", () => {
  const routes = buildRouteCandidates(
    [train("18:42", "18:48")],
    [train("19:00", "19:12"), train("18:54", "19:06")],
    [train("19:20", "19:22"), train("19:10", "19:14")],
    "nishisanso",
    0,
  );
  assert.equal(routes[0].second.dep, "18:54");
  assert.equal(routes[0].third.dep, "19:10");
});

test("候補を出発昇順、同一出発なら到着昇順にする", () => {
  const routes = buildRouteCandidates(
    [
      train("18:50", "18:56"),
      train("18:42", "18:50"),
      train("18:42", "18:48"),
    ],
    [train("18:54", "19:06"), train("19:00", "19:12")],
    [train("19:10", "19:14"), train("19:16", "19:18")],
    "nishisanso",
    0,
  );
  assert.deepEqual(
    routes.map((route) => [route.first.dep, route.third.arr]),
    [["18:42", "19:14"], ["18:50", "19:18"]],
  );
});

test("同一到着時刻では最も遅い出発だけを残す", () => {
  const routes = buildRouteCandidates(
    [train("18:42", "18:48"), train("18:50", "18:56")],
    [train("19:00", "19:06")],
    [train("19:10", "19:14")],
    "nishisanso",
    0,
  );
  assert.deepEqual(routes.map((route) => route.first.dep), ["18:50"]);
});

test("同一出発・同一到着の候補を1件へ統合する", () => {
  const routes = buildRouteCandidates(
    [train("18:42", "18:48"), train("18:42", "18:48")],
    standardSecond,
    standardThird,
    "nishisanso",
    0,
  );
  assert.equal(routes.length, 1);
});

test("基準時刻以降に完全な経路がなければ空配列を返す", () => {
  assert.deepEqual(
    buildRouteCandidates(
      [train("18:42", "18:48")],
      standardSecond,
      standardThird,
      "nishisanso",
      parseTimeToMinutes("18:43"),
    ),
    [],
  );
});

test("RouteCandidateに正式駅名と所要時間を設定する", () => {
  const [route] = buildRouteCandidates(
    [train("18:42", "18:48")],
    standardSecond,
    standardThird,
    "moriguchishi",
    0,
  );
  assert.equal(route.id, "moriguchishi-1122-1154");
  assert.equal(route.originLabel, "守口市");
  assert.equal(route.destinationLabel, "新深江");
  assert.deepEqual(
    [route.first.from, route.first.to, route.second.from, route.second.to, route.third.from, route.third.to],
    ["守口市", "関目", "関目成育", "今里", "今里", "新深江"],
  );
  assert.equal(route.totalMinutes, 32);
});

test("乗車中状態を各発車境界で切り替える", () => {
  const [route] = buildRouteCandidates(
    [train("18:42", "18:48")],
    standardSecond,
    standardThird,
    "nishisanso",
    0,
  );

  assert.equal(getRideStatus(route, 1121).status, "before-departure");
  assert.equal(getRideStatus(route, 1122).status, "to-sekime-seiiku");
  assert.equal(getRideStatus(route, 1134).status, "to-imazato");
  assert.equal(getRideStatus(route, 1150).status, "to-shinfukae");
  assert.equal(getRideStatus(route, 1154).status, "arrived");
});

test("到着後5分ちょうどまでは保持し、それを超えると期限切れにする", () => {
  const [route] = buildRouteCandidates(
    [train("18:42", "18:48")],
    standardSecond,
    standardThird,
    "nishisanso",
    0,
  );

  assert.equal(getRideStatus(route, 1159).keepRide, true);
  assert.equal(getRideStatus(route, 1160).status, "expired");
  assert.equal(getRideStatus(route, 1160).keepRide, false);
});
