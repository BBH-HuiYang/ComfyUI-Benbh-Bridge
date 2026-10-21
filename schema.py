"""Validate against the current server catalog, never a workflow's saved schema."""
import copy
import math
import re


def same(a, b):
    return type(a) is type(b) and a == b


def option_value(option):
    return option.get("value") if isinstance(option, dict) else option


def numeric_range(field):
    configured = (field.get("metadata") or {}).get("range") or {}
    return {key: configured.get(key) if configured.get(key) is not None else field.get(key, 1 if key == "step" else None)
            for key in ("min", "max", "step")}


def default_value(field):
    if "default" in field:
        return copy.deepcopy(field["default"])
    if "default_value" in field:
        return copy.deepcopy(field["default_value"])
    options = field.get("options") or []
    if options:
        return copy.deepcopy(option_value(next((x for x in options if isinstance(x, dict) and x.get("is_default")), options[0])))
    if field.get("ui_type") == "toggle":
        return False
    if field.get("ui_type") in {"number", "slider"}:
        return numeric_range(field)["min"] or 0
    return None


def get_tier(model, tier_id):
    tiers = model.get("tiers") or []
    chosen = str(tier_id or model.get("default_tier_id") or next((x.get("tier_id") for x in tiers if x.get("is_default")), "") or (tiers[0].get("tier_id") if tiers else ""))
    tier = next((x for x in tiers if str(x.get("tier_id")) == chosen), None)
    if tiers and tier is None:
        raise ValueError("所选档位已不可用，请刷新模型并重新选择。")
    return chosen, tier or {}


def effective_fields(model, tier):
    rules = tier.get("option_exclusions") or tier.get("optionExclusions") or (tier.get("metadata") or {}).get("option_exclusions") or []
    fields = copy.deepcopy((model.get("param_schema") or {}).get("params") or [])
    for field in fields:
        if field.get("ui_type") in {"number", "slider"} or field.get("type") in {"integer", "number", "float", "int"}:
            field.update(numeric_range(field))
        if field.get("options"):
            field["options"] = [x for x in field["options"] if not any(
                r.get("target_key") == field.get("key") and any(same(option_value(x), v) for v in r.get("target_values", [])) for r in rules)]
            field["_restricted"] = True
    return fields


def normalize_custom_size(supplied, fields, tier):
    """Validate literal dimensions and derive the same billable precision as V5."""
    if not tier.get("allow_custom_size"):
        raise ValueError("当前档位不支持自定义尺寸。")
    match = re.fullmatch(r"\s*(\d+)\s*[xX×*]\s*(\d+)\s*", str(supplied["size"]))
    if not match:
        raise ValueError("请填写有效的自定义宽高。")
    width, height = map(int, match.groups())
    rules = tier.get("custom_size_rules") or {}
    step = rules.get("dimension_step") or 1
    pixels = width * height
    if not width or not height or width % step or height % step:
        raise ValueError(f"自定义尺寸的宽高必须为 {step} 的正整数倍。")
    if max(width, height) > (rules.get("max_edge") or 32768) or not (rules.get("min_pixels") or 1) <= pixels <= (rules.get("max_pixels") or 1073741824):
        raise ValueError("自定义尺寸超出当前档位的边长或像素范围。")
    if not (rules.get("min_aspect_ratio") or 0) <= width / height <= (rules.get("max_aspect_ratio") or float("inf")):
        raise ValueError("自定义尺寸的宽高比超出当前档位范围。")
    supplied["size"] = f"{width}x{height}"
    supplied.pop("aspect_ratio", None)
    precision = next((f for f in fields if f.get("key") == "image_size"), None)
    if precision is not None:
        tiers = sorted(rules.get("image_size_tiers") or [], key=lambda t: t["max_pixels"])
        matched = next((t for t in tiers if pixels <= t["max_pixels"]), tiers[-1] if tiers else None)
        target = str(matched.get("value", "") if matched else "").strip().upper()
        option = next((o for o in precision.get("options") or [] if target and (
            str(option_value(o)).strip().upper() == target or
            isinstance(o, dict) and str(o.get("label", "")).strip().upper() == target)), None)
        if option is None:
            raise ValueError("自定义尺寸对应的渲染精度在当前线路不可用，请调整尺寸或切换线路。")
        supplied["image_size"] = option_value(option)


