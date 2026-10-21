"""Async platform client. Task submission is deliberately never retried."""
import asyncio
import math
from decimal import Decimal, InvalidOperation
from urllib.parse import quote, urlparse

import aiohttp


class BridgeError(RuntimeError):
    def __init__(self, message, *, retryable=False):
        super().__init__(message)
        self.retryable = retryable


class PlatformClient:
    def __init__(self, config):
        self.config = config

    async def request(self, method, path, body=None, *, authenticated=True):
        if authenticated and not self.config.api_key:
            raise BridgeError("尚未配置 API Key。请编辑插件目录的 config.json，或设置 BENBH_API_KEY 环境变量，然后重新打开工作流。")
        headers = {"X-API-Key": self.config.api_key} if authenticated else {}
        timeout = aiohttp.ClientTimeout(total=self.config.request_timeout_seconds)
        try:
            async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as session:
                async with session.request(method, self.config.base_url + path, json=body, headers=headers, allow_redirects=False) as response:
                    try:
                        data = await response.json(content_type=None)
                    except (ValueError, UnicodeError):
                        raise BridgeError(f"平台返回非 JSON 响应（HTTP {response.status}）。", retryable=response.status not in {400, 401, 403, 404}) from None
                    if response.status >= 300 or not isinstance(data, dict) or data.get("code", 200) != 200:
                        message = (data.get("message") or data.get("msg") or data.get("detail")) if isinstance(data, dict) else None
                        message = message if isinstance(message, str) else "请检查平台地址、密钥、余额和参数。"
                        if self.config.api_key:
                            message = message.replace(self.config.api_key, "[已隐藏]")
                        retryable = response.status >= 500 or response.status in {408, 429} or (isinstance(data, dict) and data.get("code") in {429, 500, 502, 503, 504})
                        raise BridgeError(f"平台请求失败（HTTP {response.status}）：{message[:400]}", retryable=retryable)
                    return data
        except (aiohttp.ClientError, asyncio.TimeoutError):
            message = "网络超时或连接中断。"
            if method == "POST" and path in {"/api/v5/image/submit", "/api/v5/video/submit"}:
                message += "提交结果不确定，请先到平台任务记录确认，避免重复提交扣费。"
            raise BridgeError(message, retryable=True) from None

    async def models(self, *, require_key=False, task_family="image"):
        if task_family not in {"image", "video"}:
            raise BridgeError("不支持的模型分类。")
        authenticated = require_key or bool(self.config.api_key)
        path = ("/api/v5/models" if authenticated else "/api/v5/catalog/models") + "?task_type=" + task_family
        response = await self.request("GET", path, authenticated=authenticated)
        items = response.get("data")
        if not isinstance(items, list):
            raise BridgeError("平台模型列表格式不正确。")
        tasks = {"txt2img", "img2img"} if task_family == "image" else {"txt2vid", "img2vid"}
        return [m for m in items if isinstance(m, dict) and m.get("id") is not None
                and ((not m.get("task_type_defs") and task_family == "image") or tasks.intersection(m.get("task_type_defs") or {}))]

    async def points(self):
        response = await self.request("GET", "/api/v5/user/points")
        data = response.get("data")
        try:
            amounts = {key: Decimal(str(data[key])) for key in ("total_points", "points", "gift_points")}
            if not all(value.is_finite() and math.isfinite(float(value)) for value in amounts.values()):
                raise ValueError()
        except (KeyError, TypeError, ValueError, InvalidOperation, OverflowError):
            raise BridgeError("平台积分数据不完整或格式异常，请稍后重新查询。") from None
        # Return only balances: account identity and credentials never enter the workflow UI.
        return {key: str(value) for key, value in amounts.items()}

    async def upload_media(self, path, content_type, check_interrupt=lambda: None):
        if not self.config.api_key:
            raise BridgeError("尚未配置 API Key。")
        timeout = aiohttp.ClientTimeout(total=None, sock_connect=self.config.request_timeout_seconds,
                                        sock_read=self.config.request_timeout_seconds)
        async def upload():
            with open(path, "rb") as source:
                body = aiohttp.FormData()
                body.add_field("file", source, filename=path.name, content_type=content_type)
                async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as session:
                    async with session.post(self.config.base_url + "/api/v3/temp/file/upload", data=body,
                                            headers={"X-API-Key": self.config.api_key}, allow_redirects=False) as response:
                        try:
                            result = await response.json(content_type=None)
                        except (ValueError, UnicodeError):
                            raise BridgeError(f"素材上传返回格式异常（HTTP {response.status}）。") from None
                        if response.status >= 300 or not isinstance(result, dict) or result.get("code", 200) != 200:
                            message = (result.get("message") or result.get("detail") or "请检查平台临时上传接口是否已支持视频、音频。") if isinstance(result, dict) else "请检查平台临时上传接口。"
                            message = str(message).replace(self.config.api_key, "[已隐藏]")
                            raise BridgeError(f"参考素材上传失败（HTTP {response.status}）：{message[:400]}")
                        data = result.get("data")
                        url = data.get("url") if isinstance(data, dict) else None
                        parsed = urlparse(url) if isinstance(url, str) else None
                        if parsed is None or parsed.scheme not in {"http", "https"} or not parsed.hostname:
                            raise BridgeError("素材上传响应缺少有效 URL，已停止提交任务。")
                        return url
        check_interrupt()
        pending = asyncio.create_task(upload())
        try:
            while not pending.done():
                await asyncio.wait({pending}, timeout=0.25)
                check_interrupt()
            return await pending
        except (aiohttp.ClientError, asyncio.TimeoutError, OSError):
            raise BridgeError("参考素材上传超时或连接中断，尚未提交生成任务。") from None
        finally:
            if not pending.done():
                pending.cancel()
            await asyncio.gather(pending, return_exceptions=True)

    async def quote(self, model_id, params, *, reference_count=0, video_reference_count=0, audio_reference_count=0, task_family="image"):
        if task_family not in {"image", "video"}:
            raise BridgeError("不支持的模型分类。")
        if not isinstance(model_id, str) or not model_id.strip():
            raise BridgeError("请先选择模型。")
        if not isinstance(params, dict) or not isinstance(params.get("user_params", {}), dict):
            raise BridgeError("报价参数必须是对象。")
        for count in (reference_count, video_reference_count, audio_reference_count):
            if type(count) is not int or not 0 <= count <= 4096:
                raise BridgeError("参考素材数量必须为 0 到 4096 的整数。")
        if task_family == "image" and (video_reference_count or audio_reference_count):
            raise BridgeError("图片节点不支持参考视频或音频。")
        user_params = dict(params.get("user_params", {}))
        if reference_count:
            # Quote only counts these entries; it never fetches or uploads media.
            # These placeholders are never passed to the generation endpoint.
            user_params["input_image_urls"] = [f"https://quote.invalid/reference-{index}.png" for index in range(reference_count)]
        for kind, count, extension in (("video", video_reference_count, "mp4"), ("audio", audio_reference_count, "wav")):
            if count:
                user_params[f"input_{kind}_urls"] = [f"https://quote.invalid/reference-{index}.{extension}" for index in range(count)]
        tasks = ("txt2img", "img2img") if task_family == "image" else ("txt2vid", "img2vid")
        payload = {"model_id": model_id.strip(), "task_type": tasks[bool(reference_count or video_reference_count or audio_reference_count)], "user_params": user_params}
        if params.get("tier_id"):
            payload["tier_id"] = str(params["tier_id"])
        response = await self.request("POST", "/api/v5/price/quote", payload)
        data = response.get("data")
        try:
            amounts = {key: Decimal(str(data[key])) for key in ("original_points", "payable_points", "discount_rate")}
            if not all(value.is_finite() and value >= 0 for value in amounts.values()):
                raise ValueError()
            if not 0 < amounts["discount_rate"] <= 1:
                raise ValueError()
        except (KeyError, TypeError, ValueError, InvalidOperation):
            raise BridgeError("平台报价数据不完整，暂时无法计算预计积分。") from None
        return {key: str(value) for key, value in amounts.items()}

    async def generate(self, payload, *, resume_task_id="", on_progress=None, check_interrupt=None, task_family="image"):
        if task_family not in {"image", "video"}:
            raise BridgeError("不支持的模型分类。")
        label = "图片" if task_family == "image" else "视频"
        def check():
            if check_interrupt:
                check_interrupt()

        async def wait(delay):
            # Request timeouts only recover the connection; there is no task
            # deadline. Keep local cancellation responsive between requests.
            while delay > 0:
                check()
                step = min(delay, 0.25)
                await asyncio.sleep(step)
                delay -= step

        check()
        task_id = resume_task_id.strip()
        if not task_id:
            submitted = await self.request("POST", f"/api/v5/{task_family}/submit", payload)
            task_id = str((submitted.get("data") or {}).get("task_id") or "")
            if not task_id:
                raise BridgeError("平台已返回提交响应，但缺少 task_id。请到平台任务记录确认后再操作。")
        if on_progress:
            on_progress(task_id, "已提交，等待平台处理", 0)
        errors = 0
        while True:
            check()
            try:
                response = await self.request("GET", "/api/v5/task/status/" + quote(task_id, safe=""))
            except BridgeError as exc:
                if not exc.retryable:
                    raise BridgeError(f"状态查询无法继续：{exc} 这不代表平台任务失败。任务 ID：{task_id}。请到平台任务记录查看结果。") from None
                errors += 1
                if on_progress:
                    on_progress(task_id, f"状态查询暂时不可用，正在重试；平台任务未判失败（第 {errors} 次）", 0)
                await wait(min(30, self.config.poll_interval_seconds * 2 ** min(errors, 4)))
                continue
            errors = 0
            data = response.get("data") or {}
            if not isinstance(data, dict):
                if on_progress:
                    on_progress(task_id, "暂时无法读取任务状态，继续查询", 0)
                await wait(self.config.poll_interval_seconds)
                continue
            state = str(data.get("status") or "").lower()
            if on_progress:
                on_progress(task_id, {"pending": "排队中", "queued": "排队中", "dequeued": "正在提交到模型服务", "processing": "生成中", "completed": "生成完成"}.get(state, state or "等待状态"), data.get("progress", 0))
            if state in {"completed", "succeeded", "success"}:
                results = data.get("results") or []
                urls = [r["url"] for r in results if isinstance(r, dict) and r.get("url") and r.get("output_type", task_family) == task_family]
                if not urls and data.get("result_url") and (task_family == "image" or not results):
                    urls = [data["result_url"]]
                if not urls:
                    raise BridgeError(f"任务完成但没有{label}结果。任务 ID：{task_id}")
                return task_id, urls
            if state in {"failed", "error", "cancelled", "canceled", "timeout"}:
                message = str(data.get("error_message") or data.get("message") or state)
                if self.config.api_key:
                    message = message.replace(self.config.api_key, "[已隐藏]")
                raise BridgeError(f"{label}生成失败：{message[:400]}。任务 ID：{task_id}")
            await wait(self.config.poll_interval_seconds)

    async def download_image(self, url):
        if urlparse(url).scheme not in {"http", "https"}:
            raise BridgeError("平台返回了不支持的图片地址。")
        try:
            # Result hosts never receive the platform API key.
            async with aiohttp.ClientSession(timeout=aiohttp.ClientTimeout(total=self.config.request_timeout_seconds), trust_env=True) as session:
                async with session.get(url) as response:
                    if response.status != 200:
                        raise BridgeError(f"图片下载失败（HTTP {response.status}）。请到平台任务记录查看或下载结果。")
                    content = bytearray()
                    async for chunk in response.content.iter_chunked(65536):
                        content.extend(chunk)
                        if len(content) > 100 * 1024 * 1024:
                            raise BridgeError("单张图片超过 100 MB，请在平台下载原图。")
                    return bytes(content)
        except (aiohttp.ClientError, asyncio.TimeoutError):
            raise BridgeError("图片下载超时或连接失败，请到平台任务记录查看或下载结果。") from None
