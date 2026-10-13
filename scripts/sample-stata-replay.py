#!/usr/bin/env python3
"""Build the homepage's Stata sidecars from a real AMCL run.

Source (read-only clone, path given as argv[1]): `results/stata/` in
thrmnn/ros2-localization-triage — a PR2 robot in the MIT Stata Center
(public dataset, CC BY 3.0), replayed through AMCL by the repo author, with
the tool's fault-detector events. Nothing here is hand-typed: every count in
the sidecar is computed from the three input files below.

Outputs (stdlib only):
    public/data/stata-replay.meta.json — lost-window numbers for the headline.
    public/data/stata-baseline.json    — the demo's sigma-vs-detectors table
                                          (results/stata/baseline.json, copied
                                          byte for byte; the demo recomputes it).
    public/data/stata-series.json      — per matched pose: time, position error
                                          against the AprilTag truth, reported
                                          sigma. Matched by the demo's own
                                          scripts/stata_baseline.py (needs numpy).
"""
from __future__ import annotations

import csv
import json
import struct
import sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
OUT_META = ROOT / "public" / "data" / "stata-replay.meta.json"
OUT_BASELINE = ROOT / "public" / "data" / "stata-baseline.json"
OUT_SERIES = ROOT / "public" / "data" / "stata-series.json"

# Same convention as the walls' int8 (value/127 -> [-1, 1]): poses use int16
# so the trail renders at much finer resolution than the wall dots.
POSE_SCALE = 32767


def read_walls(path: Path) -> list[tuple[float, float]]:
    pts = []
    with path.open() as f:
        for row in csv.reader(f):
            if not row or row[0].startswith("#"):
                continue
            pts.append((float(row[0]), float(row[1])))
    return pts


def read_poses(path: Path) -> list[dict]:
    poses = []
    with path.open() as f:
        for row in csv.reader(f):
            if not row or row[0].startswith("#"):
                continue
            ts_us, x, y, yaw, pos_sigma, yaw_sigma = row
            poses.append(
                {
                    "t_us": int(ts_us),
                    "x": float(x),
                    "y": float(y),
                    "yaw": float(yaw),
                    "sigma_m": float(pos_sigma),
                }
            )
    return poses


def read_events(path: Path) -> list[dict]:
    return json.loads(path.read_text())


def read_lost_window(path: Path) -> dict:
    gt = json.loads(path.read_text())
    zones = gt["detections_by_zone"]
    for w in gt["windows"]:
        if w["window"] == "part3_after_floor_change":
            return {
                "window": w["window"],
                "position_error_median_m": w["position_error_median_m"],
                "amcl_reported_sigma_median_m": w["amcl_reported_sigma_median_m"],
                "events": sum(zones["part3_lost"].values()),
            }
    sys.exit("✗ part3_after_floor_change window not found in gt_comparison.json")


def read_excursion(path: Path) -> dict:
    zones = json.loads(path.read_text())["detections_by_zone"]
    return {"events": sum(zones["excursion_no_gt"].values())}


def read_zone_bounds(grade_script: Path) -> tuple[int, tuple[float, float, float]]:
    """BAG_T0_US and GT_ZONES_S as the demo's grader defines them (parsed, not imported:
    the grader pulls numpy)."""
    import re
    src = grade_script.read_text()
    t0 = int(re.search(r"BAG_T0_US\s*=\s*([\d_]+)", src).group(1).replace("_", ""))
    z = re.search(r"GT_ZONES_S\s*=\s*\(([^)]+)\)", src).group(1)
    a, b, c = (float(v) for v in z.split(","))
    return t0, (a, b, c)


