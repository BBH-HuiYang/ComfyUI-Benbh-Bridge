"""Reference-image validation and lossless ComfyUI IMAGE transport."""
import base64
from io import BytesIO

import numpy as np
import torch
from PIL import Image

from .schema import default_value, effective_fields, get_tier, same

# Matches the platform's UploadHelper.DEFAULT_MAX_SIZE for base64 images.
MAX_IMAGE_BYTES = 10 * 1024 * 1024
# Declared IMAGE slots keep ComfyUI's normal link/type validation. The browser
# exposes only the first slot initially; each slot still accepts IMAGE batches.
MAX_REFERENCE_INPUTS = 64


def reference_input_names():
    return ["reference_images", *(f"reference_images_{index}" for index in range(2, MAX_REFERENCE_INPUTS + 1))]


def collect_reference_inputs(reference_images, additional):
    unknown = set(additional) - set(reference_input_names()[1:])
    if unknown:
        raise ValueError("存在无法识别的参考图片输入，请重新创建节点。")
    batches = []
    for name in reference_input_names():
        value = reference_images if name == "reference_images" else additional.get(name)
        if value is None:
            continue
        image_batch_count(value)  # Invalid/empty connected inputs must not disappear.
        batches.extend(value if isinstance(value, (list, tuple)) else [value])
    return batches or None


def supports_task(model, task_type):
    definitions = model.get("task_type_defs")
    if not definitions:
        return task_type == "txt2img"  # Legacy catalogs only guaranteed text generation.
    return task_type in definitions


def reference_limit(model, params):
    definition = (model.get("task_type_defs") or {}).get("img2img") or {}
    constraint = (definition.get("input_media_constraints") or {}).get("image") or {}

    def count(value, minimum=1):
        return value if isinstance(value, int) and not isinstance(value, bool) and value >= minimum else None

    limit = count(constraint.get("max_count"))
    if limit is None:
        limit = count(definition.get("max_images"), 0)
    limits = [] if limit is None else [limit]
    _, tier = get_tier(model, params.get("tier_id"))
    fields = {field["key"]: field for field in effective_fields(model, tier) if field.get("key")}
    for rule in constraint.get("conditional_max_count_rules") or []:
        if not isinstance(rule, dict) or rule.get("param_key") not in fields or "param_value" not in rule:
            continue
        value = params.get("user_params", {}).get(rule["param_key"], default_value(fields[rule["param_key"]]))
        values = value if isinstance(value, list) else [value]
        maximum = count(rule.get("max_count"))
        if maximum is not None and any(same(item, rule["param_value"]) for item in values):
            limits.append(maximum)
    return min(limits) if limits else None


def validate_reference_count(model, params, count):
    task_type = "img2img" if count else "txt2img"
    if not supports_task(model, task_type):
        raise ValueError("当前模型不支持参考图片，请断开图片输入或选择其他模型。" if count else "当前模型需要参考图片，请连接图片输入。")
    if count:
        limit = reference_limit(model, params)
        if limit is not None and count > limit:
            raise ValueError(f"当前参数最多支持 {limit} 张参考图片，实际收到 {count} 张；请减少图片或调整参数。")


def image_batch_count(images):
    if images is None:
        return 0
    if isinstance(images, (list, tuple)):
        if not images or any(not isinstance(batch, torch.Tensor) for batch in images):
            raise ValueError("参考图片列表必须包含非空的 ComfyUI IMAGE 图片或图片批次。")
        return sum(image_batch_count(batch) for batch in images)
    if (not isinstance(images, torch.Tensor) or images.ndim != 4 or
            images.shape[-1] not in (3, 4) or any(size <= 0 for size in images.shape)):
        raise ValueError("参考图片必须是非空的 ComfyUI IMAGE 图片或图片批次。")
    return int(images.shape[0])


def encode_reference_images(images, check_interrupt=lambda: None):
    image_batch_count(images)
    result = []
    batches = images if isinstance(images, (list, tuple)) else ([] if images is None else [images])
    for image in (image for batch in batches for image in batch):
        check_interrupt()
        index = len(result)
        pixels = image.detach().to(device="cpu", dtype=torch.float32).numpy()
        if not np.isfinite(pixels).all():
            raise ValueError(f"第 {index + 1} 张参考图片包含无效像素。")
        pixels = np.rint(np.clip(pixels, 0, 1) * 255).astype(np.uint8)
        content = BytesIO()
        Image.fromarray(pixels).save(content, format="PNG")
        encoded = base64.b64encode(content.getvalue()).decode("ascii")
        if len(encoded) * 3 // 4 > MAX_IMAGE_BYTES:
            raise ValueError(f"第 {index + 1} 张参考图片编码后超过平台的 10 MB 限制，请先缩小图片。")
        result.append({"type": "base64", "data": "data:image/png;base64," + encoded})
    check_interrupt()
    return result
