"""Read-only account balance query using the configured API key."""
from datetime import datetime, timezone

from server import PromptServer

from .client import BridgeError, PlatformClient
from .config import load_config


class BenbhPointsQuery:
    CATEGORY = "Benbh Bridge"
    FUNCTION = "query"
    RETURN_TYPES = ()
    OUTPUT_NODE = True
    DESCRIPTION = "查询当前 API Key 所属账号的可用总积分、充值积分和赠送积分。点击运行时查询，不消耗积分；显示的是查询时的余额快照。"

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {}, "hidden": {"unique_id": "UNIQUE_ID"}}

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        return float("nan")

    async def query(self, unique_id=None):
        def report(message):
            server = getattr(PromptServer, "instance", None)
            if server is not None:
                server.send_sync("benbh-bridge-points-status", {"node_id": str(unique_id), "message": message})

        report("正在查询积分…")
        try:
            balances = await PlatformClient(load_config()).points()
        except (BridgeError, ValueError) as exc:
            report(f"查询失败：{exc}")
            raise BridgeError(str(exc)) from None
        queried_at = datetime.now(timezone.utc).isoformat()
        return {"ui": {"balances": [balances], "queried_at": [queried_at]},
                "result": ()}
