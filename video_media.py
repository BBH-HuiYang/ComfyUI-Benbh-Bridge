"""Video reference capabilities and pre-submit limits from the platform catalog."""
import math
from .media import reference_limit
from .schema import default_value, effective_fields, get_tier, same

MEDIA_LABELS = {"image": "参考图片", "video": "参考视频", "audio": "参考音频"}


def image_contract(model):
    definitions = model.get("task_type_defs") or {}
    translated = {target: definitions[source] for source, target in (("txt2vid", "txt2img"), ("img2vid", "img2img")) if source in definitions}
    return {**model, "task_type_defs": translated or {"unsupported": {}}}


def media_constraint(model, kind):
    return (((model.get("task_type_defs") or {}).get("img2vid") or {}).get("input_media_constraints") or {}).get(kind) or {}


def video_reference_limit(model, params, kind="image"):
    definition = (model.get("task_type_defs") or {}).get("img2vid")
    if definition is None:
        return 0
    declared = definition.get("input_media_types")
    if declared and kind not in declared:
        return 0
    if not declared and kind != "image" and kind not in (definition.get("input_media_constraints") or {}):
        return 0
    if kind == "image":
        return reference_limit(image_contract(model), params)
    constraint = media_constraint(model, kind)
    maximum = constraint.get("max_count")
    limits = [maximum if type(maximum) is int and maximum >= 0 else 1]
    _, tier = get_tier(model, params.get("tier_id"))
    fields = {field["key"]: field for field in effective_fields(model, tier) if field.get("key")}
    for rule in constraint.get("conditional_max_count_rules") or []:
        field = fields.get(rule.get("param_key"))
        if field is None or "param_value" not in rule:
            continue
        value = params.get("user_params", {}).get(field["key"], default_value(field))
        maximum = rule.get("max_count")
        if type(maximum) is int and maximum > 0 and any(same(item, rule["param_value"]) for item in (value if isinstance(value, list) else [value])):
            limits.append(maximum)
    return min(limits)


def validate_video_references(model, params, count, video_count=0, audio_count=0):
    counts = {"image": count, "video": video_count, "audio": audio_count}
    definitions = model.get("task_type_defs") or {}
    has_references = any(counts.values())
    if ("img2vid" if has_references else "txt2vid") not in definitions:
        raise ValueError("当前模型不支持参考图片、视频或音频，请断开参考输入或选择其他模型。" if has_references else "当前模型需要参考图片、视频或音频，请连接参考输入。")
    for kind, amount in counts.items():
        limit = video_reference_limit(model, params, kind)
        if amount and limit == 0:
            raise ValueError(f"当前模型或参数不支持{MEDIA_LABELS[kind]}，请断开该输入或调整模型参数。")
        if limit is not None and amount > limit:
            unit = "张" if kind == "image" else "个"
            raise ValueError(f"当前参数最多支持 {limit} {unit}{MEDIA_LABELS[kind]}，实际收到 {amount} {unit}；请减少素材或调整参数。")


def validate_media_metadata(model, params, kind, items):
    constraint = media_constraint(model, kind)
    label = MEDIA_LABELS[kind]
    for key, actual, title in (("max_total_duration_seconds", sum(item["duration"] for item in items), "总时长"),
                                ("max_total_size_bytes", sum(item["size"] for item in items), "总大小")):
        limit = constraint.get(key)
        if isinstance(limit, (int, float)) and math.isfinite(limit) and limit > 0 and actual > limit + (0.001 if key.endswith("seconds") else 0):
            value = f"{limit:g} 秒" if key.endswith("seconds") else f"{limit / 1024 / 1024:g} MB"
            raise ValueError(f"{label}{title}超过当前模型限制（最多 {value}）。")
    if items and constraint.get("aspect_ratio_check"):
        value = params["user_params"].get(constraint.get("aspect_ratio_param_key"))
        try:
            width, height = str(value).replace("x", ":").split(":")
            expected = float(width) / float(height)
            if not math.isfinite(expected) or expected <= 0:
                raise ValueError()
            tolerance = float(constraint.get("aspect_ratio_tolerance") or 0)
        except (ValueError, ZeroDivisionError, TypeError):
            raise ValueError(f"无法校验{label}比例，请先选择有效的画面比例。") from None
        for item in items:
            if not item.get("width") or not item.get("height") or abs(item["width"] / item["height"] - expected) / expected > tolerance + 1e-6:
                raise ValueError(f"{label}画面比例与当前参数不符，请调整素材或画面比例。")
