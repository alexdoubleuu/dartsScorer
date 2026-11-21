"""Compare a saved browser debug case with the original PyTorch and ONNX models.

Run from the repository root with the existing ML environment:
  .ml-lab\\.venv\\Scripts\\python.exe tools\\analyze_debug_case.py path\\to\\dart-debug-case.json

The source image is extracted into a temporary directory and removed on exit.
The report is printed to stdout; this script does not write photos or reports
into the repository.
"""

from __future__ import annotations

import argparse
import base64
import json
import math
import mimetypes
import tempfile
from pathlib import Path
from typing import Any

from ultralytics import YOLO

ROOT = Path(__file__).resolve().parents[1]
WEIGHTS = ROOT / ".ml-lab" / "weights.pt"
ONNX_CANDIDATES = [
    ROOT / "public" / "models" / "dart-detector.onnx",
    ROOT / ".ml-lab" / "model.onnx",
]
DART_CLASS = 4


def read_case(path: Path) -> tuple[dict[str, Any], bytes, str]:
    case = json.loads(path.read_text(encoding="utf-8"))
    if case.get("schema") != "darts-scorer-debug-case/v1":
        raise ValueError("Unsupported debug case schema.")
    source = case.get("sourceImage", {})
    data_url = source.get("dataUrl", "")
    header, separator, payload = data_url.partition(",")
    if not separator or not header.startswith("data:") or ";base64" not in header:
        raise ValueError("The debug case does not contain an embedded base64 photo.")
    mime_type = header[5:].split(";", 1)[0] or source.get("mimeType", "image/jpeg")
    return case, base64.b64decode(payload), mime_type


def predict(model_path: Path, image_path: Path, imgsz: int, confidence: float, iou: float):
    model = YOLO(str(model_path), task="detect")
    result = model.predict(
        source=str(image_path),
        imgsz=imgsz,
        conf=confidence,
        iou=iou,
        rect=False,
        max_det=30000,
        device="cpu",
        verbose=False,
    )[0]
    rows = []
    for box in result.boxes:
        if int(box.cls.item()) != DART_CLASS:
            continue
        cx, cy, width, height = (float(value) for value in box.xywh[0].tolist())
        rows.append(
            {
                "confidence": float(box.conf.item()),
                "point": {"x": cx, "y": cy},
                "box": {
                    "left": cx - width / 2,
                    "top": cy - height / 2,
                    "right": cx + width / 2,
                    "bottom": cy + height / 2,
                },
            }
        )
    return rows


def print_rows(title: str, rows: list[dict[str, Any]]) -> None:
    print(f"\n{title}: {len(rows)}")
    for index, row in enumerate(rows, start=1):
        point = row["point"]
        print(
            f"  #{index} conf={row['confidence']:.4f} "
            f"centre=({point['x']:.2f}, {point['y']:.2f}) "
            f"box=({row['box']['left']:.2f}, {row['box']['top']:.2f}, "
            f"{row['box']['right']:.2f}, {row['box']['bottom']:.2f})"
        )


