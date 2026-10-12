#!/usr/bin/env python3
"""Create the four weekday CSVs from published train times, with arrival checks."""

import argparse
import csv
import hashlib
import json
import re
import subprocess
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import urlencode

import pymupdf

METRO_ROOT = "https://kensaku.osakametro.co.jp"
KEIHAN_URL = "https://www.keihan.co.jp/traffic/time-fare/pdf/time01-2.pdf"
METRO_ROUTES = (
    ("sekime", "29583/1027/1", "関目成育", "今里(地下鉄)", "今里筋線", "metro_sekime_seiiku_to_imazato_weekday.csv"),
    ("imazato", "25840/1023/1", "今里(地下鉄)", "新深江", "千日前線", "metro_imazato_to_shinfukae_weekday.csv"),
)


def minutes(value):
    hour, minute = map(int, value.split(":"))
    if not 0 <= hour <= 24 or not 0 <= minute < 60:
        raise ValueError(f"Invalid time: {value}")
    return (hour + (24 if hour < 3 else 0)) * 60 + minute


def stamp(value):
    value = minutes(value)
    return f"{value // 60:02}:{value % 60:02}"


def validate(rows, name):
    if len(rows) < 60 or len({d for d, a in rows}) != len(rows):
        raise ValueError(f"Missing or duplicate trains: {name}")
    if any(not 0 < minutes(a) - minutes(d) < 40 for d, a in rows):
        raise ValueError(f"Invalid duration: {name}")
    return sorted(rows)


def keihan_rows(pdf_path, arrival_check):
    outputs = {
        "keihan_nishisanso_to_sekime_weekday.csv": [],
        "keihan_moriguchishi_to_sekime_weekday.csv": [],
    }
    kadoma = []
    with pymupdf.open(pdf_path) as pdf:
        title = pdf[0].get_text().splitlines()[0]
        if "平日" not in title or "下り" not in title:
            raise ValueError("Expected Keihan weekday timetable towards Yodoyabashi/Nakanoshima")
        for page in pdf:
            words = page.get_text("words")

            def station_y(name):
                matches = [w[1] for w in words if w[4].strip() == name]
                if len(matches) != 1:
                    raise ValueError(f"Cannot identify station row: {name}")
                return matches[0]

            def row(y):
                return [(w[0], stamp(w[4])) for w in words
                        if abs(w[1] - y) < .6 and re.fullmatch(r"\d{1,2}:\d{2}", w[4])]

            nishi_y = station_y("西三荘")
            mori_y = max(w[1] for w in words
                         if w[4] == "発" and nishi_y < w[1] < station_y("土居"))
            # The PDF supplies departure times at Sekime. Require independent
            # published arrival times to confirm that the minute values agree.
            arrivals = row(station_y("関目"))
            for name, y in (("keihan_nishisanso_to_sekime_weekday.csv", nishi_y),
                            ("keihan_moriguchishi_to_sekime_weekday.csv", mori_y),
                            ("kadoma", station_y("門真市"))):
                departures = row(y)
                for x, arrival in arrivals:
                    matches = [d for dx, d in departures if abs(x - dx) < 4]
                    if len(matches) != 1:
                        raise ValueError(f"Ambiguous train column: {name}, {arrival}")
                    target = kadoma if name == "kadoma" else outputs[name]
                    target.append((matches[0], arrival))
    with arrival_check.open(newline="", encoding="utf-8-sig") as source:
        reader = csv.DictReader(source)
        if reader.fieldnames != ["dep", "arr"]:
            raise ValueError("Arrival check must have the header dep,arr")
        check = [(stamp(r["dep"]), stamp(r["arr"])) for r in reader]
    if sorted(kadoma) != sorted(check):
        raise ValueError("Keihan PDF and arrival check differ; obtain an arrival check for the same weekday timetable")
    return outputs, title


def fetch(url, path, offline):
    if not path.exists():
        if offline:
            raise ValueError(f"Missing cached source: {path}")
        path.parent.mkdir(parents=True, exist_ok=True)
        subprocess.run(["curl", "-L", "--fail", "--silent", "--show-error", "--max-time", "30", url, "-o", str(path)], check=True)
    raw = path.read_bytes()
    return raw.decode("utf-8"), hashlib.sha256(raw).hexdigest()


