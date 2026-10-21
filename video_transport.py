"""Stream generated videos to ComfyUI temporary files without decoding all frames."""
import asyncio
from pathlib import Path
from urllib.parse import urlparse
from uuid import uuid4

import aiohttp

from .client import BridgeError


MAX_VIDEO_BYTES = 1024 * 1024 * 1024


async def download_video(client, url, directory, check_interrupt=lambda: None):
    parsed = urlparse(url)
    if parsed.scheme not in {"http", "https"}:
        raise BridgeError("平台返回了不支持的视频地址。")
    directory = Path(directory)
    directory.mkdir(parents=True, exist_ok=True)
    extension = Path(parsed.path).suffix.lower()
    if extension not in {".mp4", ".webm", ".mov", ".mkv"}:
        extension = ".mp4"
    target = directory / (uuid4().hex + extension)
    partial = target.with_suffix(target.suffix + ".part")
    # A large video may take longer than one request timeout in total; bound
    # connection/inactivity instead. No API key is sent to the result host.
    timeout = aiohttp.ClientTimeout(total=None, sock_connect=client.config.request_timeout_seconds,
                                   sock_read=client.config.request_timeout_seconds)
    try:
        check_interrupt()
        async with aiohttp.ClientSession(timeout=timeout, trust_env=True) as session:
            async with session.get(url) as response:
                if response.status != 200:
                    raise BridgeError(f"视频下载失败（HTTP {response.status}），请到平台任务记录下载结果。")
                if response.content_length is not None and response.content_length > MAX_VIDEO_BYTES:
                    raise BridgeError("视频超过 1 GB，请到平台任务记录下载结果。")
                size = 0
                with partial.open("xb") as output:
                    async for chunk in response.content.iter_chunked(65536):
                        check_interrupt()
                        size += len(chunk)
                        if size > MAX_VIDEO_BYTES:
                            raise BridgeError("视频超过 1 GB，请到平台任务记录下载结果。")
                        output.write(chunk)
                check_interrupt()
                if not size:
                    raise BridgeError("平台返回了空的视频文件，请到平台任务记录查看结果。")
        partial.replace(target)
        return str(target)
    except (aiohttp.ClientError, asyncio.TimeoutError):
        raise BridgeError("视频下载超时或连接失败，请到平台任务记录下载结果。") from None
    except OSError:
        raise BridgeError("无法写入视频临时文件，请检查 ComfyUI 临时目录权限和磁盘空间。") from None
    finally:
        partial.unlink(missing_ok=True)