def compare_points(
    title: str,
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    radius: float,
) -> None:
    pairs = []
    for left_index, left_row in enumerate(left):
        for right_index, right_row in enumerate(right):
            dx = left_row["point"]["x"] - right_row["point"]["x"]
            dy = left_row["point"]["y"] - right_row["point"]["y"]
            pairs.append((math.hypot(dx, dy), left_index, right_index))
    pairs.sort()

    used_left: set[int] = set()
    used_right: set[int] = set()
    matches = []
    for distance, left_index, right_index in pairs:
        if left_index in used_left or right_index in used_right:
            continue
        used_left.add(left_index)
        used_right.add(right_index)
        matches.append((distance, left_index, right_index))

    print(f"\n{title} (nearest one-to-one; review radius {radius:.1f}px):")
    if not matches:
        print("  no candidate pairs")
    for distance, left_index, right_index in matches:
        state = "MATCH" if distance <= radius else "FAR"
        print(
            f"  {state}: #{left_index + 1} <-> #{right_index + 1}, "
            f"{distance:.2f}px"
        )
    print(
        f"  unmatched: left={len(left) - len(used_left)}, "
        f"right={len(right) - len(used_right)}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("debug_case", type=Path)
    parser.add_argument("--match-radius", type=float, default=12.0)
    args = parser.parse_args()

    case, image_bytes, mime_type = read_case(args.debug_case)
    detector = case.get("detector", {})
    trace = detector.get("trace") or {}
    settings = detector.get("settings") or trace
    imgsz = int(settings.get("inputSize", 800))
    low_conf = float(settings.get("debugThreshold", 0.01))
    production_conf = float(settings.get("productionConfidenceThreshold", 0.25))
    iou = float(settings.get("iouThreshold", 0.7))
    extension = mimetypes.guess_extension(mime_type) or ".img"

    print(f"Case: {args.debug_case}")
    print(f"Image: {case['imageSize']['width']}x{case['imageSize']['height']} ({mime_type})")
    print(f"Detector: {detector['id']} / {detector['name']}")
    print(
        f"Model settings: imgsz={imgsz}, debug_conf={low_conf}, "
        f"production_conf={production_conf}, iou={iou}, rect=False"
    )
    timing = case.get("diagnostics", {})
    print(
        "Phone/browser timings (ms): "
        f"load={timing.get('modelLoadMs', 'n/a')}, "
        f"preprocess={timing.get('preprocessingMs', 'n/a')}, "
        f"session.run={timing.get('inferenceMs', 'n/a')}, "
        f"decode={timing.get('postprocessingMs', 'n/a')}, "
        f"Detect-to-render={timing.get('totalMs', 'n/a')}"
    )
    print("Calibration references:")
    for point in case["calibration"]["refPoints"]:
        xy = point["point"]
        print(
            f"  {point['order']}. {point['id']} ({point['label']}): "
            f"({xy['x']:.2f}, {xy['y']:.2f})"
        )

    onnx_path = next((path for path in ONNX_CANDIDATES if path.exists()), None)
    if not WEIGHTS.exists():
        raise FileNotFoundError(f"Original PyTorch weights not found: {WEIGHTS}")
    if onnx_path is None:
        raise FileNotFoundError("Bundled ONNX model was not found.")

    with tempfile.TemporaryDirectory(prefix="dart-debug-case-") as temp_dir:
        image_path = Path(temp_dir) / f"source{extension}"
        image_path.write_bytes(image_bytes)

        pt_debug = predict(WEIGHTS, image_path, imgsz, low_conf, iou)
        onnx_debug = predict(onnx_path, image_path, imgsz, low_conf, iou)
        onnx_production = predict(onnx_path, image_path, imgsz, production_conf, iou)

    browser_trace = [
        {
            "confidence": candidate["confidence"],
            "point": candidate["point"],
            "box": candidate["boxSource"],
            "disposition": candidate["disposition"],
            "anchor": candidate["anchor"],
            "suppressedByAnchor": candidate.get("suppressedByAnchor"),
        }
        for candidate in trace.get("candidates", [])
    ]
    browser_retained = [
        {
            "confidence": candidate["confidence"],
            "point": candidate["point"],
            "box": None,
        }
        for candidate in case.get("predictions", {}).get("retained", [])
    ]

    print_rows("Original PyTorch, low threshold (Ultralytics NMS applied)", pt_debug)
    print_rows("ONNX, low threshold (Ultralytics NMS applied)", onnx_debug)
    print_rows("ONNX, production confidence threshold", onnx_production)
    print(f"\nBrowser pre-filter class-4 trace: {len(browser_trace)}")
    for index, candidate in enumerate(browser_trace, start=1):
        point, box = candidate["point"], candidate["box"]
        print(
            f"  #{index} anchor={candidate['anchor']} "
            f"conf={candidate['confidence']:.4f} "
            f"status={candidate['disposition']} "
            f"centre=({point['x']:.2f}, {point['y']:.2f}) "
            f"box=({box['left']:.2f}, {box['top']:.2f}, "
            f"{box['right']:.2f}, {box['bottom']:.2f})"
            + (
                f" suppressed_by={candidate['suppressedByAnchor']}"
                if candidate["suppressedByAnchor"] is not None
                else ""
            )
        )

    compare_points("PyTorch vs ONNX at low threshold", pt_debug, onnx_debug, args.match_radius)
    compare_points(
        "Browser retained vs Python ONNX production",
        browser_retained,
        onnx_production,
        args.match_radius,
    )

    print("\nApp-side scored markers:")
    for marker in case.get("predictions", {}).get("scoredMarkers", []):
        point, score = marker["point"], marker["score"]
        label = score["label"] if score else "unscorable"
        points = score["points"] if score else "n/a"
        print(
            f"  {marker['id']} [{marker.get('origin', 'unknown')}]: "
            f"({point['x']:.2f}, {point['y']:.2f}) "
            f"{label}={points} corrected={marker['corrected']}"
        )
    print(
        "\nParity between runtimes is an implementation comparison, not a "
        "ground-truth accuracy measurement."
    )


if __name__ == "__main__":
    main()
