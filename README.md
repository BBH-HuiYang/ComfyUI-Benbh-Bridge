# ComfyUI-Benbh-Bridge

在 ComfyUI 中使用 Benbh 平台的图片、视频生成服务，并查询账号可用积分。模型、线路和生成参数会根据平台配置自动加载。

**在线体验：[Benbh 官网 · benbh.cn](https://benbh.cn/)**

## 安装

1. 下载本插件，将 `ComfyUI-Benbh-Bridge` 文件夹放入 ComfyUI 的 `custom_nodes` 目录。
2. 打开插件文件夹中的 `config.json`，填写自己的 API Key：

   ```json
   {
     "base_url": "https://bbh-ai-server.benbh.cn",
     "api_key": "你的 API Key"
   }
   ```

3. 重启 ComfyUI，刷新页面。在 **Benbh Bridge** 分类中找到插件节点。

插件依赖通常已包含在标准 ComfyUI 环境中。若提示缺少依赖，请使用运行 ComfyUI 的 Python 安装插件目录内的 `requirements.txt`。

## 使用

### 图片生成

1. 添加 **BBH AIGC 图片生成** 节点。
2. 选择模型和线路，填写提示词，调整比例、尺寸等参数。
3. 将图片输出连接到 **预览图像（Preview Image）** 或 **保存图像（Save Image）**，点击运行。

需要参考图时，将 **加载图像（Load Image）** 的输出连接到参考图片输入口。接入后会自动增加下一个输入口，可用数量取决于所选模型。不接参考图时使用文字生成，模型须支持该方式。

### 视频生成

1. 添加 **BBH AIGC 视频生成** 节点。
2. 选择模型和线路，填写提示词，调整分辨率、时长等参数。
3. 将视频输出连接到 **保存视频（Save Video）**，点击运行。

支持参考素材的模型可连接以下节点，具体类型和数量以所选模型为准：

- 参考图片：**加载图像（Load Image）** 的 `IMAGE` 输出。
- 参考视频：**加载视频（Load Video）** 的原生 `VIDEO` 输出。
- 参考音频：**加载音频（Load Audio）** 的 `AUDIO` 输出。

视频功能需要使用支持原生 `VIDEO` 类型的 ComfyUI 版本。

### 查询积分

添加 **BBH AIGC 查询积分** 节点，无需接线，点击运行即可显示当前 API Key 所属账号的可用积分和查询时间。查询免费；若需查看生成后的余额，请在生成完成后单独运行查询。

## 示例工作流

将示例 JSON 拖入 ComfyUI，选择模型并填写提示词即可使用。参考图示例需先选择本地图片。

- [文字生成图片](example_workflows/image_generate.json)
- [参考图片生成](example_workflows/image_reference.json)
- [视频生成](example_workflows/video_generate.json)

## 注意事项

- 生成需要有效的 API Key 和足够积分。节点显示预计消耗，实际扣费以平台结算为准。
- 每次运行都会提交新任务；在 ComfyUI 中停止运行，不会取消平台已提交的任务。
- API Key 不会写入工作流。发布或分享插件时，请勿包含填写了密钥的 `config.json`。
