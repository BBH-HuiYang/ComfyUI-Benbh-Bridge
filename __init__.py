"""Benbh Bridge: native ComfyUI nodes backed by the Benbh platform."""
from aiohttp import web
from server import PromptServer

from .client import BridgeError, PlatformClient
from .config import load_config
from .nodes_image import BenbhImageGenerate
from .nodes_video import BenbhVideoGenerate
from .nodes_points import BenbhPointsQuery
from .runtime import runtime_snapshot

WEB_DIRECTORY = "./web"
NODE_CLASS_MAPPINGS = {"BenbhImageGenerate": BenbhImageGenerate, "BenbhVideoGenerate": BenbhVideoGenerate, "BenbhPointsQuery": BenbhPointsQuery}
NODE_DISPLAY_NAME_MAPPINGS = {"BenbhImageGenerate": "BBH AIGC 图片生成", "BenbhVideoGenerate": "BBH AIGC 视频生成", "BenbhPointsQuery": "BBH AIGC 查询积分"}


@PromptServer.instance.routes.get("/benbh-bridge/runtime")
async def bridge_runtime(request):
    family = request.query.get("task_family", "image")
    if family not in {"image", "video"}:
        return web.json_response({"error": "不支持的任务分类。"}, status=400, headers={"Cache-Control": "no-store"})
    status = runtime_snapshot(family, request.query.get("workflow_id", ""), request.query.get("node_id", ""), request.query.get("node_key", ""))
    return web.json_response({"status": status}, headers={"Cache-Control": "no-store"})


@PromptServer.instance.routes.get("/benbh-bridge/models")
async def bridge_models(request):
    return await model_response("image")


@PromptServer.instance.routes.get("/benbh-bridge/video/models")
async def bridge_video_models(request):
    return await model_response("video")


async def model_response(task_family):
    try:
        config = load_config()
        models = await PlatformClient(config).models(task_family=task_family)
        return web.json_response({"models": models, "authenticated": bool(config.api_key),
                                  "message": "已连接平台。" if config.api_key else "正在查看公开模型；生成前请在插件 config.json 中配置 API Key。"},
                                 headers={"Cache-Control": "no-store"})
    except (BridgeError, ValueError) as exc:
        return web.json_response({"error": str(exc)}, status=400, headers={"Cache-Control": "no-store"})


@PromptServer.instance.routes.post("/benbh-bridge/quote")
async def bridge_quote(request):
    return await quote_response(request, "image")


@PromptServer.instance.routes.post("/benbh-bridge/video/quote")
async def bridge_video_quote(request):
    return await quote_response(request, "video")


async def quote_response(request, task_family):
    try:
        body = await request.json()
        if not isinstance(body, dict):
            raise ValueError("报价请求必须是对象。")
        quote = await PlatformClient(load_config()).quote(body.get("model_id"), body.get("params"), reference_count=body.get("reference_count", 0),
                                                        video_reference_count=body.get("video_reference_count", 0), audio_reference_count=body.get("audio_reference_count", 0), task_family=task_family)
        return web.json_response({"quote": quote}, headers={"Cache-Control": "no-store"})
    except (BridgeError, ValueError) as exc:
        return web.json_response({"error": str(exc)}, status=400, headers={"Cache-Control": "no-store"})