def main() -> int:
    if len(sys.argv) < 2:
        sys.exit("usage: sample-stata-replay.py <path to ros2-localization-triage clone>")
    clone = Path(sys.argv[1])
    stata_dir = clone / "results" / "stata"

    walls = read_walls(stata_dir / "walls.csv")
    poses = read_poses(stata_dir / "amcl_poses.csv")
    events_raw = read_events(stata_dir / "detections.json")
    lost_window = read_lost_window(stata_dir / "gt_comparison.json")

    if not walls or not poses:
        sys.exit("✗ empty walls or poses — check the clone path")

    # One shared affine frame: center + isotropic scale over walls ∪ poses,
    # so both datasets land in the same normalized [-1, 1] scene.
    all_x = [p[0] for p in walls] + [p["x"] for p in poses]
    all_y = [p[1] for p in walls] + [p["y"] for p in poses]
    cx = (max(all_x) + min(all_x)) / 2
    cy = (max(all_y) + min(all_y)) / 2
    scale = max(max(all_x) - min(all_x), max(all_y) - min(all_y)) / 2 or 1.0

    # --- walls.bin: existing int8/int8/uint8/uint8 format, cat=0 (static dim points) ---
    blob = bytearray()
    for x, y in walls:
        nx = (x - cx) / scale
        ny = (y - cy) / scale
        qx = max(-128, min(127, round(nx * 127)))
        qy = max(-128, min(127, round(ny * 127)))
        blob += struct.pack("bbBB", qx, qy, 0, 0)
    OUT_META.parent.mkdir(parents=True, exist_ok=True)

    # --- replay.json: poses (trail) + events (detector fires), same frame ---
    poses.sort(key=lambda p: p["t_us"])
    t0_us = poses[0]["t_us"]
    t_max_s = (poses[-1]["t_us"] - t0_us) / 1e6
    # Zone bounds are on the bag clock; the replay clock starts at the first pose.
    bag_t0_us, gt_zones = read_zone_bounds(clone / "scripts" / "stata_grade.py")
    shift_s = (t0_us - bag_t0_us) / 1e6
    zones_s = {
        "healthy_end_s": round(gt_zones[0] - shift_s, 1),
        "lost_start_s": round(gt_zones[1] - shift_s, 1),
        "lost_end_s": round(gt_zones[2] - shift_s, 1),
    }

    pose_rows = []
    for p in poses:
        t_ds = round((p["t_us"] - t0_us) / 1e6 * 10)
        nx = (p["x"] - cx) / scale
        ny = (p["y"] - cy) / scale
        qx = max(-32768, min(32767, round(nx * POSE_SCALE)))
        qy = max(-32768, min(32767, round(ny * POSE_SCALE)))
        sigma_cm = round(p["sigma_m"] * 100)
        pose_rows.append([t_ds, qx, qy, sigma_cm])

    detector_names = sorted({e["detector"] for e in events_raw})
    detector_index = {name: i for i, name in enumerate(detector_names)}
    event_rows = []
    for e in events_raw:
        t_mid_s = (e["start_s"] + e["end_s"]) / 2
        t_ds = round(t_mid_s * 10)
        event_rows.append([t_ds, detector_index[e["detector"]]])
    event_rows.sort(key=lambda r: r[0])

    replay = {
        "t_max_s": round(t_max_s, 3),
        "poses": pose_rows,
        "events": event_rows,
        "detectors": detector_names,
        "frame": {"center": [cx, cy], "scale": scale},
    }


    events_by_detector = {}
    for e in events_raw:
        events_by_detector[e["detector"]] = events_by_detector.get(e["detector"], 0) + 1

    meta = {
        "platform": "PR2",
        "dataset": "MIT Stata Center dataset",
        "license": "CC BY 3.0",
        "duration_s": round(t_max_s),
        "poses": len(poses),
        "wall_points": len(walls),
        "events": len(events_raw),
        "events_by_detector": events_by_detector,
        "lost_window": lost_window,
        "excursion": read_excursion(stata_dir / "gt_comparison.json"),
        "zones_s": zones_s,
        "source": "https://github.com/thrmnn/ros2-localization-triage/tree/main/results/stata",
    }
    OUT_META.write_text(json.dumps(meta, indent=2))
    OUT_BASELINE.write_bytes((stata_dir / "baseline.json").read_bytes())

    sys.path.insert(0, str(clone / "scripts"))
    import stata_baseline  # the demo's matcher, so the chart cannot drift from its numbers

    series = {
        "zones_s": zones_s,
        "poses": [[round(t, 2), round(e, 3), round(sig, 3)] for t, e, sig in stata_baseline.matched().tolist()],
    }
    OUT_SERIES.write_text(json.dumps(series, separators=(",", ":")))

    print(
        f"✓ {OUT_META.name} — {OUT_META.stat().st_size} bytes, "
        f"{len(poses)} poses, {len(event_rows)} events, {t_max_s:.1f}s span\n"
        f"✓ {OUT_BASELINE.name} — {OUT_BASELINE.stat().st_size} bytes\n"
        f"✓ {OUT_SERIES.name} — {OUT_SERIES.stat().st_size} bytes, {len(series['poses'])} matched poses"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
