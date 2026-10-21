import json
import asyncio
from io import BytesIO

import numpy as np
import torch
from PIL import Image, ImageOps

import comfy.model_management
import comfy.utils
from server import PromptServer

from .client import BridgeError, PlatformClient
from .config import load_config
from .schema import validate_params
from .media import image_batch_count, validate_reference_count, encode_reference_images, reference_input_names, collect_reference_inputs
from .runtime import RunClock


def image_tensor(image):
    image = ImageOps.exif_transpose(image)
    # ComfyUI IMAGE uses RGB; flatten alpha onto white for preview compatibility.
    if "A" in image.getbands():
        rgba = image.convert("RGBA")
        background = Image.new("RGBA", rgba.size, "white")
        image = Image.alpha_composite(background, rgba).convert("RGB")
    else:
        image = image.convert("RGB")
    return torch.from_numpy(np.asarray(image).astype(np.float32) / 255.0).unsqueeze(0)


class BenbhImageGenerate:
    CATEGORY = "Benbh Bridge"
    FUNCTION = "generate"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("图片",)
    OUTPUT_IS_LIST = (True,)
    # Collect IMAGE lists as references to ONE task instead of letting ComfyUI
    # auto-map each list item into a separate paid generation.
    INPUT_IS_LIST = True
    DESCRIPTION = "调用 BBH AIGC 平台生成图片。参考图片为可选输入，支持单张、图片批次及图片列表，统一作为一个任务的参考图；不接图片时文生图，接图时图生图。每次运行提交新任务，并持续查询直到平台返回结果。"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {
            "model_id": ("STRING", {"default": ""}),
            "prompt": ("STRING", {"multiline": True, "default": "一只坐在窗边晒太阳的猫，柔和的自然光"}),
            "params_json": ("STRING", {"default": "{}", "multiline": False}),
        }, "optional": {
            name: ("IMAGE", {"tooltip": "参考图片（可选），支持单张、图片批次及图片列表；所有输入口的图片都作为同一个任务的参考图片。"})
            for name in reference_input_names()
        },
            "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"}}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Remote generation must execute on every queued run, even with identical inputs.
        return float("nan")

    async def generate(self, model_id, prompt, params_json, unique_id=None, reference_images=None, extra_pnginfo=None, **reference_inputs):
        def single(value, label):
            if isinstance(value, list):
                if len(value) != 1:
                    raise BridgeError(f"{label}需要单个值；请先选择一项后再生成。")
                return value[0]
            return value

        progress = comfy.utils.ProgressBar(100)
        task_id = ""
        execution_quote = None
        reference_count = 0
        clock = None

        def report(current_task_id, message, percent=0, *, state="running"):
            nonlocal task_id
            if current_task_id:
                task_id = current_task_id
            try:
                progress.update_absolute(min(100, max(0, int(float(percent or 0)))), 100)
            except (TypeError, ValueError):
                pass
            server = getattr(PromptServer, "instance", None)
            detail = {"node_id": str(unique_id), "message": message}
            if execution_quote is not None:
                detail.update(quote=execution_quote, reference_count=reference_count,
                              model_id=str(model_id), params_json=params_json)
            if clock is not None:
                detail = clock.update(detail, state)
            if server is not None:
                server.send_sync("benbh-bridge-status", detail)

        try:
            unique_id = single(unique_id, "节点编号")
            model_id = single(model_id, "模型")
            prompt = single(prompt, "提示词")
            params_json = single(params_json, "模型参数")
            extra_pnginfo = single(extra_pnginfo, "工作流元数据")
            clock = RunClock("image", unique_id, extra_pnginfo)
            report("", "正在准备生成", 0)
            if not isinstance(prompt, str) or not prompt.strip():
                raise BridgeError("请填写提示词。")
            if len(prompt) > 5000:
                raise BridgeError("当前图片提交接口的提示词上限为 5000 字符。")
            try:
                raw = json.loads(params_json)
            except (ValueError, TypeError):
                raise BridgeError("参数数据损坏，请重新选择模型并核对参数。") from None
            client = PlatformClient(load_config())
            models = await client.models(require_key=True)
            model = next((m for m in models if str(m["id"]) == str(model_id)), None)
            if model is None:
                raise BridgeError("所选模型已不可用，请重新打开工作流并选择模型。")
            params = validate_params(model, raw)
            reference_images = collect_reference_inputs(reference_images, reference_inputs)
            reference_count = image_batch_count(reference_images)
            validate_reference_count(model, params, reference_count)
            payload = {"model_id": str(model_id), "prompt": prompt.strip(), "user_params": params["user_params"]}
            if params["tier_id"]:
                payload["tier_id"] = params["tier_id"]
            if reference_count:
                report("", f"正在准备 {reference_count} 张参考图片", 0)
                payload["images"] = encode_reference_images(reference_images, comfy.model_management.throw_exception_if_processing_interrupted)
                execution_quote = await client.quote(str(model_id), params, reference_count=reference_count)
                report("", f"已核算 {reference_count} 张参考图片的积分，准备提交", 0)
            task_id, urls = await client.generate(payload, on_progress=report, check_interrupt=comfy.model_management.throw_exception_if_processing_interrupted)
            images = []
            for url in urls:
                comfy.model_management.throw_exception_if_processing_interrupted()
                report(task_id, f"下载图片 {len(images)+1}/{len(urls)}", 95)
                try:
                    content = await client.download_image(url)
                    with Image.open(BytesIO(content)) as image:
                        images.append(image_tensor(image))
                except Exception as exc:
                    if isinstance(exc, comfy.model_management.InterruptProcessingException):
                        raise
                    raise BridgeError(f"图片下载或解码失败。任务 ID：{task_id}，请到平台任务记录查看或下载结果。") from None
            report(task_id, f"完成，获得 {len(images)} 张图片", 100, state="completed")
            return (images,)
        except (BridgeError, ValueError) as exc:
            message = str(exc)
            if task_id and task_id not in message:
                message += f"。任务 ID：{task_id}"
            report(task_id, message, state="failed")
            raise RuntimeError("Benbh Bridge：" + message) from None
        except BaseException as exc:
            stopped = isinstance(exc, (asyncio.CancelledError, comfy.model_management.InterruptProcessingException))
            report(task_id, "已停止等待" if stopped else "执行出错", state="interrupted" if stopped else "failed")
            raise