def validate_params(model, raw, *, custom_dimensions=True):
    if not isinstance(raw, dict):
        raise ValueError("生成参数必须是对象。")
    tier_id, tier = get_tier(model, raw.get("tier_id"))
    supplied = raw.get("user_params", {})
    if not isinstance(supplied, dict):
        raise ValueError("user_params 必须是对象。")
    fields = effective_fields(model, tier)
    allowed = {x["key"] for x in fields if x.get("key") and x["key"] != "prompt"}
    unknown = set(supplied) - allowed
    if unknown:
        raise ValueError("模型参数已变化，请刷新并核对参数：" + ", ".join(sorted(unknown)))
    supplied = copy.deepcopy(supplied)
    if custom_dimensions and supplied.get("size"):
        normalize_custom_size(supplied, fields, tier)
    result = {}
    for field in fields:
        key = field.get("key")
        if not key or key == "prompt":
            continue
        if custom_dimensions and key == "aspect_ratio" and supplied.get("size"):
            continue
        locked = field.get("fixed") or field.get("visible") is False or field.get("disabled")
        value = default_value(field) if locked else supplied.get(key, default_value(field))
        if value is None or value == "":
            if field.get("required"):
                raise ValueError(f"请填写 {field.get('label', key)}。")
            continue
        label = field.get("label", key)
        options = field.get("options") or []
        if options or field.get("_restricted"):
            picked = value if field.get("ui_type") in {"multi-select", "multiselect", "checkbox-group", "checkbox_group"} and isinstance(value, list) else [value]
            if not all(any(same(v, option_value(o)) for o in options) for v in picked):
                raise ValueError(f"{label} 的值已不可用，请刷新模型并重新选择。")
        elif field.get("ui_type") in {"number", "slider"} or field.get("type") in {"integer", "number", "float", "int"}:
            if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
                raise ValueError(f"{label} 必须是有限数字。")
            minimum, maximum, step = field.get("min"), field.get("max"), field.get("step", 1)
            if not isinstance(step, (int, float)) or isinstance(step, bool) or not math.isfinite(step) or step <= 0:
                raise ValueError(f"{label} 的步长配置无效。")
            if field.get("type") in {"integer", "int"} or (step == 1 and int(minimum or 0) == (minimum or 0)):
                if int(value) != value:
                    raise ValueError(f"{label} 必须是整数。")
            if (field.get("min") is not None and value < field["min"]) or (field.get("max") is not None and value > field["max"]):
                raise ValueError(f"{label} 超出允许范围。")
            steps = (value - (minimum or 0)) / step
            if not math.isclose(steps, round(steps), rel_tol=0, abs_tol=1e-9):
                raise ValueError(f"{label} 必须符合步长 {step}。")
        elif field.get("ui_type") == "toggle" or field.get("type") == "boolean":
            if not isinstance(value, bool):
                raise ValueError(f"{label} 必须是开关值。")
        elif not options and not isinstance(value, (str, list, dict)):
            raise ValueError(f"{label} 的类型不正确。")
        result[key] = value
    for field in fields:
        selected = result.get(field.get("key"))
        picked = selected if isinstance(selected, list) else [selected]
        for option in field.get("options") or []:
            if not isinstance(option, dict) or not any(same(v, option_value(option)) for v in picked):
                continue
            for rule in option.get("mutually_exclusive") or []:
                target = result.get(rule.get("target_key"))
                targets = target if isinstance(target, list) else [target]
                if any(same(v, blocked) for v in targets for blocked in rule.get("target_values") or []):
                    raise ValueError(f"{field.get('label', field['key'])} 与 {rule.get('target_key')} 的选项互斥。")
    return {"tier_id": tier_id, "user_params": result}