def departures(html):
    table = re.search(r'<table class="text">(.*?)</table>', html, re.S)
    if not table or "平日" not in table[1]:
        raise ValueError("Cannot find weekday timetable")
    result = []
    for row in re.findall(r"<tr>(.*?)</tr>", table[1], re.S):
        hour = re.search(r'<th class="h_cell">(\d+)</th>', row)
        if hour:
            result.extend(f"{int(hour[1]):02}:{m}" for m in re.findall(r"<div>(\d{2})</div>", row))
    if not result or result != sorted(set(result)):
        raise ValueError("Invalid departure timetable")
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--service-date", type=date.fromisoformat, required=True, help="A non-holiday weekday, YYYY-MM-DD")
    parser.add_argument("--keihan-pdf", type=Path, required=True)
    parser.add_argument("--keihan-arrival-check", type=Path, required=True, help="Published Kadomashi -> Sekime weekday dep,arr CSV")
    parser.add_argument("--cache-dir", type=Path, required=True, help="Use a fresh directory for each collection date")
    parser.add_argument("--output-dir", type=Path, required=True)
    parser.add_argument("--offline", action="store_true", help="Only read previously downloaded sources")
    args = parser.parse_args()
    if args.service_date.weekday() >= 5:
        parser.error("Use a non-holiday weekday")
    outputs, title = keihan_rows(args.keihan_pdf, args.keihan_arrival_check)
    evidence = {
        "checked_on": date.today().isoformat(),
        "service_date": args.service_date.isoformat(),
        "keihan": {"url": KEIHAN_URL, "title": title,
                   "pdf_sha256": hashlib.sha256(args.keihan_pdf.read_bytes()).hexdigest(),
                   "arrival_check_sha256": hashlib.sha256(args.keihan_arrival_check.read_bytes()).hexdigest(),
                   "arrival_check_url": "https://www.navitime.co.jp/diagram/depArrTimeList?arrival=00001360&departure=00008698&line=00000285&updown=1",
                   "arrival_check_trains": len(outputs["keihan_nishisanso_to_sekime_weekday.csv"])},
        "metro": [],
    }
    for slug, station, origin, destination, line, filename in METRO_ROUTES:
        url = f"{METRO_ROOT}/timetable/ja/subway/dia/station/{station}/"
        html, sha = fetch(url, args.cache_dir / f"metro-{slug}.html", args.offline)
        expected = departures(html)
        version = re.search(r"\d{4}年\d{1,2}月\d{1,2}日現在", html)
        record = {"url": url, "timetable_date": version[0] if version else None,
                  "sha256": sha, "queries": []}
        rows = []
        for offset in range(0, len(expected), 4):
            hour, minute = map(int, expected[offset].split(":"))
            query_date = args.service_date + timedelta(days=hour // 24)
            params = dict(val_from=origin, val_to=destination,
                          val_yyyymm=query_date.strftime("%Y%m"), val_dd=query_date.strftime("%d"),
                          val_hh=hour % 24, val_mm=minute, exp_type="departure", search_target="subway")
            url = f"{METRO_ROOT}/route/ja/web/dia/result?{urlencode(params)}"
            html, sha = fetch(url, args.cache_dir / f"{slug}-{offset:03}.html", args.offline)
            # Reject cached results from another date/time, even when the first
            # few departure times happen to agree (e.g. holidays or old dates).
            for key in ("val_yyyymm", "val_dd", "val_hh", "val_mm"):
                select = re.search(rf'<select name="{key}"[^>]*>(.*?)</select>', html, re.S)
                selected = re.search(r'<option selected="selected" value="([^"]+)"', select[1]) if select else None
                if not selected or str(selected[1]) != str(params[key]):
                    raise ValueError(f"Cached query date/time differs: {slug}, {expected[offset]}, {key}")
            pairs = [(stamp(d), stamp(a)) for d, a in re.findall(
                r"<span>出発(\d{2}:\d{2})\s*到着(\d{2}:\d{2})</span>", html)]
            batch = pairs[:len(expected[offset:offset + 4])]
            if [d for d, a in batch] != expected[offset:offset + 4] or line not in html:
                raise ValueError(f"Route results differ from timetable: {slug}, {expected[offset]}")
            transfers = re.findall(r"乗り換え:\s*(\d+)回", html)
            if len(transfers) < len(batch) or any(int(n) != 0 for n in transfers[:len(batch)]):
                raise ValueError(f"Expected direct trains: {slug}, {expected[offset]}")
            rows.extend(batch)
            record["queries"].append({"url": url, "sha256": sha, "times": batch})
        outputs[filename] = rows
        evidence["metro"].append(record)
    # Validate every file before modifying any output.
    outputs = {name: validate(rows, name) for name, rows in outputs.items()}
    args.output_dir.mkdir(parents=True, exist_ok=True)
    for name, rows in outputs.items():
        with (args.output_dir / name).open("w", newline="", encoding="utf-8") as dest:
            writer = csv.writer(dest)
            writer.writerow(["dep", "arr"])
            writer.writerows(rows)
        print(f"{name}: {len(rows)} trains, {rows[0][0]} -> {rows[-1][1]}")
    (args.output_dir / "作成記録.json").write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


if __name__ == "__main__":
    main()
