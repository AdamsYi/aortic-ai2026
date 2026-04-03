#!/usr/bin/env python3
"""
convert_measurements_format.py
将 pipeline 输出的嵌套格式 measurements.json 转换为前端期望的 ScalarMeasurement 信封格式。

Pipeline 输出格式（嵌套）:
{
  "annulus": { "equivalent_diameter_mm": 24.36, ... },
  "stj": { "diameter_mm": 24.86, ... },
  ...
}

前端期望格式（扁平 + 信封）:
{
  "annulus_equivalent_diameter_mm": { "value": 24.36, "unit": "mm", "evidence": {...}, "uncertainty": {...} },
  "stj_diameter_mm": { "value": 24.86, "unit": "mm", "evidence": {...}, "uncertainty": {...} },
  ...
}

用法:
  python3 scripts/convert_measurements_format.py [input_path] [output_path]
  
  默认:
    input_path  = cases/default_clinical_case/artifacts/measurements.json
    output_path = cases/default_clinical_case/artifacts/measurements.json (原地覆盖)
"""

import json
import sys
from pathlib import Path


def infer_unit(key: str) -> str:
    """从字段名推断单位"""
    if key.endswith("_mm2"):
        return "mm²"
    if key.endswith("_mm"):
        return "mm"
    if key.endswith("_ml"):
        return "mL"
    if key.endswith("_hu"):
        return "HU"
    return ""


def make_envelope(value, key: str, method: str = "pipeline_v3", confidence: float = 0.85) -> dict:
    """将裸值包装为 ScalarMeasurement 信封"""
    flag = "NONE" if value is not None else "NOT_AVAILABLE"
    review = value is None
    return {
        "value": value,
        "unit": infer_unit(key),
        "evidence": {
            "method": method,
            "confidence": confidence if value is not None else 0.0,
        },
        "uncertainty": {
            "flag": flag,
            "clinician_review_required": review,
        },
    }


# 映射表: 前端期望的 key → (pipeline 嵌套路径, 方法描述)
FIELD_MAP = [
    ("annulus_equivalent_diameter_mm", ["annulus", "equivalent_diameter_mm"], "double_oblique_annulus"),
    ("annulus_short_diameter_mm", ["annulus", "diameter_short_mm"], "double_oblique_annulus"),
    ("annulus_long_diameter_mm", ["annulus", "diameter_long_mm"], "double_oblique_annulus"),
    ("annulus_area_mm2", ["annulus", "area_mm2"], "double_oblique_annulus"),
    ("annulus_perimeter_mm", ["annulus", "perimeter_mm"], "double_oblique_annulus"),
    ("sinus_diameter_mm", ["sinus_of_valsalva", "max_diameter_mm"], "mask_cross_section"),
    ("stj_diameter_mm", ["stj", "diameter_mm"], "mask_cross_section"),
    ("ascending_aorta_diameter_mm", ["ascending_aorta", "diameter_mm"], "mask_cross_section"),
    ("lvot_diameter_mm", ["lvot", "diameter_mm"], "annulus_proxy"),
    ("coronary_height_left_mm", ["coronary_heights_mm", "left"], "ostia_detection"),
    ("coronary_height_right_mm", ["coronary_heights_mm", "right"], "ostia_detection"),
    ("calcium_burden_ml", ["calcium_burden", "calc_volume_ml"], "hu_threshold_proxy"),
    ("leaflet_effective_height_mm", ["leaflet_geometry", "effective_height_mean_mm"], "parametric_leaflet"),
    ("leaflet_coaptation_height_mm", ["leaflet_geometry", "coaptation_height_mm"], "parametric_leaflet"),
    ("leaflet_geometric_height_mm", ["leaflet_geometry", "geometric_height_mean_mm"], "parametric_leaflet"),
]


def extract_nested(data: dict, path: list[str]):
    """从嵌套字典中按路径提取值"""
    current = data
    for key in path:
        if not isinstance(current, dict):
            return None
        current = current.get(key)
    return current


def convert(pipeline_data: dict) -> dict:
    """将 pipeline 嵌套格式转换为前端信封格式"""
    result = {}
    for frontend_key, nested_path, method in FIELD_MAP:
        value = extract_nested(pipeline_data, nested_path)
        # 确保数值是有限的
        if isinstance(value, float) and (value != value or value == float("inf") or value == float("-inf")):
            value = None
        result[frontend_key] = make_envelope(value, frontend_key, method=method)

    # 保留原始 pipeline 数据作为 _raw 字段，方便调试
    result["_pipeline_raw"] = pipeline_data
    result["_conversion_meta"] = {
        "converter": "convert_measurements_format.py",
        "source_format": "pipeline_nested_v3",
        "target_format": "scalar_measurement_envelope",
    }
    return result


def is_already_envelope_format(data: dict) -> bool:
    """检查数据是否已经是信封格式"""
    test_keys = ["annulus_equivalent_diameter_mm", "stj_diameter_mm", "sinus_diameter_mm"]
    for key in test_keys:
        if key in data:
            val = data[key]
            if isinstance(val, dict) and "value" in val and "unit" in val:
                return True
    return False


def is_pipeline_nested_format(data: dict) -> bool:
    """检查数据是否是 pipeline 嵌套格式"""
    return "annulus" in data and isinstance(data.get("annulus"), dict) and "equivalent_diameter_mm" in data.get("annulus", {})


def main():
    repo_root = Path(__file__).resolve().parent.parent
    default_path = repo_root / "cases" / "default_clinical_case" / "artifacts" / "measurements.json"

    input_path = Path(sys.argv[1]) if len(sys.argv) > 1 else default_path
    output_path = Path(sys.argv[2]) if len(sys.argv) > 2 else input_path

    if not input_path.exists():
        print(f"❌ 文件不存在: {input_path}")
        sys.exit(1)

    with open(input_path, "r", encoding="utf-8") as f:
        data = json.load(f)

    if is_already_envelope_format(data):
        print(f"✅ 文件已经是信封格式，无需转换: {input_path}")
        return

    if not is_pipeline_nested_format(data):
        print(f"⚠️ 无法识别的格式，跳过: {input_path}")
        sys.exit(1)

    converted = convert(data)

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(converted, f, indent=2, ensure_ascii=False)

    print(f"✅ 转换完成: {output_path}")
    print(f"   转换了 {len(FIELD_MAP)} 个字段")
    # 打印关键值
    for key in ["annulus_equivalent_diameter_mm", "stj_diameter_mm", "sinus_diameter_mm"]:
        val = converted.get(key, {}).get("value")
        print(f"   {key}: {val}")


if __name__ == "__main__":
    main()
