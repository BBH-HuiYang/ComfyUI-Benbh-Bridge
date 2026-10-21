"""Serialize native ComfyUI VIDEO/AUDIO references to temporary upload files."""
import io
import math
from pathlib import Path
import av
import torch

from .media import MAX_REFERENCE_INPUTS

MAX_REFERENCE_BYTES = 1024 * 1024 * 1024


def av_input_names(kind):
    base = "reference_videos" if kind == "video" else "reference_audios"
    return [base, *(f"{base}_{i}" for i in range(2, MAX_REFERENCE_INPUTS + 1))]


def collect_av_inputs(inputs, kind):
    result = []
    for name in av_input_names(kind):
        if name not in inputs:
            continue
        values = inputs[name]
        values = values if isinstance(values, (list, tuple)) else [values]
        if not values or any(value is None for value in values):
            raise ValueError("已连接的参考素材为空，请检查上游节点。")
        for value in values:
            if kind == "video":
                if not callable(getattr(value, "get_stream_source", None)):
                    raise ValueError("参考视频必须使用 ComfyUI 原生 VIDEO，请连接加载视频节点。")
                result.append(value)
                continue
            waveform = value.get("waveform") if isinstance(value, dict) else None
            rate = value.get("sample_rate") if isinstance(value, dict) else None
            if not isinstance(waveform, torch.Tensor) or waveform.ndim != 3 or any(n <= 0 for n in waveform.shape) or type(rate) is not int or rate <= 0:
                raise ValueError("参考音频必须是非空的 ComfyUI AUDIO，包含 waveform 和 sample_rate。")
            if waveform.shape[1] not in (1, 2):
                raise ValueError("参考音频仅支持单声道或双声道，请先在上游转换声道。")
            for batch in waveform:
                result.append({"waveform": batch, "sample_rate": rate})
    return result


def prepare_av_references(values, kind, directory, check=lambda: None):
    items = []
    for index, value in enumerate(values):
        check()
        path = Path(directory) / f"reference-{kind}-{index}.{'wav' if kind == 'audio' else 'mp4'}"
        if kind == "audio":
            samples = value["waveform"].detach().to(device="cpu", dtype=torch.float32).contiguous()
            if not bool(torch.isfinite(samples).all()):
                raise ValueError("参考音频包含无效采样值。")
            if samples.numel() * 4 + 4096 > MAX_REFERENCE_BYTES:
                raise ValueError("单个参考音频超过 1 GB，无法上传。")
            with av.open(str(path), mode="w", format="wav") as container:
                stream = container.add_stream("pcm_f32le", rate=value["sample_rate"])
                stream.layout = "mono" if samples.shape[0] == 1 else "stereo"
                for offset in range(0, samples.shape[1], 65536):
                    check()
                    frame = av.AudioFrame.from_ndarray(samples[:, offset:offset + 65536].numpy().copy(), format="fltp", layout=stream.layout.name)
                    frame.sample_rate = value["sample_rate"]
                    for packet in stream.encode(frame):
                        container.mux(packet)
                for packet in stream.encode():
                    container.mux(packet)
            items.append({"path": path, "size": path.stat().st_size, "duration": samples.shape[1] / value["sample_rate"], "content_type": "audio/wav"})
            continue
        source = value.get_stream_source()
        if isinstance(source, io.BytesIO):
            if source.getbuffer().nbytes > MAX_REFERENCE_BYTES:
                raise ValueError("单个参考视频超过 1 GB，无法上传。")
            position = source.tell()
            try:
                source.seek(0)
                with path.open("wb") as target:
                    while chunk := source.read(1024 * 1024):
                        check()
                        target.write(chunk)
            finally:
                source.seek(position)
        elif isinstance(source, (str, Path)) and Path(source).is_file():
            path = Path(source)
        else:
            raise ValueError("参考视频必须提供本地文件或内存视频流。")
        if not 0 < path.stat().st_size <= MAX_REFERENCE_BYTES:
            raise ValueError("参考视频为空或超过 1 GB，无法上传。")
        try:
            with av.open(str(path)) as container:
                stream = next(iter(container.streams.video), None)
                if stream is None or not stream.width or not stream.height:
                    raise ValueError()
                duration = float(container.duration) / av.time_base if container.duration is not None else float(stream.duration * stream.time_base) if stream.duration is not None and stream.time_base else 0
                formats = set(container.format.name.split(","))
                mime = next((mime for names, mime in (({"mp4", "mov"}, "video/mp4"), ({"webm", "matroska"}, "video/x-matroska"), ({"avi"}, "video/x-msvideo"), ({"mpeg"}, "video/mpeg"), ({"mpegts"}, "video/mp2t")) if formats & names), None)
                if not mime or not math.isfinite(duration) or duration <= 0:
                    raise ValueError()
                items.append({"path": path, "size": path.stat().st_size, "duration": duration,
                              "width": stream.width, "height": stream.height, "content_type": mime})
        except (av.FFmpegError, ValueError, OSError):
            raise ValueError("参考视频损坏、格式不支持或无法读取时长，请先转换为 MP4。") from None
        if isinstance(source, io.BytesIO):
            suffix = {"video/mp4":".mp4","video/x-matroska":".mkv","video/x-msvideo":".avi","video/mpeg":".mpeg","video/mp2t":".ts"}[mime]
            if path.suffix != suffix:
                items[-1]["path"] = path.rename(path.with_suffix(suffix))
    return items
