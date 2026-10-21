import json
import asyncio
import tempfile
from pathlib import Path

import comfy.model_management
import comfy.utils
import folder_paths
from server import PromptServer

from .client import BridgeError, PlatformClient
from .config import load_config
from .media import collect_reference_inputs, encode_reference_images, image_batch_count, reference_input_names
from .schema import validate_params
from .video_media import validate_video_references, validate_media_metadata
from .reference_av import av_input_names, collect_av_inputs, prepare_av_references
from .video_transport import download_video
from .runtime import RunClock


class BenbhVideoGenerate:
    CATEGORY = "Benbh Bridge"
    FUNCTION = "generate"
    RETURN_TYPES = ("VIDEO",)
    RETURN_NAMES = ("视频",)
    OUTPUT_IS_LIST = (True,)
    INPUT_IS_LIST = True
    OUTPUT_NODE = False
    DESCRIPTION = "调用 BBH AIGC 平台生成视频。按模型能力接入参考图片、原生 VIDEO 视频及 AUDIO 音频，动态显示参数和输入口。输出可连接保存视频节点；每次运行提交新任务。"

    @classmethod
    def INPUT_TYPES(cls):
        optional = {name: ("IMAGE", {"tooltip": "参考图片；所有输入口的素材合并为同一个视频任务。"}) for name in reference_input_names()}
        for kind, type_name in (("video", "VIDEO"), ("audio", "AUDIO")):
            optional.update({name: (type_name,) for name in av_input_names(kind)})
        return {"required": {
            "model_id": ("STRING", {"default": ""}),
            "prompt": ("STRING", {"multiline": True, "default": "镜头缓缓推进，微风吹过树梢，柔和的自然光，流畅的电影画面"}),
            "params_json": ("STRING", {"default": "{}", "multiline": False}),
        }, "optional": optional,
            "hidden": {"unique_id": "UNIQUE_ID", "extra_pnginfo": "EXTRA_PNGINFO"}}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
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
        downloaded = []
        reference_temp = None
        reference_counts = {"image": 0, "video": 0, "audio": 0}
        clock = None
        check = comfy.model_management.throw_exception_if_processing_interrupted

        def report(current_task_id, message, percent=0, *, state="running"):
            nonlocal task_id
            task_id = current_task_id or task_id
            try:
                progress.update_absolute(min(100, max(0, int(float(percent or 0)))), 100)
            except (TypeError, ValueError):
                pass
            server = getattr(PromptServer, "instance", None)
            detail = {"node_id": str(unique_id), "message": message}
            if execution_quote is not None:
                detail.update(quote=execution_quote, reference_count=reference_count,
                              reference_counts=reference_counts, model_id=str(model_id), params_json=params_json)
            if clock is not None:
                detail = clock.update(detail, state)
            if server is not None:
                server.send_sync("benbh-bridge-video-status", detail)

        try:
            unique_id = single(unique_id, "节点编号")
            model_id = single(model_id, "模型")
            prompt = single(prompt, "提示词")
            params_json = single(params_json, "模型参数")
            extra_pnginfo = single(extra_pnginfo, "工作流元数据")
            clock = RunClock("video", unique_id, extra_pnginfo)
            report("", "正在准备生成", 0)
            # Check native VIDEO support before any paid request.
            try:
                from comfy_api.latest import InputImpl
                video_type = InputImpl.VideoFromFile
            except (ImportError, AttributeError):
                raise BridgeError("当前 ComfyUI 不支持原生 VIDEO，请更新 ComfyUI 后再生成视频。") from None
            if not isinstance(prompt, str) or not prompt.strip():
                raise BridgeError("请填写提示词。")
            if len(prompt) > 5000:
                raise BridgeError("当前视频提交接口的提示词上限为 5000 字符。")
            try:
                raw = json.loads(params_json)
            except (ValueError, TypeError):
                raise BridgeError("参数数据损坏，请重新选择模型并核对参数。") from None
            client = PlatformClient(load_config())
            models = await client.models(require_key=True, task_family="video")
            model = next((m for m in models if str(m["id"]) == str(model_id)), None)
            if model is None:
                raise BridgeError("所选视频模型已不可用，请重新打开工作流并选择模型。")
            params = validate_params(model, raw, custom_dimensions=False)
            allowed = set(reference_input_names()[1:] + av_input_names("video") + av_input_names("audio"))
            if set(reference_inputs) - allowed:
                raise BridgeError("存在无法识别的参考素材输入，请重新创建节点。")
            reference_images = collect_reference_inputs(reference_images, {key: value for key,value in reference_inputs.items() if key in reference_input_names()[1:]})
            reference_count = image_batch_count(reference_images)
            video_refs = collect_av_inputs(reference_inputs, "video")
            audio_refs = collect_av_inputs(reference_inputs, "audio")
            reference_counts = {"image": reference_count, "video": len(video_refs), "audio": len(audio_refs)}
            validate_video_references(model, params, reference_count, len(video_refs), len(audio_refs))
            definition = model["task_type_defs"]["img2vid" if any(reference_counts.values()) else "txt2vid"]
            prompt_limit = definition.get("max_prompt_length")
            if isinstance(prompt_limit, int) and prompt_limit > 0 and len(prompt) > prompt_limit:
                raise BridgeError(f"当前模型的提示词上限为 {prompt_limit} 字符。")
            payload = {"model_id": str(model_id), "prompt": prompt.strip(), "user_params": params["user_params"]}
            if params["tier_id"]:
                payload["tier_id"] = params["tier_id"]
            if reference_count:
                report("", f"正在准备 {reference_count} 张参考图片", 0)
                payload["images"] = encode_reference_images(reference_images, check)
            reference_temp = tempfile.TemporaryDirectory(prefix="bbh-reference-", dir=folder_paths.get_temp_directory())
            prepared = {}
            for kind, values in (("video", video_refs), ("audio", audio_refs)):
                if values:
                    report("", f"正在准备参考{'视频' if kind == 'video' else '音频'}", 0)
                prepared[kind] = prepare_av_references(values, kind, reference_temp.name, check)
                validate_media_metadata(model, params, kind, prepared[kind])
            check()
            execution_quote = await client.quote(str(model_id), params, reference_count=reference_count, video_reference_count=len(video_refs), audio_reference_count=len(audio_refs), task_family="video")
            for kind, items in prepared.items():
                urls = []
                for index, item in enumerate(items):
                    report("", f"上传参考{'视频' if kind == 'video' else '音频'} {index + 1}/{len(items)}", 0)
                    urls.append(await client.upload_media(item["path"], item["content_type"], check))
                if urls:
                    payload["user_params"][f"input_{kind}_urls"] = urls
            check()
            report("", "已核算积分，准备提交视频任务", 0)
            task_id, urls = await client.generate(payload, task_family="video", on_progress=report, check_interrupt=check)
            videos = []
            for url in urls:
                check()
                report(task_id, f"下载视频 {len(videos) + 1}/{len(urls)}", 95)
                path = await download_video(client, url, Path(folder_paths.get_temp_directory()) / "bbh-bridge", check)
                downloaded.append(path)
                video = video_type(path)
                try:
                    width, height = video.get_dimensions()
                    if width <= 0 or height <= 0:
                        raise ValueError()
                except Exception:
                    raise BridgeError("下载结果不是有效视频，请到平台任务记录查看结果。") from None
                videos.append(video)
            report(task_id, f"完成，获得 {len(videos)} 个视频", 100, state="completed")
            return (videos,)
        except (BridgeError, ValueError) as exc:
            for path in downloaded:
                Path(path).unlink(missing_ok=True)
            message = str(exc)
            if task_id and task_id not in message:
                message += f"。任务 ID：{task_id}"
            report(task_id, message, state="failed")
            raise RuntimeError("Benbh Bridge：" + message) from None
        except BaseException as exc:
            for path in downloaded:
                Path(path).unlink(missing_ok=True)
            stopped = isinstance(exc, (asyncio.CancelledError, comfy.model_management.InterruptProcessingException))
            report(task_id, "已停止等待" if stopped else "执行出错", state="interrupted" if stopped else "failed")
            raise
        finally:
            if reference_temp is not None:
                reference_temp.cleanup()
